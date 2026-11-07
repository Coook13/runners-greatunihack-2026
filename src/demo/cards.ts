// Three small display cards the demo director owns. Each shows live numbers only.
//   clipboard:  what today's paperwork on one van gives away (from the central run's breach dump)
//   chain:      glass box fallback, one crate's chain of custody with the weight at each hand-off
//   scoreboard: today vs Runners, side by side, at the close
// Display only (no clicks), so they never get in the way of the UI underneath.
import type { BreachDump, Receipt } from '../contracts/types';
import { exposure } from '../privacy/breach';

const STYLE_ID = 'rn-demo-card-style';
const CSS = `
.rn-demo-card { position: fixed; z-index: 900; pointer-events: none; color: #e6ebe8;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: rgba(12, 17, 15, 0.9); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px;
  padding: 16px 20px; box-shadow: 0 12px 40px rgba(0,0,0,0.45);
  opacity: 0; transform: translateY(6px); transition: opacity 300ms ease, transform 300ms ease; }
.rn-demo-card.rn-on { opacity: 1; transform: translateY(0); }
.rn-demo-card h2 { margin: 0 0 10px; font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; }
.rn-demo-card .rn-today { color: #d4a05e; }
.rn-demo-card .rn-runners { color: #7fc2a6; }
.rn-demo-row { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0;
  border-top: 1px solid rgba(255,255,255,0.07); font-size: 17px; }
.rn-demo-row b { font-variant-numeric: tabular-nums; font-size: 20px; }
.rn-demo-row.rn-hot b { color: #ef8f7a; }
.rn-demo-note { font-size: 14px; color: #b7c2bc; font-style: italic; padding-top: 6px; }
.rn-demo-clip { left: 364px; top: 96px; width: 420px; }
.rn-demo-chain { right: 404px; top: 96px; width: 470px; }
.rn-demo-chain ol { margin: 0; padding-left: 22px; font-size: 15px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.rn-demo-chain li.rn-hot { color: #ef8f7a; font-weight: 700; }
.rn-demo-score { left: 50%; top: 14%; width: min(860px, 92vw); transform: translate(-50%, 6px); }
.rn-demo-score.rn-on { transform: translate(-50%, 0); }
.rn-demo-score table { width: 100%; border-collapse: collapse; font-size: 20px; }
.rn-demo-score th { text-align: right; font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 8px; }
.rn-demo-score th:first-child, .rn-demo-score td:first-child { text-align: left; }
.rn-demo-score td { padding: 9px 8px; border-top: 1px solid rgba(255,255,255,0.08); text-align: right; }
.rn-demo-score td.rn-num { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(label: string, value: string | number, hot = false): HTMLElement {
  const r = el('div', `rn-demo-row${hot ? ' rn-hot' : ''}`);
  r.append(el('span', '', label), el('b', '', String(value)));
  return r;
}

export interface DemoCard<T> { show(data: T): void; hide(): void; dispose(): void }

function makeCard<T>(cls: string, fill: (root: HTMLElement, data: T) => void): DemoCard<T> {
  injectStyles();
  const root = el('section', `rn-demo-card ${cls}`);
  document.body.append(root);
  return {
    show(data) { root.innerHTML = ''; fill(root, data); root.classList.add('rn-on'); },
    hide() { root.classList.remove('rn-on'); },
    dispose() { root.remove(); },
  };
}

// ---------- today: the van's paperwork ----------
export interface ClipboardData { vehicle: string; dump: BreachDump; alertsNamingHolder: number | null }

export const createClipboardCard = () => makeCard<ClipboardData>('rn-demo-clip', (root, d) => {
  const x = exposure(d.dump);
  root.append(el('h2', 'rn-today', `Today: paperwork on ${d.vehicle}`));
  root.append(row('Crates listed with their destination', d.dump.readableLabels.length));
  root.append(row('Store locations, exact', x.storeLocations, x.storeLocations > 0));
  root.append(row('Store stock levels', x.stockLevels, x.stockLevels > 0));
  root.append(row('Clinic notes on children', x.beneficiaryNotes, x.beneficiaryNotes > 0));
  if (d.dump.readableBeneficiaryNotes[0]) root.append(el('div', 'rn-demo-note', `"${d.dump.readableBeneficiaryNotes[0]}"`));
  if (d.alertsNamingHolder !== null) root.append(row('Alerts naming who took food', d.alertsNamingHolder));
});

// ---------- glass box fallback: one crate's chain of custody ----------
export interface ChainData { packageId: string; receipts: Receipt[]; lossAt?: number }

/** Receipts for one crate in custody order, with the index of the first weight drop (or -1). */
export function custodyChain(receipts: Receipt[], packageId: string): { chain: Receipt[]; dropAt: number } {
  const chain = receipts.filter((r) => r.packageId === packageId).sort((a, b) => a.seq - b.seq || a.t - b.t);
  const dropAt = chain.findIndex((r, i) => i > 0 && chain[i - 1].measuredKg - r.measuredKg > 0.05);
  return { chain, dropAt };
}

export const createChainCard = () => makeCard<ChainData>('rn-demo-chain', (root, d) => {
  const { chain, dropAt } = custodyChain(d.receipts, d.packageId);
  root.append(el('h2', 'rn-runners', `Glass box: crate ${d.packageId}`));
  const ol = el('ol');
  chain.forEach((r, i) => {
    const kg = Math.round(r.measuredKg * 100) / 100;
    ol.append(el('li', i === dropAt ? 'rn-hot' : '', `${r.kind}: ${r.from} to ${r.to}, cell ${r.cell}, ${kg} kg`));
  });
  if (!chain.length) ol.append(el('li', '', 'No receipts yet'));
  root.append(ol);
  if (dropAt > 0) {
    const lost = Math.round((chain[dropAt - 1].measuredKg - chain[dropAt].measuredKg) * 10) / 10;
    root.append(el('div', 'rn-demo-note', `${lost} kg lost while ${chain[dropAt - 1].to} held it`));
  }
});

// ---------- close: today vs Runners ----------
export interface ScoreSide { delivered: number; reachPct: number; duringOutage: number | null; named: number; exposure: number | null }
export interface ScoreData { today: ScoreSide | null; runners: ScoreSide }

export const createScoreboard = () => makeCard<ScoreData>('rn-demo-score', (root, d) => {
  root.append(el('h2', '', 'Same requests, same events'));
  const t = el('table');
  const head = el('tr');
  head.append(el('th', ''), ...(d.today ? [el('th', 'rn-today', 'Today')] : []), el('th', 'rn-runners', 'Runners'));
  t.append(head);
  const line = (label: string, get: (s: ScoreSide) => string) => {
    const tr = el('tr');
    tr.append(el('td', '', label));
    if (d.today) tr.append(el('td', 'rn-num', get(d.today)));
    tr.append(el('td', 'rn-num', get(d.runners)));
    t.append(tr);
  };
  const n = (v: number | null) => (v === null ? '-' : String(Math.round(v)));
  line('Delivered intact', (s) => n(s.delivered));
  line('Requests reached, %', (s) => n(s.reachPct));
  line('Delivered while the network was down', (s) => n(s.duringOutage));
  line('Losses with the holder named', (s) => n(s.named));
  line('Exposure of one stolen device', (s) => n(s.exposure));
  root.append(t);
});
