// Controls. Three pieces, placed by index.ts:
//   net     the NETWORK DOWN / UP pill (top right, always on screen: the key demo action)
//   switch  the page switch (top centre): "Simulation" = Runners on one map, "Compare with today" = split
//   root    the Tools section of the sidebar: judge tools, skim amount, map mode, and speed/reset/clock when no
//           playback bar is mounted (the lead's .pb owns those in the app)
// Every button calls a UiHandlers callback.
import type { Mode, Tool, UiHandlers } from '../contracts/types';
import { el } from './dom';
import { clampSpeed, clock, SPEED_MAX, SPEED_MIN } from './format';

export const TOOLS: { tool: Tool; label: string; title: string }[] = [
  { tool: 'select', label: 'Select', title: 'Click a node to inspect it' },
  { tool: 'deadZone', label: 'Dead zone', title: 'Click the map to kill local radio there' },
  { tool: 'breakdown', label: 'Breakdown', title: 'Click a carrier to break it down' },
  { tool: 'skim', label: 'Skim', title: 'Click a carrier to skim kg from a box it holds' },
  { tool: 'steal', label: 'Steal', title: 'Click a carrier to steal a box' },
  { tool: 'breach', label: 'Breach', title: 'Click a node to hack it and see what leaks' },
];

const MODES: { mode: Mode | 'split'; label: string }[] = [
  { mode: 'mesh', label: 'Runners' },
  { mode: 'central', label: 'Today' },
  { mode: 'split', label: 'Both' },
];

export interface Controls {
  root: HTMLElement;
  net: HTMLButtonElement;
  switcher: HTMLElement;
  sync(t: number, networkUp: boolean): void;
  skimKg(): number;
  setTool(t: Tool): void;
  setMode(m: Mode | 'split'): void;
  tool(): Tool;
  mode(): Mode | 'split';
  /** Called whenever the tool or mode changes, from a click or from the lead. */
  onChange(fn: () => void): void;
}

function initialSpeed(): number {
  // Mirror the speed the lead starts with (?speed=, default 20 in main.ts); the dev page starts at 1.
  if (typeof location === 'undefined') return 1;
  const q = new URLSearchParams(location.search);
  const s = Number(q.get('speed'));
  if (Number.isFinite(s) && s > 0) return clampSpeed(s);
  return q.get('dev') ? 1 : 20;
}

export function createControls(h: UiHandlers, initialSkimKg: number): Controls {
  const listeners: (() => void)[] = [];
  const changed = () => listeners.forEach((f) => f());

  // ---------- network pill: the label is the action it will take ----------
  let networkUp = true;
  let holdUntil = 0; // after a click, trust the pill until the engine's snapshot catches up
  const net = el('button', 'rn-net');
  const paintNet = () => {
    net.replaceChildren(el('span', 'rn-dot'), networkUp ? 'NETWORK DOWN' : 'NETWORK UP');
    net.classList.toggle('rn-down', !networkUp);
    net.dataset.tip = networkUp ? 'Cell network is online. Click to take it down.' : 'Cell network is offline. Click to bring it back.';
  };
  net.addEventListener('click', () => {
    networkUp = !networkUp; // optimistic; the next snapshots confirm it
    holdUntil = performance.now() + 1500;
    h.onEvent({ type: networkUp ? 'networkUp' : 'networkDown' });
    paintNet();
  });
  paintNet();

  // ---------- page switch ----------
  const switcher = el('div', 'rn-switch rn-glass');
  const pageSim = el('button', '', 'Simulation');
  const pageCmp = el('button', '', 'Compare with today');
  pageSim.title = 'Runners on one map';
  pageCmp.title = 'Today\'s central dispatch next to Runners, same seed, same incidents';
  pageSim.addEventListener('click', () => { setMode('mesh'); h.onMode('mesh'); });
  pageCmp.addEventListener('click', () => { setMode('split'); h.onMode('split'); });
  switcher.append(pageSim, pageCmp);

  // ---------- tools section ----------
  const root = el('div', 'rn-tools');
  root.append(el('div', 'rn-sub', 'Tool'));
  const tools = el('div', 'rn-row');
  const toolBtns = new Map<Tool, HTMLButtonElement>();
  let tool: Tool = 'select';
  for (const t of TOOLS) {
    const b = el('button', '', t.label);
    b.title = t.title;
    b.addEventListener('click', () => { setTool(t.tool); h.onTool(t.tool); });
    toolBtns.set(t.tool, b);
    tools.append(b);
  }
  // Skim amount, used by the lead when the skim tool hits a carrier.
  const skim = el('input', 'rn-num');
  skim.type = 'number'; skim.min = '0.1'; skim.step = '0.1'; skim.value = String(initialSkimKg);
  skim.title = 'kg to skim';
  tools.append(skim, el('span', 'rn-unit', 'kg'));
  root.append(tools);
  function setTool(next: Tool): void {
    tool = next;
    toolBtns.forEach((b, k) => b.classList.toggle('rn-on', k === next));
    changed();
  }
  setTool('select');

  root.append(el('div', 'rn-sub', 'Map'));
  const modes = el('div', 'rn-row');
  const modeBtns = new Map<Mode | 'split', HTMLButtonElement>();
  let mode: Mode | 'split' = 'mesh';
  for (const m of MODES) {
    const b = el('button', '', m.label);
    b.addEventListener('click', () => { setMode(m.mode); h.onMode(m.mode); });
    modeBtns.set(m.mode, b);
    modes.append(b);
  }
  root.append(modes);
  function setMode(next: Mode | 'split'): void {
    mode = next;
    modeBtns.forEach((b, k) => b.classList.toggle('rn-on', k === next));
    pageSim.classList.toggle('rn-on', next !== 'split');
    pageCmp.classList.toggle('rn-on', next === 'split');
    changed();
  }
  setMode('mesh');

  // Speed, reset and clock: only shown when the lead's playback bar is not mounted (index.ts hides them).
  const own = el('div', 'rn-own-play');
  own.append(el('div', 'rn-sub', 'Playback'));
  const row = el('div', 'rn-row');
  const clk = el('span', 'rn-status', '00:00:00');
  const speed = el('label', 'rn-speed');
  const range = el('input');
  const start = initialSpeed();
  range.type = 'range'; range.min = String(SPEED_MIN); range.max = String(SPEED_MAX); range.step = '1'; range.value = String(start);
  const readout = el('b', '', `${start}x`);
  range.addEventListener('input', () => {
    const x = clampSpeed(Number(range.value));
    readout.textContent = `${x}x`;
    h.onSpeed(x);
  });
  speed.append(range, readout);
  const reset = el('button', '', 'Reset');
  reset.title = 'Restart from the demo seed';
  reset.addEventListener('click', () => {
    networkUp = true; paintNet();
    h.onReset();
  });
  row.append(clk, speed, reset);
  own.append(row);
  root.append(own);

  return {
    root,
    net,
    switcher,
    sync(t, up) {
      clk.textContent = clock(t);
      if (up !== networkUp && performance.now() > holdUntil) { networkUp = up; paintNet(); }
    },
    skimKg() {
      const v = Number(skim.value);
      return Number.isFinite(v) && v > 0 ? v : initialSkimKg;
    },
    setTool,
    setMode,
    tool: () => tool,
    mode: () => mode,
    onChange: (fn) => { listeners.push(fn); },
  };
}
