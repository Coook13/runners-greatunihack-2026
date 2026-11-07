// Glass box: the auditor's view. With the auditor key it opens every manifest and shows each box's full
// chain of custody: who held it, where, the weight measured at every hand-off, and the hop where weight dropped.
// Pure helpers first (tested in tests/storyui.test.ts), then the DOM view.
import { CATALOGUE, WEIGHT_TOLERANCE_KG } from '../contracts/config';
import type { LeakFinding, LedgerReport, Manifest, NodeId, Receipt, SealedBox } from '../contracts/types';
import { chains } from '../ledger/leaks';
import { receiptKey, verifyReceipt } from '../ledger/receipts';
import { openAuditorCopy } from '../privacy/auditor';
import { verify } from '../privacy/core';
import { KIND_NAME, kindOf, makeNamer, type Namer } from './blackbox';
import { clock, findingKindLabel, findingLine, kg } from './format';
import { h, icon, injectStoryStyles, kindIcon } from './storyStyles';

const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ---------- pure helpers ----------

/**
 * Which hop in a chain each skim finding points at. Receipt i is "out of" the holder of receipt i-1,
 * so a weight drop at i means the loss happened while chain[i-1].to held the box.
 */
export function weightDrops(chain: Receipt[], findings: LeakFinding[]): Map<number, LeakFinding> {
  const out = new Map<number, LeakFinding>();
  if (!chain.length) return out;
  const pkg = chain[0].packageId;
  const dropped = (i: number) => i > 0 && chain[i - 1].measuredKg - chain[i].measuredKg > WEIGHT_TOLERANCE_KG;
  for (const f of findings) {
    if (f.kind !== 'skim' || f.packageId !== pkg) continue;
    const outOf = (i: number) => i > 0 && (chain[i - 1].to === f.holder || chain[i].from === f.holder);
    let i = chain.findIndex((r, j) => outOf(j) && r.t === f.t && r.cell === f.cell);   // ledger finding: the exact receipt
    if (i < 0) i = chain.findIndex((_, j) => outOf(j) && dropped(j));                  // live alert: first drop out of that holder
    if (i < 0) i = chain.findIndex((_, j) => outOf(j));                                // a receipt is missing: first hop out of the holder
    if (i >= 0 && !out.has(i)) out.set(i, f);
  }
  return out;
}

export interface CustodyRow { index: number; receipt: Receipt; deltaKg: number | null; tone: 'ok' | 'bad'; notes: string[] }
export interface Custody {
  packer: NodeId | null;
  rows: CustodyRow[];
  tail: { text: string; tone: 'ok' | 'bad' | 'dim' } | null;
}

/** The chain of custody as the timeline draws it, with every finding pinned to its hop. */
export function custody(chain: Receipt[], findings: LeakFinding[], packedBy?: NodeId): Custody {
  const pkg = chain[0]?.packageId;
  const mine = findings.filter((f) => f.packageId === pkg);
  const rows: CustodyRow[] = chain.map((r, i) => ({
    index: i, receipt: r, deltaKg: i ? round3(r.measuredKg - chain[i - 1].measuredKg) : null, tone: 'ok', notes: [],
  }));
  const mark = (row: CustodyRow | undefined, text: string) => { if (row) { row.tone = 'bad'; row.notes.push(text); } };
  const drops = weightDrops(chain, mine);
  for (const [i, f] of drops) mark(rows[i], `Weight dropped ${kg(f.kgLost)} while ${f.holder} held it. Named in the ledger.`);

  const delivered = rows.find((r) => r.receipt.kind === 'delivered');
  let tail: Custody['tail'] = null;
  for (const f of mine) {
    if (f.kind === 'packed-short') mark(rows[0], `Packed ${kg(f.kgLost)} short against the manifest. Packer ${f.holder} named.`);
    else if (f.kind === 'short-at-clinic') mark(delivered ?? rows[rows.length - 1], `Clinic found ${kg(f.kgLost)} short against the sealed manifest. Loss after ${f.holder}.`);
    else if (f.kind === 'coerced') mark(rows.find((r) => r.receipt.coerced) ?? rows.find((r) => r.receipt.from === f.holder), `Handed over under duress by ${f.holder}. Rider not blamed.`);
    else if (f.kind === 'stolen') tail = { text: `Box vanished after ${f.holder}, last seen in ${f.cell}.`, tone: 'bad' };
    else if (f.kind === 'skim' && ![...drops.values()].includes(f)) tail ??= { text: `Weight dropped ${kg(f.kgLost)} while ${f.holder} holds it. Not handed on yet.`, tone: 'bad' };
  }
  const last = chain[chain.length - 1];
  if (!tail && last) {
    tail = delivered
      ? { text: delivered.tone === 'bad' ? 'Delivered short.' : 'Delivered. The clinic checked it against the sealed manifest.', tone: delivered.tone === 'bad' ? 'bad' : 'ok' }
      : { text: `In transit with ${last.to}.`, tone: 'dim' };
  }
  return { packer: packedBy ?? (chain[0]?.kind === 'pickup' ? chain[0].from : null), rows, tail };
}

export function boxStatus(chain: Receipt[], findings: LeakFinding[]): { text: string; tone: 'ok' | 'bad' | 'dim' } {
  const pkg = chain[0]?.packageId;
  const kinds = new Set(findings.filter((f) => f.packageId === pkg).map((f) => f.kind));
  const delivered = chain.some((r) => r.kind === 'delivered');
  if (kinds.has('stolen')) return { text: 'Stolen, last holder named', tone: 'bad' };
  if (kinds.has('coerced')) return { text: 'Taken under duress', tone: 'bad' };
  if (kinds.has('skim')) return { text: delivered ? 'Skimmed, hop named' : 'Skimmed, still moving', tone: 'bad' };
  if (kinds.has('packed-short')) return { text: 'Packed short', tone: 'bad' };
  if (kinds.has('short-at-clinic')) return { text: 'Short at clinic', tone: 'bad' };
  if (delivered) return { text: 'Delivered intact', tone: 'ok' };
  return { text: chain.length ? 'In transit' : 'At the store', tone: 'dim' };
}

/** Boxes with findings first (oldest finding first), then the rest by first receipt. */
export function orderBoxes(ids: Iterable<string>, byBox: Map<string, Receipt[]>, findings: LeakFinding[]): string[] {
  const firstFinding = new Map<string, number>();
  for (const f of findings) firstFinding.set(f.packageId, Math.min(f.t, firstFinding.get(f.packageId) ?? Infinity));
  const firstT = (id: string) => byBox.get(id)?.[0]?.t ?? Infinity;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...new Set(ids)].sort((a, b) => {
    const fa = firstFinding.get(a);
    const fb = firstFinding.get(b);
    if ((fa === undefined) !== (fb === undefined)) return fa !== undefined ? -1 : 1;
    return ((fa ?? 0) - (fb ?? 0)) || (firstT(a) - firstT(b)) || cmp(a, b);
  });
}

export function manifestRows(m: Manifest): { rows: { code: string; name: string; qty: number; kg: number | null }[]; itemsKg: number } {
  const rows = m.items.map((it) => {
    const c = CATALOGUE[it.code];
    return { code: it.code, name: c?.name ?? 'Unknown item', qty: it.qty, kg: c ? round3(c.kg * it.qty) : null };
  });
  return { rows, itemsKg: round3(rows.reduce((s, r) => s + (r.kg ?? 0), 0)) };
}

// ---------- the DOM view ----------
export interface GlassBoxInput {
  report: LedgerReport;
  receipts: Receipt[];
  boxes?: { box: SealedBox }[];
  auditorSealPriv: CryptoKey;
  packageId?: string;
  signPubs?: Record<NodeId, string>;   // from engine.ledgerInput(); without it signatures show as "not checked"
}
export interface GlassBoxView {
  root: HTMLElement;
  open(input: GlassBoxInput): Promise<void>;
  focus(packageId: string): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

type Opened = { ok: true; m: Manifest } | { ok: false; why: string };

export function createGlassBoxView(root: HTMLElement, opts: { names?: Partial<Namer> } = {}): GlassBoxView {
  injectStoryStyles();
  const names = makeNamer(opts.names);
  const wrap = h('section', 'sb sb-gb sb-hidden');
  wrap.setAttribute('aria-label', 'Glass box: auditor view');

  const head = h('header', 'sb-gb-head');
  const title = h('div', 'sb-gb-title', 'Glass box: auditor view.');
  title.append(h('span', '', 'Requires the auditor key.'));
  const pill = h('span', 'sb-pill');
  const closeBtn = h('button', '', 'Close');
  closeBtn.addEventListener('click', () => close());
  head.append(icon('glass', 30, 'sb-gb-icon'), title, h('span', 'sb-space'), pill, closeBtn);
  const summary = h('div', 'sb-gb-summary');
  const list = h('nav', 'sb-gb-list');
  const detail = h('div', 'sb-gb-detail');
  const main = h('div', 'sb-gb-main');
  main.append(list, detail);
  wrap.append(head, summary, main);
  root.append(wrap);

  let input: GlassBoxInput | null = null;
  let byBox = new Map<string, Receipt[]>();
  let boxes = new Map<string, SealedBox>();
  let order: string[] = [];
  let selected = '';
  let token = 0;
  const manifests = new Map<string, Promise<Opened>>();
  const sigs = new Map<string, Promise<boolean | null>>();

  const setPill = (ok: boolean, text: string) => {
    pill.className = `sb-pill${ok ? '' : ' sb-bad'}`;
    pill.replaceChildren(icon('key', 15), h('span', '', text));
  };

  function openManifest(pkg: string): Promise<Opened> {
    let p = manifests.get(pkg);
    if (!p) {
      const box = boxes.get(pkg);
      const priv = input!.auditorSealPriv;
      p = !box ? Promise.resolve<Opened>({ ok: false, why: 'Sealed box not loaded into this view.' })
        : !box.auditorCopy ? Promise.resolve<Opened>({ ok: false, why: 'This box has no auditor copy.' })
        : openAuditorCopy(box, priv).then((m): Opened => ({ ok: true, m }), (): Opened => ({ ok: false, why: 'Could not open: wrong key, or the copy was altered.' }));
      manifests.set(pkg, p);
    }
    return p;
  }

  function sigOk(r: Receipt): Promise<boolean | null> {
    const pubs = input?.signPubs;
    if (!pubs) return Promise.resolve(null);
    const k = `${receiptKey(r)}|${r.sigTo}`;
    let p = sigs.get(k);
    if (!p) { p = verifyReceipt(r, pubs); sigs.set(k, p); }
    return p;
  }

  async function packOk(box: SealedBox | undefined): Promise<boolean | null> {
    const pub = box && input?.signPubs?.[box.packedBy];
    if (!box || !pub) return null;
    return verify({ label: box.label, sealed: box.sealed }, box.packSig, pub);
  }

  function renderSummary(): void {
    const r = input!.report;
    const tiles = h('div', 'sb-tiles');
    const tile = (n: number, label: string, bad = false) => {
      const t = h('div', `sb-tile${bad && n > 0 ? ' sb-bad' : ''}`);
      t.append(h('b', '', String(n)), h('span', '', label));
      tiles.append(t);
    };
    tile(r.boxes, 'boxes');
    tile(r.deliveredIntact, 'delivered intact');
    tile(r.skimmed, 'skimmed, hop named', true);
    tile(r.deliveredShort, 'delivered short', true);
    tile(r.stolen, 'stolen', true);
    tile(r.lostBreakdown, 'lost in breakdowns');
    tile(r.inTransit, 'in transit');
    tile(r.badSignatures, 'bad signatures', true);

    const findings = h('ul', 'sb-findings');
    if (!r.findings.length) findings.append(h('li', 'sb-empty', 'No findings: every box is accounted for.'));
    for (const f of r.findings) {
      const li = h('li');
      li.append(h('span', 'sb-ftag', findingKindLabel[f.kind]), document.createTextNode(findingLine(f)), h('span', 'sb-dim', `  ${clock(f.t)}`));
      li.addEventListener('click', () => void select(f.packageId));
      findings.append(li);
    }
    const right = h('div');
    right.append(h('h3', '', `Findings (${r.findings.length})`), findings);
    summary.replaceChildren(tiles, right);
  }

  function renderList(): void {
    list.replaceChildren();
    for (const id of order) {
      const st = boxStatus(byBox.get(id) ?? [], input!.report.findings);
      const b = h('button', id === selected ? 'sb-on' : '');
      const line = h('div', `sb-bst sb-${st.tone}`);
      line.append(h('i', 'sb-dot'), h('span', '', st.text));
      b.append(h('div', 'sb-bid', id), line);
      b.addEventListener('click', () => void select(id));
      list.append(b);
    }
  }

  async function select(pkg: string): Promise<void> {
    if (!input) return;
    selected = pkg;
    renderList();
    const my = ++token;
    detail.replaceChildren(h('div', 'sb-empty', 'Opening the manifest with the auditor key...'));
    const chain = byBox.get(pkg) ?? [];
    const box = boxes.get(pkg);
    const [opened, sigsOk, packed] = await Promise.all([openManifest(pkg), Promise.all(chain.map(sigOk)), packOk(box)]);
    if (my !== token) return;   // another box was picked while we were decrypting
    if (opened.ok) setPill(true, 'Auditor key loaded');
    else if (box?.auditorCopy) setPill(false, 'Auditor key rejected');
    detail.replaceChildren(manifestPane(pkg, chain, box, opened, packed), chainPane(chain, box, sigsOk, opened.ok ? opened.m : null));
  }

  function manifestPane(pkg: string, chain: Receipt[], box: SealedBox | undefined, opened: Opened, packed: boolean | null): HTMLElement {
    const pane = h('div');
    const h3 = h('h3');
    h3.append(icon(opened.ok ? 'unlock' : 'lock', 16), h('span', '', 'Manifest'));
    pane.append(h3);
    const label = box?.label;
    const kv = h('div', 'sb-kv');
    const row = (k: string, v: string | HTMLElement) => kv.append(h('span', 'sb-k', k), typeof v === 'string' ? h('span', '', v) : v);
    row('Box', h('span', 'sb-mono', pkg));
    const req = label ?? chain[0];
    if (req) row('Request', `${req.requestId} (attempt ${req.attempt})`);
    if (label) {
      row('For', `${names.clinic(label.destCell)} (${label.destCell})`);
      row('Label', `Urgency ${label.urgency}, size ${label.size}${label.cold ? ', cold' : ''}`);
    }
    pane.append(kv);

    if (!opened.ok) {
      pane.append(h('div', 'sb-empty', opened.why), h('div', 'sb-dim', 'The chain of custody still comes from the signed receipts.'));
      return pane;
    }
    const m = opened.m;
    const { rows, itemsKg } = manifestRows(m);
    const table = h('table', 'sb-items');
    const thead = h('tr');
    for (const t of ['Item', 'Qty', 'Weight']) thead.append(h('th', '', t));
    table.append(thead);
    for (const r of rows) {
      const tr = h('tr');
      tr.append(h('td', '', r.name), h('td', 'sb-n', `x${r.qty}`), h('td', 'sb-n', r.kg === null ? '-' : kg(r.kg)));
      table.append(tr);
    }
    pane.append(table);

    const kv2 = h('div', 'sb-kv');
    const row2 = (k: string, v: string | HTMLElement) => kv2.append(h('span', 'sb-k', k), typeof v === 'string' ? h('span', '', v) : v);
    row2('Declared weight', kg(m.declaredKg));
    if (Math.abs(itemsKg - m.declaredKg) > 0.001) row2('Items add up to', kg(itemsKg));
    if (chain.length) row2('First weigh-in', kg(chain[0].measuredKg));
    const end = chain.find((r) => r.kind === 'delivered');
    if (end) row2('At the clinic', kg(end.measuredKg));
    if (box) row2('Packed by', sigMark(packed, box.packedBy, 'packing signature'));
    pane.append(kv2);

    const note = h('div', 'sb-note', m.beneficiaryNote);
    note.append(h('small', '', 'Beneficiary note: counts only. Names never leave the clinic.'));
    pane.append(note);
    return pane;
  }

  function sigMark(ok: boolean | null, who: string, what = 'signature'): HTMLElement {
    const s = h('span', `sb-sig ${ok === true ? 'sb-ok' : ok === false ? 'sb-bad' : 'sb-unk'}`);
    if (ok === null) { s.append(h('span', '', `${who}, ${what} not checked`)); return s; }
    s.append(icon(ok ? 'check' : 'cross', 15), h('span', '', `${who}, ${what} ${ok ? 'valid' : 'INVALID'}`));
    return s;
  }

  function chainPane(chain: Receipt[], box: SealedBox | undefined, sigsOk: (boolean | null)[], m: Manifest | null): HTMLElement {
    const pane = h('div');
    const h3 = h('h3');
    h3.append(icon('scale', 16), h('span', '', 'Chain of custody'));
    pane.append(h3);
    const c = custody(chain, input!.report.findings, box?.packedBy);
    const ol = h('ol', 'sb-tl');

    if (c.packer) {
      const first = chain[0];
      const place = first ? names.cell(first.cell) : null;
      ol.append(stop(c.packer, 'Packed and sealed', `${first ? `${clock(first.t)} · ${first.cell}` : ''}${place ? ` · ${place}` : ''}`,
        m ? kg(m.declaredKg) : '', m ? 'declared' : '', false, [], null));
    }
    for (const r of c.rows) {
      const rc = r.receipt;
      const place = names.cell(rc.cell);
      const how = rc.kind === 'pickup' ? 'Picked up from' : rc.kind === 'delivered' ? 'Delivered by' : 'Handed over by';
      const delta = r.deltaKg === null ? 'weighed on receipt' : Math.abs(r.deltaKg) <= 0.0005 ? 'no change' : `${r.deltaKg > 0 ? '+' : ''}${kg(r.deltaKg)}`;
      ol.append(stop(rc.to, `${how} ${rc.from}`, `${clock(rc.t)} · ${rc.cell}${place ? ` · ${place}` : ''}`,
        kg(rc.measuredKg), delta, r.tone === 'bad', r.notes, sigsOk[r.index]));
    }
    if (!chain.length) ol.append(h('li', 'sb-empty', 'No receipts yet: the box has not left the store.'));
    pane.append(ol);
    if (c.tail) pane.append(h('div', `sb-tail sb-${c.tail.tone}`, c.tail.text));
    return pane;
  }

  function stop(who: NodeId, how: string, meta: string, kgText: string, delta: string, bad: boolean, notes: string[], sig: boolean | null | undefined): HTMLElement {
    const li = h('li', `sb-stop${bad ? ' sb-bad' : ''}`);
    const k = kindOf(who);
    const node = h('div', 'sb-node');
    node.append(icon(kindIcon(k), 20));
    const body = h('div', 'sb-stop-body');
    const whoEl = h('div', 'sb-stop-who', who);
    whoEl.append(h('small', '', k ? KIND_NAME[k] : ''));
    body.append(whoEl, h('div', 'sb-stop-meta', `${how} · ${meta}`));
    if (sig !== undefined) body.append(sigMark(sig, `Signed by ${who}`));
    for (const n of notes) body.append(h('div', 'sb-stop-note', n));
    const w = h('div', 'sb-stop-kg');
    w.append(h('b', '', kgText), h('span', '', delta));
    li.append(node, body, w);
    return li;
  }

  async function open(next: GlassBoxInput): Promise<void> {
    input = next;
    manifests.clear();
    sigs.clear();
    byBox = chains(next.receipts);
    boxes = new Map((next.boxes ?? []).map((b) => [b.box.label.packageId, b.box]));
    order = orderBoxes([...byBox.keys(), ...boxes.keys()], byBox, next.report.findings);
    setPill(true, 'Auditor key loaded');
    renderSummary();
    wrap.classList.remove('sb-hidden');
    const pick = next.packageId && order.includes(next.packageId) ? next.packageId : order[0];
    if (pick) await select(pick);
    else detail.replaceChildren(h('div', 'sb-empty', 'No boxes in the ledger yet.'));
  }

  function close(): void {
    token++;
    wrap.classList.add('sb-hidden');
  }

  return {
    root: wrap,
    open,
    focus: (pkg) => (input && order.includes(pkg) ? select(pkg) : Promise.resolve()),
    close,
    isOpen: () => !wrap.classList.contains('sb-hidden'),
  };
}

/** The button the lead drops on screen to open the glass box. */
export function createAuditorButton(root: HTMLElement, onClick: () => void): HTMLButtonElement {
  injectStoryStyles();
  const b = h('button', 'sb-auditor-btn');
  b.append(icon('key', 18), h('span', '', 'Auditor: open glass box'));
  b.addEventListener('click', onClick);
  root.append(b);
  return b;
}
