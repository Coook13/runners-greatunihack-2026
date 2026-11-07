// Black box: the screen in every vehicle. It tells the crew what to do next and nothing more.
// The crew never needs to know or record what is inside a crate or who it is for (PLAN section 1).
// Pure helpers first (tested in tests/storyui.test.ts), then the DOM view.
import { CAPACITY, CELL_SIZE, SIZE_UNITS, SPEED } from '../contracts/config';
import type { BreachDump, CarrierKind, CellId, Label, NodeId, NodeKind, Vec2 } from '../contracts/types';
import geo from '../geo/hawassa.json';
import { exposure } from '../privacy/breach';
import { h, icon, injectStoryStyles, kindIcon, URGENCY_COLOR, URGENCY_NAME } from './storyStyles';

// ---------- real place names (OpenStreetMap, Hawassa) ----------
export interface Place { name: string; kind: string; pos: Vec2 }

type RawPlace = { name?: string; kind?: string; pos?: number[] };
export const PLACES: Place[] = [];
for (const p of (geo as unknown as { places?: RawPlace[] }).places ?? []) {
  if (p.name && Array.isArray(p.pos) && p.pos.length >= 2) PLACES.push({ name: p.name, kind: p.kind ?? 'village', pos: { x: p.pos[0], y: p.pos[1] } });
}

const NEAR_M = 3000;            // a place further than this from a point is not "its" name
const HUB_NEAR_M = 600;         // meeting points sit 100-300 m from a hub (MEET_OFFSET), so this means "at the hub"
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

export function placeNear(p: Vec2, maxM = NEAR_M, places: Place[] = PLACES): Place | null {
  let best: Place | null = null;
  let bd = maxM;
  for (const q of places) {
    const d = dist(p, q.pos);
    if (d <= bd) { best = q; bd = d; }
  }
  return best;
}

export function cellCentre(c: CellId): Vec2 | null {
  const m = /^C(\d+)-(\d+)$/.exec(c);
  return m ? { x: (Number(m[1]) + 0.5) * CELL_SIZE, y: (Number(m[2]) + 0.5) * CELL_SIZE } : null;
}

/** How the screens name things. Override any part from main.ts if the world has exact clinic names. */
export interface Namer {
  near(p: Vec2): string | null;   // nearest village or town
  cell(c: CellId): string | null; // place name for a 2 km cell
  clinic(c: CellId): string;      // the clinic serving a cell, the way a crew would say it
  node(id: NodeId): string;       // another node, as shown on screen
}

export function makeNamer(over: Partial<Namer> = {}, places: Place[] = PLACES): Namer {
  const near = (p: Vec2) => placeNear(p, NEAR_M, places)?.name ?? null;
  const cell = (c: CellId) => { const p = cellCentre(c); return p ? near(p) : null; };
  const clinic = (c: CellId) => {
    const p = cellCentre(c);
    const q = p ? placeNear(p, NEAR_M, places) : null;
    if (!q) return `the clinic in ${c}`;
    return q.kind === 'city' ? `${q.name} health centre` : `${q.name} health post`;
  };
  return { near, cell, clinic, node: (id) => id, ...over };
}
export const defaultNamer = makeNamer();

const PREFIX: [string, NodeKind][] = [
  ['drone', 'drone'], ['moto', 'motorbike'], ['van', 'van'], ['boat', 'boat'], ['store', 'store'], ['clinic', 'clinic'], ['dispatch', 'dispatch'],
];
export const kindOf = (id: NodeId): NodeKind | null => PREFIX.find(([p]) => id.startsWith(p))?.[1] ?? null;
export const KIND_NAME: Record<NodeKind, string> = {
  drone: 'Drone', motorbike: 'Motorbike', van: 'Van', boat: 'Boat', store: 'Store', clinic: 'Clinic', dispatch: 'Dispatch server',
};
const isCarrier = (k: NodeKind): k is CarrierKind => k in SPEED;

// ---------- reading the decision log (WP2 carrier lines, WP7 central lines) ----------
export interface Deal { packageId: string; partner: NodeId; role: 'give' | 'take'; accepted: boolean; t: number; meetM?: number }
export interface LogFacts {
  deals: Map<string, Deal>;            // open hand-offs by box
  calling: Map<string, CellId>;        // boxes waiting for a clinic's signed reply
  replied: Map<string, NodeId>;        // boxes whose clinic has replied: hand over now
  order: { packageId: string; store: NodeId | null; clinic: NodeId; stage: 'collect' | 'deliver' } | null;  // central mode
  holding: boolean;
  loading: boolean;
  selfDrive: boolean;
  mule: number;                        // sealed requests being carried toward the stores
}

type Rule = [RegExp, (m: RegExpExecArray, f: LogFacts, t: number) => void];
const closeBox = (f: LogFacts, pkg: string) => { f.deals.delete(pkg); f.calling.delete(pkg); f.replied.delete(pkg); };

const RULES: Rule[] = [
  [/^Offering box ([\w-]+) to ([\w-]+)/, (m, f, t) => { f.deals.set(m[1], { packageId: m[1], partner: m[2], role: 'give', accepted: false, t }); }],
  [/^([\w-]+) accepted box ([\w-]+)/, (m, f, t) => { f.deals.set(m[2], { packageId: m[2], partner: m[1], role: 'give', accepted: true, t }); }],
  [/^Taking box ([\w-]+) from ([\w-]+): meeting (\d+) m/, (m, f, t) => {
    f.deals.set(m[1], { packageId: m[1], partner: m[2], role: 'take', accepted: true, t, meetM: Number(m[3]) });
  }],
  [/^Handed box ([\w-]+) to /, (m, f) => closeBox(f, m[1])],
  [/^Got box ([\w-]+) from /, (m, f) => { f.deals.delete(m[1]); f.loading = false; }],
  [/^In (C\d+-\d+) with box ([\w-]+): calling/, (m, f) => { f.calling.set(m[2], m[1]); }],
  [/^([\w-]+) sent a valid signed reply for box ([\w-]+)/, (m, f) => { f.replied.set(m[2], m[1]); }],
  [/^Delivered box ([\w-]+) to /, (m, f) => closeBox(f, m[1])],
  [/^Hand-off of box ([\w-]+) with [\w-]+ did not happen/, (m, f) => { f.deals.delete(m[1]); }],
  [/^No answer from [\w-]+ about box ([\w-]+)/, (m, f) => { f.deals.delete(m[1]); }],
  [/is loading \d+ box\(es\) onto me/, (_m, f) => { f.loading = true; }],
  [/driving my boxes on myself/, (_m, f) => { f.selfDrive = true; }],
  [/^Carrying requests? (.+?) toward the stores/, (m, f) => { f.mule = m[1].split(',').length; }],
  // central dispatch mode (src/baseline/central.ts)
  [/^New order: collect ([\w-]+) at ([\w-]+) for ([\w-]+)/, (m, f) => { f.order = { packageId: m[1], store: m[2], clinic: m[3], stage: 'collect' }; f.holding = false; }],
  [/^Collected ([\w-]+); driving direct to ([\w-]+)/, (m, f) => { f.order = { packageId: m[1], store: null, clinic: m[2], stage: 'deliver' }; f.holding = false; }],
  [/^Delivered [\w-]+ to [\w-]+; order done/, (_m, f) => { f.order = null; }],
  [/^Network down: holding position/, (_m, f) => { f.holding = true; }],
];

const STAMP = /^\[(\d+(?:\.\d+)?)s\]\s*/;   // the engine prefixes every line with "[123s] "

export function readLogs(logs: string[]): LogFacts {
  const f: LogFacts = { deals: new Map(), calling: new Map(), replied: new Map(), order: null, holding: false, loading: false, selfDrive: false, mule: 0 };
  for (const raw of logs) {
    const s = STAMP.exec(raw);
    const t = s ? Number(s[1]) : NaN;
    const line = s ? raw.slice(s[0].length) : raw;
    for (const [re, fn] of RULES) {
      const m = re.exec(line);
      if (m) { fn(m, f, t); break; }
    }
  }
  return f;
}

// ---------- what the screen says ----------
export interface BlackBoxInfo {
  id: NodeId;
  kind: NodeKind;
  dump: BreachDump;
  logs: string[];
  instructions?: string[];   // if given, [0] is the NEXT line and the rest are steps
  pos?: Vec2;                // optional: device position from the snapshot, for "in N min"
  t?: number;                // optional: sim time now
}
export interface Crate { n: number; label: Label; to: string; place: string | null }
export interface DevicePlan { next: string; steps: string[]; crates: Crate[]; sealed: boolean }

// Display-only estimate for "in N min": roads wind, drones fly straight. The agent's real ETAs come from map.eta.
const ROAD_FACTOR: Record<CarrierKind, number> = { drone: 1, motorbike: 1.3, van: 1.3, boat: 1.2 };

function meetingPoint(d: BreachDump, names: Namer): { name: string; pos: Vec2 | null } {
  const hs = d.knownLocations.filter((l) => l.what === 'handoff');
  if (hs.length !== 1) return { name: 'the agreed meeting point', pos: null };
  const p = hs[0].pos;
  const place = names.near(p);
  if (!place) return { name: 'the agreed meeting point', pos: p };
  const atHub = d.knownLocations.some((l) => l.what === 'hub' && dist(l.pos, p) <= HUB_NEAR_M);
  return { name: atHub ? `${place} junction` : `the meeting point near ${place}`, pos: p };
}

function etaText(info: BlackBoxInfo, meetPos: Vec2 | null, deal: Deal): string {
  if (!isCarrier(info.kind)) return '';
  const k = info.kind;
  let sec: number | null = null;
  if (info.pos && meetPos) sec = (dist(info.pos, meetPos) * ROAD_FACTOR[k]) / SPEED[k];
  else if (deal.meetM !== undefined) {
    sec = (deal.meetM * ROAD_FACTOR[k]) / SPEED[k];
    if (info.t !== undefined && Number.isFinite(deal.t)) sec -= info.t - deal.t;
  }
  if (sec === null) return '';
  return sec < 45 ? ' now' : ` in ${Math.max(1, Math.round(sec / 60))} min`;
}

const mostUrgent = (cs: Crate[]): Crate | undefined =>
  [...cs].sort((a, b) => b.label.urgency - a.label.urgency || a.label.deadline - b.label.deadline || a.n - b.n)[0];

function hubName(info: BlackBoxInfo, names: Namer): string {
  const hubs = info.dump.knownLocations.filter((l) => l.what === 'hub');
  if (!hubs.length || !info.pos) return 'the relay hub';
  const p = info.pos;
  const hub = hubs.reduce((a, b) => (dist(a.pos, p) <= dist(b.pos, p) ? a : b));
  const place = names.near(hub.pos);
  return place ? `${place} junction` : 'the relay hub';
}

function headline(info: BlackBoxInfo, f: LogFacts, crates: Crate[], names: Namer): string {
  const d = info.dump;
  if (info.kind === 'clinic') return 'Answer couriers with a signed reply, then open and check each crate';
  if (info.kind === 'store') return 'Pack and seal crates for open requests; load vans most urgent first';
  if (info.kind === 'dispatch') return 'Assign every carrier from the full picture';

  const held = (pkg: string) => crates.find((c) => c.label.packageId === pkg);
  const meet = meetingPoint(d, names);

  for (const pkg of f.replied.keys()) {
    const c = held(pkg);
    if (c) return `Hand crate ${c.n} to the staff at ${c.to}`;
  }
  const deals = [...f.deals.values()].filter((x) => (x.role === 'take' ? !held(x.packageId) : !!held(x.packageId)));
  const give = deals.find((x) => x.role === 'give' && x.accepted);
  if (give) return `Meet ${names.node(give.partner)} at ${meet.name}${etaText(info, meet.pos, give)}, hand over crate ${held(give.packageId)!.n}`;
  const take = deals.find((x) => x.role === 'take');
  if (take) return `Meet ${names.node(take.partner)} at ${meet.name}${etaText(info, meet.pos, take)}, collect a sealed crate`;
  for (const pkg of f.calling.keys()) {
    const c = held(pkg);
    if (c) return `Wait at ${c.to} for the clinic's signed reply, then hand over crate ${c.n}`;
  }
  if (f.order) {
    const c = held(f.order.packageId);
    if (f.order.stage === 'deliver') return c ? `Drive direct to ${c.to} with crate ${c.n}` : `Drive direct to ${names.node(f.order.clinic)}`;
    return `Drive to ${names.node(f.order.store ?? 'the store')} and collect the crate for ${names.node(f.order.clinic)}`;
  }
  if (f.holding) return 'Hold position. Dispatch is out of reach while the network is down';
  const offer = deals.find((x) => x.role === 'give');
  if (offer) return `Keep moving. Crate ${held(offer.packageId)!.n} offered to ${names.node(offer.partner)}, waiting for an answer`;
  if (f.loading) return 'Wait while the store loads sealed crates';

  // Nothing useful in the recent log: fall back to what the device holds.
  const first = mostUrgent(crates);
  if (first && d.nextHop) {
    return kindOf(d.nextHop) === 'clinic' ? `Deliver crate ${first.n} to ${first.to}` : `Hand crate ${first.n} to ${names.node(d.nextHop)}`;
  }
  if (first) return info.kind === 'van' && !f.selfDrive ? `Take the crates to ${hubName(info, names)}` : `Take crate ${first.n} to ${first.to}`;
  switch (info.kind) {
    case 'van': return 'Collect sealed crates at the store';
    case 'drone': return 'Park at the hub and wait for a crate';
    case 'boat': return 'Run your loop on the lake and listen for hand-offs';
    default: return 'Ride your loop and listen for hand-offs';
  }
}

function crateStep(c: Crate, f: LogFacts, info: BlackBoxInfo, sealed: boolean, names: Namer): string {
  const pkg = c.label.packageId;
  const tail = sealed ? ' Contents: sealed.' : ' Contents: listed on this device.';
  const deal = f.deals.get(pkg);
  if (f.replied.has(pkg)) return `Crate ${c.n}: hand to the staff at ${c.to} now. Their signed reply checked out.`;
  if (deal?.role === 'give' && deal.accepted) return `Crate ${c.n}: hand over to ${names.node(deal.partner)} at ${meetingPoint(info.dump, names).name}.${tail}`;
  if (deal?.role === 'give') return `Crate ${c.n}: offered to ${names.node(deal.partner)}, waiting for an answer.${tail}`;
  if (f.calling.has(pkg)) return `Crate ${c.n}: at ${c.to}, waiting for the clinic's signed reply.${tail}`;
  const verb = info.kind === 'van' && !f.selfDrive && !f.order ? 'bound for' : 'deliver to';
  return `Crate ${c.n}: ${verb} ${c.to}.${tail}`;
}

/** Everything the device screen shows, from the breach dump and the recent decision log. */
export function derivePlan(info: BlackBoxInfo, names: Namer = defaultNamer): DevicePlan {
  const d = info.dump;
  const sealed = d.readableBeneficiaryNotes.length === 0 && d.knownStockLevels === 0;
  const crates: Crate[] = d.readableLabels.map((label, i) => ({ n: i + 1, label, to: names.clinic(label.destCell), place: names.cell(label.destCell) }));
  if (info.instructions?.length) {
    const [first, ...rest] = info.instructions;
    return { next: first.replace(/^NEXT:\s*/i, ''), steps: rest, crates, sealed };
  }
  const f = readLogs(info.logs);
  const steps = isCarrier(info.kind) ? crates.map((c) => crateStep(c, f, info, sealed, names)) : [];
  if (f.mule > 0) steps.push(`Carrying ${f.mule} sealed request${f.mule > 1 ? 's' : ''} toward the stores. Nobody on board can read ${f.mule > 1 ? 'them' : 'it'}.`);
  return { next: headline(info, f, crates, names), steps, crates, sealed };
}

// ---------- "If this device is stolen, the thief gets:" ----------
export interface TheftYield { nextStops: number; labels: number; meetPoints: number; stores: number; stock: number; notes: number; score: number }

export function theftYield(d: BreachDump): TheftYield {
  const e = exposure(d);
  return {
    nextStops: d.nextHop ? 1 : 0,
    labels: d.readableLabels.length,
    meetPoints: d.knownLocations.filter((l) => l.what === 'handoff').length,
    stores: e.storeLocations,
    stock: e.stockLevels,
    notes: e.beneficiaryNotes,
    score: e.score,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Chips for the theft line. The three secrets (stores, stock, children) are 'zero' when safe, 'hot' when leaked. */
export function theftItems(y: TheftYield): { text: string; tone: 'plain' | 'zero' | 'hot' }[] {
  const secret = (n: number) => (n > 0 ? 'hot' as const : 'zero' as const);
  return [
    { text: plural(y.nextStops, 'next stop'), tone: 'plain' },
    { text: `${plural(y.labels, 'crate label')} (2 km cell only)`, tone: 'plain' },
    { text: plural(y.stores, 'store location'), tone: secret(y.stores) },
    { text: plural(y.stock, 'stock level'), tone: secret(y.stock) },
    { text: plural(y.notes, 'note on children', 'notes on children'), tone: secret(y.notes) },
  ];
}

// ---------- the DOM view ----------
export interface BlackBoxView { root: HTMLElement; show(info: BlackBoxInfo | null): void }

export function createBlackBoxView(
  root: HTMLElement,
  opts: { names?: Partial<Namer>; inline?: boolean; onClose?: () => void } = {},
): BlackBoxView {
  injectStoryStyles();
  const names = makeNamer(opts.names);
  const dev = h('section', `sb sb-bb sb-hidden${opts.inline ? ' sb-inline' : ''}`);
  dev.setAttribute('aria-label', 'Black box: in-vehicle device');
  root.append(dev);
  let lastKey = '';
  let dismissed: NodeId | null = null;   // closed by hand: stay closed until another node is picked

  function render(info: BlackBoxInfo, plan: DevicePlan, y: TheftYield): HTMLElement {
    const bezel = h('div', 'sb-bb-bezel');
    for (const c of ['tl', 'tr', 'bl', 'br']) bezel.append(h('i', `sb-bump sb-${c}`));

    const status = h('div', 'sb-bb-status');
    const close = h('button', '', 'Close');
    close.addEventListener('click', () => { dismissed = info.id; dev.classList.add('sb-hidden'); opts.onClose?.(); });
    status.append(icon(kindIcon(info.kind), 18), h('span', 'sb-bb-brand', 'Black box'), h('span', 'sb-bb-id', info.id),
      h('span', '', KIND_NAME[info.kind]), h('span', 'sb-space'), close);

    const screen = h('div', 'sb-bb-screen');
    screen.append(h('div', 'sb-bb-nextk', 'NEXT'), h('div', 'sb-bb-next', plan.next));
    if (plan.steps.length) {
      const ul = h('ul', 'sb-bb-steps');
      for (const s of plan.steps) ul.append(h('li', '', s));
      screen.append(ul);
    }

    if (isCarrier(info.kind)) {
      if (plan.crates.length) {
        const grid = h('div', 'sb-crates');
        for (const c of plan.crates) grid.append(crateCard(c, plan.sealed));
        screen.append(grid);
      }
      const used = plan.crates.reduce((s, c) => s + SIZE_UNITS[c.label.size], 0);
      const cap = CAPACITY[info.kind];
      const load = h('div', 'sb-load', `Load: ${used} of ${cap} units`);
      const bar = h('div', 'sb-load-bar');
      const fill = h('i');
      fill.style.width = `${Math.min(100, (100 * used) / cap)}%`;
      bar.append(fill);
      load.append(bar);
      screen.append(load);

      const lock = h('div', `sb-lock${plan.sealed ? '' : ' sb-bad'}`);
      lock.append(icon(plan.sealed ? 'lock' : 'unlock', 22),
        h('span', '', plan.sealed ? 'Contents sealed: this device cannot open them' : 'Full manifest on board: this device can read every crate'));
      screen.append(lock);
    } else {
      screen.append(h('div', 'sb-station', `${KIND_NAME[info.kind]} device, fixed in place.`));
    }

    const foot = h('div', 'sb-bb-foot');
    foot.append(h('div', '', 'If this device is stolen, the thief gets:'));
    const chips = h('div');
    for (const it of theftItems(y)) chips.append(h('span', `sb-chip${it.tone === 'plain' ? '' : ` sb-${it.tone}`}`, it.text));
    foot.append(chips);
    if (plan.sealed && isCarrier(info.kind)) foot.append(h('div', 'sb-crew', 'The crew never sees or records what is inside or who it is for.'));

    bezel.append(status, screen, foot);
    return bezel;
  }

  function crateCard(c: Crate, sealed: boolean): HTMLElement {
    const u = c.label.urgency;
    const card = h('div', 'sb-crate');
    card.style.setProperty('--u', URGENCY_COLOR[u]);
    const top = h('div', 'sb-crate-top');
    top.append(h('b', '', `Crate ${c.n}`), h('span', 'sb-tag', `Size ${c.label.size}`));
    if (c.label.cold) top.append(h('span', 'sb-tag', 'Cold'));
    const lock = h('div', `sb-crate-lock${sealed ? '' : ' sb-open'}`);
    lock.append(icon(sealed ? 'lock' : 'unlock', 14), h('span', '', sealed ? 'Sealed' : 'Readable here'));
    card.append(top, h('div', 'sb-crate-u', `Urgency ${u}: ${URGENCY_NAME[u]}`),
      h('div', 'sb-crate-dest', `To ${c.label.destCell}${c.place ? ` · ${c.place}` : ''}`), lock);
    return card;
  }

  return {
    root: dev,
    show(info) {
      if (!info) { dev.classList.add('sb-hidden'); lastKey = ''; dismissed = null; return; }
      if (dismissed === info.id) return;
      dismissed = null;
      const plan = derivePlan(info, names);
      const y = theftYield(info.dump);
      dev.classList.remove('sb-hidden');
      const key = JSON.stringify([info.id, info.kind, plan, y]);
      if (key === lastKey) return;   // called every snapshot: only redraw when something changed
      lastKey = key;
      dev.replaceChildren(render(info, plan, y));
    },
  };
}
