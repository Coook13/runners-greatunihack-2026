// Tiny DOM helpers and the injected stylesheet. Plain DOM keeps the UI dependency-free.
//
// Minimal layout (see index.ts / shell.ts): the map is the page. Only a wordmark, the page switch, the network
// pill, the playback bar and one line of numbers sit on it; everything else lives in one right sidebar that
// stays shut until asked for. Sizes are em off one root size (--rn-fs) that scales with the viewport.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface Panel { root: HTMLElement; body: HTMLElement; title: HTMLElement }

/** A sidebar section with a title bar; clicking the title collapses it. */
export function panel(title: string, cls = ''): Panel {
  const root = el('section', `rn-panel ${cls}`.trim());
  const head = el('header', 'rn-head');
  const t = el('h2', 'rn-title', title);
  const caret = el('span', 'rn-caret');
  head.append(t, caret);
  head.addEventListener('click', () => root.classList.toggle('rn-collapsed'));
  const body = el('div', 'rn-body');
  root.append(head, body);
  return { root, body, title: t };
}

/** A centred overlay card with a close button (Esc closes it too), used for the breach result and the sweep chart. */
export function card(title: string): Panel & { show(): void; hide(): void } {
  const root = el('section', 'rn-panel rn-card rn-hidden');
  const head = el('header', 'rn-head');
  const t = el('h2', 'rn-title', title);
  const close = el('button', 'rn-close', 'Close');
  close.title = 'Close (Esc)';
  close.addEventListener('click', () => root.classList.add('rn-hidden'));
  head.append(t, close);
  const body = el('div', 'rn-body');
  root.append(head, body);
  return {
    root, body, title: t,
    show: () => root.classList.remove('rn-hidden'),
    hide: () => root.classList.add('rn-hidden'),
  };
}

// Colours shared by chart.js and the minimap (canvas can't read CSS variables cheaply).
// Colour carries meaning only: amber = Today (central dispatch), teal = Runners, red = loss, green = contained.
export const COLORS = {
  mesh: '#5fc1bc',      // teal: Runners mesh
  central: '#d4a05e',   // amber: today's central dispatch
  bad: '#e07a6a',       // red: losses and alerts
  ok: '#8cc97e',        // green: contained, caught, all accounted for
  text: '#e3e9e6',
  dim: '#93a29c',
  grid: 'rgba(255,255,255,0.06)',
};

/** The one UI type family, also handed to chart.js. */
export const CHART_FONT = 'Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

const CSS = `
:root {
  --rn-fs: clamp(15px, calc(min(0.75vw, 1.35vh) + 6px), 22px);
  --rn-gap: clamp(8px, 0.7vw, 14px);
  --rn-row-h: calc(var(--rn-fs) * 2.3);
  --rn-top: calc(var(--rn-gap) * 2 + var(--rn-row-h));
  --rn-pb-h: calc(var(--rn-fs) * 2.45);
  --rn-side-w: clamp(320px, 27vw, 450px);
  --rn-text: #e3e9e6; --rn-dim: #93a29c; --rn-faint: #66746e;
  --rn-glass: rgba(12, 17, 16, 0.5); --rn-glass-hi: rgba(12, 17, 16, 0.7);
  --rn-line: rgba(255, 255, 255, 0.07); --rn-line-hi: rgba(255, 255, 255, 0.13);
  --rn-hover: rgba(255, 255, 255, 0.06); --rn-sel: rgba(255, 255, 255, 0.1);
  --rn-today: #d4a05e; --rn-runners: #5fc1bc; --rn-bad: #e07a6a; --rn-ok: #8cc97e; --rn-audit: #a9c7d8;
  --rn-font: Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  --rn-blur: blur(18px) saturate(1.15);
  --rn-halo: 0 0 3px rgba(0, 0, 0, 0.85), 0 1px 10px rgba(0, 0, 0, 0.6);
}
.rn-app { position: absolute; inset: 0; z-index: 3; pointer-events: none !important; font-size: var(--rn-fs); line-height: 1.4;
  color: var(--rn-text); font-family: var(--rn-font); -webkit-font-smoothing: antialiased; }
.rn-app * { box-sizing: border-box; }
.rn-app button, .rn-app input, .rn-side, .rn-card, .rn-glass { pointer-events: auto; }
.rn-glass, .rn-card { background: var(--rn-glass); backdrop-filter: var(--rn-blur); -webkit-backdrop-filter: var(--rn-blur);
  border: 1px solid var(--rn-line); border-radius: 999px; }
.rn-hidden { display: none !important; }

/* ---------- buttons and inputs: quiet, no fills until hover ---------- */
.rn-app button { font: inherit; font-size: 0.9em; line-height: 1.2; color: var(--rn-text); background: transparent;
  border: 1px solid var(--rn-line); border-radius: 0.5em; padding: 0.4em 0.65em; cursor: pointer; white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, color 0.15s; }
.rn-app button:hover { background: var(--rn-hover); border-color: var(--rn-line-hi); }
.rn-app button:focus-visible { outline: 1px solid rgba(255,255,255,0.45); outline-offset: 1px; }
.rn-app button.rn-on { background: var(--rn-sel); border-color: var(--rn-line-hi); }
.rn-num { width: 3.4em; font: inherit; font-size: 0.9em; color: var(--rn-text); background: transparent; border: 1px solid var(--rn-line-hi);
  border-radius: 0.45em; padding: 0.34em 0.4em; font-variant-numeric: tabular-nums; }

/* ---------- top row: wordmark, page switch, network pill, sidebar button ---------- */
.rn-mark { position: absolute; top: var(--rn-gap); left: calc(var(--rn-gap) * 1.5); height: var(--rn-row-h); display: flex; align-items: center;
  font-weight: 650; font-size: 1.05em; letter-spacing: 0.03em; text-shadow: var(--rn-halo); }
.rn-switch { position: absolute; top: var(--rn-gap); left: 50%; transform: translateX(-50%); height: var(--rn-row-h);
  display: flex; align-items: center; gap: 0.15em; padding: 0.2em; }
.rn-app .rn-switch button { border: 0; border-radius: 999px; height: 100%; padding: 0 1em; color: var(--rn-dim); font-size: 0.86em; }
.rn-app .rn-switch button:hover { color: var(--rn-text); }
.rn-app .rn-switch button.rn-on { background: var(--rn-sel); color: var(--rn-text); }
.rn-tr { position: absolute; top: var(--rn-gap); right: var(--rn-gap); height: var(--rn-row-h); display: flex; align-items: center; gap: 0.5em; }
.rn-app .rn-net { display: inline-flex; align-items: center; gap: 0.5em; height: 100%; padding: 0 1em; border-radius: 999px;
  font-size: 0.8em; font-weight: 650; letter-spacing: 0.09em; background: var(--rn-glass); border-color: var(--rn-line);
  backdrop-filter: var(--rn-blur); -webkit-backdrop-filter: var(--rn-blur); }
.rn-app .rn-net:hover { background: var(--rn-glass-hi); }
.rn-app .rn-net.rn-down { color: #f0b3a7; background: rgba(110, 40, 32, 0.45); border-color: rgba(224,122,106,0.5); }
.rn-dot { width: 0.55em; height: 0.55em; border-radius: 50%; background: var(--rn-ok); flex: none; }
.rn-down .rn-dot { background: var(--rn-bad); }
.rn-app .rn-iconbtn { height: 100%; aspect-ratio: 1; padding: 0; display: grid; place-items: center; border-radius: 999px;
  background: var(--rn-glass); border-color: var(--rn-line); color: var(--rn-dim); backdrop-filter: var(--rn-blur); -webkit-backdrop-filter: var(--rn-blur); }
.rn-app .rn-iconbtn:hover { color: var(--rn-text); background: var(--rn-glass-hi); }
.rn-app .rn-iconbtn.rn-on { color: var(--rn-text); background: var(--rn-glass-hi); border-color: var(--rn-line-hi); }
.rn-iconbtn svg { width: 1.15em; height: 1.15em; }
.rn-chip { display: inline-flex; align-items: center; gap: 0.45em; height: 100%; padding: 0 0.9em; font-size: 0.8em; color: var(--rn-dim); }
.rn-chip b { color: var(--rn-text); font-weight: 600; }
.rn-badge { position: absolute; top: -0.2em; right: -0.2em; min-width: 1.45em; height: 1.45em; padding: 0 0.3em; border-radius: 999px;
  display: grid; place-items: center; font-size: 0.7em; font-weight: 700; color: #f6d0c8; background: rgba(150, 52, 40, 0.9);
  font-variant-numeric: tabular-nums; pointer-events: none; }
.rn-badge:empty { display: none; }
[data-tip] { position: relative; }
[data-tip]:hover::after { content: attr(data-tip); position: absolute; top: calc(100% + 0.6em); right: 0; z-index: 9; white-space: nowrap;
  padding: 0.4em 0.7em; border-radius: 0.45em; font-size: 0.8rem; font-weight: 500; letter-spacing: 0; text-transform: none;
  color: var(--rn-text); background: rgba(12, 17, 16, 0.86); border: 1px solid var(--rn-line); pointer-events: none; }

/* ---------- the lead's playback bar (src/ui/playback.ts): same glass, thinner, quieter ---------- */
.rn-host .pb { bottom: var(--rn-gap); height: var(--rn-pb-h); padding: 0 0.35em; gap: 0.15em; border-radius: 999px;
  background: var(--rn-glass); border: 1px solid var(--rn-line); box-shadow: none; backdrop-filter: var(--rn-blur); -webkit-backdrop-filter: var(--rn-blur);
  font: 500 calc(var(--rn-fs) * 0.86) / 1 var(--rn-font); color: var(--rn-text); }
.rn-host .pb button { height: calc(var(--rn-pb-h) - 0.75em); padding: 0 0.6em; border-radius: 999px; background: transparent; color: var(--rn-dim);
  font: inherit; font-variant-numeric: tabular-nums; }
.rn-host .pb button:hover { background: var(--rn-hover); color: var(--rn-text); }
.rn-host .pb button.on { background: var(--rn-sel); color: var(--rn-text); }
.rn-host .pb .play, .rn-host .pb .play.paused { width: auto; min-width: 2.4em; color: var(--rn-text); background: var(--rn-sel);
  font-family: "Segoe UI Symbol", var(--rn-font); font-variant-emoji: text; font-size: 1em; }
.rn-host .pb .play.paused { background: rgba(255,255,255,0.14); }
.rn-host .pb .reset { font-family: "Segoe UI Symbol", var(--rn-font); font-variant-emoji: text; }
.rn-host .pb .clock { min-width: 8.6em; color: var(--rn-text); font-weight: 500; padding: 0 0.5em; white-space: pre; }
.rn-host .pb .sep { height: 1.2em; background: var(--rn-line-hi); }

/* ---------- one line of numbers per side, just above the playback bar ---------- */
.rn-lines { position: absolute; left: 0; right: 0; bottom: calc(var(--rn-gap) + var(--rn-pb-h) + 0.55em); display: flex; pointer-events: none; }
.rn-line { --side: var(--rn-dim); flex: 1 1 0; min-width: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.3em 1em; margin: 0 0.7em; padding: 0.6em 1em; border-radius: 12px; background: rgba(9,16,14,.93);
  border: 1px solid rgba(255,255,255,.14); font-size: 0.9em; color: #c3ccc8; }
.rn-line .rn-who { grid-column: 1 / -1; }
.rn-kpi { display: flex; flex-direction: column; min-width: 0; }
.rn-kpi-label { font-size: 0.82em; color: #aab9b2; }
.rn-line .rn-kpi b { margin: 0; font-size: 1.25em; white-space: nowrap; }
.rn-line .rn-kpi:last-child b { font-size: 1em; padding-top: .25em; }
@media(max-width: 900px) { .rn-line { gap: .4em; padding: .4em; font-size: .7em; } }
.rn-line.rn-today { --side: var(--rn-today); }
.rn-line.rn-runners { --side: var(--rn-runners); }
.rn-lines.rn-single .rn-line.rn-off { display: none; }
.rn-line .rn-who { color: var(--side); font-weight: 700; font-size: 0.82em; letter-spacing: 0.12em; text-transform: uppercase; margin-right: 0.8em; }
.rn-line b { color: var(--rn-text); font-weight: 600; font-variant-numeric: tabular-nums; margin-left: 0.3em; }
.rn-line b.rn-good { color: var(--rn-ok); }
.rn-line b.rn-bad { color: var(--rn-bad); }
.rn-line i { font-style: normal; color: var(--rn-faint); margin: 0 0.7em; }

/* ---------- the one sidebar ---------- */
.rn-side { position: absolute; top: var(--rn-top); right: var(--rn-gap); bottom: var(--rn-gap); width: var(--rn-side-w); z-index: 2;
  display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.12) transparent; background: rgba(12, 17, 16, 0.6); backdrop-filter: var(--rn-blur);
  -webkit-backdrop-filter: var(--rn-blur); border: 1px solid var(--rn-line); border-radius: 0.9em;
  transform: translateX(calc(100% + var(--rn-gap) * 2)); opacity: 0; visibility: hidden;
  transition: transform 0.28s ease, opacity 0.2s ease, visibility 0s linear 0.28s; }
.rn-side.rn-open { transform: none; opacity: 1; visibility: visible; transition: transform 0.28s ease, opacity 0.2s ease, visibility 0s; }
.rn-side > * + * { border-top: 1px solid var(--rn-line); }
.rn-actions { display: flex; gap: 0.5em; padding: 0.8em 1em; flex-wrap: wrap; }

/* ---------- sections ---------- */
.rn-head { display: flex; align-items: center; justify-content: space-between; gap: 0.6em; padding: 0.85em 1.05em 0.5em; cursor: pointer; user-select: none; }
.rn-title { margin: 0; font-size: 0.75em; font-weight: 650; text-transform: uppercase; letter-spacing: 0.12em; color: var(--rn-dim); }
.rn-head:hover .rn-title { color: var(--rn-text); }
.rn-caret { width: 0.5em; height: 0.5em; border-right: 1.5px solid var(--rn-faint); border-bottom: 1.5px solid var(--rn-faint);
  transform: rotate(45deg) translate(-0.15em, -0.15em); transition: transform 0.2s; flex: none; }
.rn-collapsed .rn-caret { transform: rotate(-45deg); }
.rn-body { padding: 0.2em 1.05em 1em; }
.rn-collapsed > .rn-body { display: none; }
.rn-panel.rn-flash > .rn-head .rn-title { color: var(--rn-bad); }
.rn-sub { color: var(--rn-dim); font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.1em; margin: 0.2em 0 0.4em; }
.rn-row { display: flex; flex-wrap: wrap; gap: 0.3em; align-items: center; margin-bottom: 0.7em; }
.rn-unit { color: var(--rn-dim); font-size: 0.85em; }
.rn-speed { display: flex; align-items: center; gap: 0.5em; color: var(--rn-dim); font-size: 0.88em; }
.rn-speed input { width: 8em; accent-color: #8c9a94; }
.rn-speed b { font-weight: 600; color: var(--rn-text); font-variant-numeric: tabular-nums; min-width: 2.4em; }
.rn-status { font-size: 0.88em; color: var(--rn-dim); }

.rn-metrics { display: grid; grid-template-columns: 1fr auto; row-gap: 0.3em; column-gap: 1.1em; align-items: baseline; }
.rn-metrics.rn-two { grid-template-columns: 1fr auto auto; }
.rn-metrics .rn-k { color: #b4bfba; font-size: 0.9em; }
.rn-metrics .rn-v { font-size: 1.05em; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.rn-metrics .rn-v.rn-big { font-size: 1.6em; }
.rn-metrics .rn-v.rn-bad { color: var(--rn-bad); }
.rn-metrics .rn-colhead { font-size: 0.72em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; text-align: right; }
.rn-chart { position: relative; height: 9.5em; }

.rn-kv { display: grid; grid-template-columns: auto 1fr; gap: 0.28em 0.9em; font-size: 0.92em; }
.rn-kv .rn-k { color: var(--rn-dim); }
.rn-list { list-style: none; margin: 0.4em 0 0; padding: 0; }
.rn-list li { padding: 0.38em 0; border-top: 1px solid var(--rn-line); font-size: 0.9em; }
.rn-logs { font-family: ui-monospace, Consolas, monospace; font-size: 0.78em; line-height: 1.5; color: #bcc6c1;
  max-height: 15em; overflow-y: auto; margin-top: 0.7em; scrollbar-width: thin; }
.rn-sealed { color: var(--rn-ok); font-weight: 600; }
.rn-bad-text { color: var(--rn-bad); font-weight: 600; }
.rn-empty { color: var(--rn-dim); font-size: 0.9em; }

.rn-finding { cursor: pointer; border-radius: 0.4em; padding: 0.45em 0.5em !important; }
.rn-finding:hover { background: var(--rn-hover); }
.rn-finding .rn-tag { display: inline-block; font-size: 0.72em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--rn-bad); margin-right: 0.45em; }
.rn-finding .rn-meta { color: var(--rn-dim); font-size: 0.8em; margin-left: 0.4em; font-variant-numeric: tabular-nums; }
.rn-finding.rn-fresh { animation: rn-flash 1.8s ease-out; }
@keyframes rn-flash { from { background: rgba(224,122,106,0.22); } to { background: transparent; } }

.rn-attacks { display: grid; grid-template-columns: 1fr 1fr; gap: 0.3em; }
.rn-attacks button { text-align: left; font-size: 0.86em; }
.rn-result { margin-top: 0.7em; font-size: 0.88em; min-height: 1.3em; }
.rn-result div { padding: 0.3em 0; border-top: 1px solid var(--rn-line); }
.rn-result div:first-child { color: var(--rn-text); font-weight: 600; }
.rn-result div:not(:first-child) { color: var(--rn-dim); }

.rn-ledger { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.6em 0.8em; margin-bottom: 0.4em; }
.rn-tile b { display: block; font-size: 1.45em; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.15; }
.rn-tile span { color: var(--rn-dim); font-size: 0.8em; }
.rn-tile.rn-bad b { color: var(--rn-bad); }
.rn-headline { font-size: 0.95em; margin: 0.1em 0 0.8em; color: #c9d2cd; }

.rn-mini { position: relative; }
.rn-mini canvas { width: 100%; aspect-ratio: 1 / 1; display: block; border-radius: 0.5em; background: rgba(0,0,0,0.2); }
.rn-mini .rn-tagline { position: absolute; top: 0.55em; left: 0.7em; font-size: 0.82em; font-weight: 600; }

/* ---------- centred overlay cards: breach result, sweep chart ---------- */
.rn-card { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 4; border-radius: 0.9em;
  width: min(52em, calc(100% - 4 * var(--rn-gap))); max-height: calc(100% - 2 * var(--rn-top)); overflow-y: auto;
  background: var(--rn-glass-hi); scrollbar-width: thin; animation: rn-pop 0.2s ease-out; }
@keyframes rn-pop { from { opacity: 0; transform: translate(-50%, calc(-50% + 0.6em)); } to { opacity: 1; transform: translate(-50%, -50%); } }
.rn-card .rn-head { cursor: default; padding: 1em 1.2em 0.4em; }
.rn-card .rn-body { padding: 0.3em 1.2em 1.2em; }
.rn-app .rn-close { font-size: 0.8em; padding: 0.3em 0.75em; color: var(--rn-dim); }
.rn-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2em; margin-top: 0.6em; }
.rn-side-col { padding-left: 0.9em; border-left: 2px solid var(--rn-line-hi); }
.rn-side-col.rn-mesh { border-left-color: var(--rn-runners); }
.rn-side-col.rn-central { border-left-color: var(--rn-today); }
.rn-side-col h3 { margin: 0 0 0.25em; font-size: 0.8em; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.rn-side-col.rn-mesh h3 { color: var(--rn-runners); }
.rn-side-col.rn-central h3 { color: var(--rn-today); }
.rn-score { font-size: 2.4em; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }
.rn-score small { font-size: 0.32em; color: var(--rn-dim); font-weight: 400; margin-left: 0.5em; }
.rn-side-col ul { list-style: none; padding: 0; margin: 0.4em 0 0; font-size: 0.9em; }
.rn-side-col li { padding: 0.12em 0; color: #c3ccc8; }
.rn-side-col li.rn-hot { color: var(--rn-bad); font-weight: 600; }
.rn-sweep { position: relative; height: min(19em, 45vh); }

/* ---------- toast ---------- */
.rn-toast { position: absolute; left: 50%; bottom: calc(var(--rn-gap) + var(--rn-pb-h) + 2.6em); transform: translate(-50%, 0.4em); z-index: 5;
  padding: 0.5em 1em; border-radius: 999px; background: var(--rn-glass-hi); border: 1px solid var(--rn-line); color: var(--rn-dim);
  backdrop-filter: var(--rn-blur); -webkit-backdrop-filter: var(--rn-blur); font-size: 0.82em; white-space: nowrap;
  opacity: 0; transition: opacity 0.25s, transform 0.25s; pointer-events: none; }
.rn-toast.rn-on { opacity: 1; transform: translate(-50%, 0); }
.rn-kbd { font-family: ui-monospace, Consolas, monospace; font-size: 0.92em; font-weight: 600; color: var(--rn-text);
  padding: 0.05em 0.4em; border-radius: 0.3em; border: 1px solid var(--rn-line-hi); margin: 0 0.35em 0 1em; }
.rn-kbd:first-child { margin-left: 0; }

/* ---------- incident feed (src/ui/threatFeed.ts), adopted into the sidebar as a section ---------- */
.rn-app .tf { position: static; width: auto; max-height: none; flex: none; color: var(--rn-text); font: inherit; background: none;
  border: 0; border-radius: 0; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
.rn-side > .tf { border-top: 1px solid var(--rn-line); }
.rn-app .tf h3 { display: flex; justify-content: space-between; align-items: center; padding: 0.85em 1.05em 0.5em; font-size: 0.75em;
  font-weight: 650; letter-spacing: 0.12em; color: var(--rn-dim); cursor: pointer; user-select: none; }
.rn-app .tf h3:hover { color: var(--rn-text); }
.rn-app .tf h3::after { content: ''; width: 0.62em; height: 0.62em; border-right: 1.5px solid var(--rn-faint); border-bottom: 1.5px solid var(--rn-faint);
  transform: rotate(45deg) translate(-0.2em, -0.2em); }
.rn-app .tf.rn-collapsed h3::after { transform: rotate(-45deg); }
.rn-app .tf.rn-collapsed .counts, .rn-app .tf.rn-collapsed ul { display: none; }
.rn-app .tf .counts { gap: 0.8em; padding: 0.2em 1.05em 0.6em; }
.rn-app .tf .c { background: none; padding: 0; border-radius: 0; }
.rn-app .tf .c b { font-size: 1.3em; font-weight: 600; font-variant-numeric: tabular-nums; }
.rn-app .tf .c span { font-size: 0.78em; color: var(--rn-dim); }
.rn-app .tf ul { padding: 0 0.8em 0.9em; max-height: 18em; overflow: auto; scrollbar-width: thin; }
.rn-app .tf li { font-size: 0.86em; padding: 0.4em 0.6em; margin: 0.15em 0; border-radius: 0.4em; border-left-width: 2px; background: none; }
.rn-app .tf li time { color: var(--rn-dim); }
.rn-app .tf li.succeeded { border-color: var(--rn-bad); }
.rn-app .tf li.detected { border-color: #c4ab78; }
.rn-app .tf li.contained, .rn-app .tf li.blocked { border-color: var(--rn-ok); }
.rn-app .tf li.report { border-color: var(--rn-audit); }

/* The auditor button (src/ui/glassbox.ts) is adopted into the sidebar's action row (G opens it from anywhere). */
.rn-app .sb-auditor-btn { position: static !important; z-index: auto; display: inline-flex !important; align-items: center; gap: 0.5em;
  font-family: inherit; font-size: 0.86em !important; font-weight: 600; padding: 0.5em 0.85em !important; color: var(--rn-audit) !important;
  background: transparent !important; border: 1px solid rgba(169,199,216,0.35) !important; border-radius: 999px !important;
  backdrop-filter: none; box-shadow: none; }
.rn-app .sb-auditor-btn:hover { background: rgba(169,199,216,0.1) !important; }

/* ---------- story views and map overlays owned elsewhere: placed and toned to fit ---------- */
.rn-host .sb-bb:not(.sb-inline) { top: var(--rn-top); left: 50%; right: auto; transform: translateX(-50%); width: clamp(320px, 30vw, 460px);
  max-height: calc(100% - var(--rn-top) - var(--rn-pb-h) - 4.5em); }
.rn-host.rn-side-on .sb-bb:not(.sb-inline) { left: calc((100% - var(--rn-side-w) - var(--rn-gap)) / 2); }
.rn-host .sb-bb:not(.sb-inline) .sb-bb-screen { max-height: calc(100vh - var(--rn-top) - var(--rn-pb-h) - 13em); }
.rn-host .sb-gb { top: var(--rn-top); bottom: calc(var(--rn-gap) * 2 + var(--rn-pb-h)); }
#side-0 .side-tag, #side-1 .side-tag { top: var(--rn-top) !important; left: calc(var(--rn-gap) * 1.5) !important; padding: 0.35em 0.85em !important;
  border-radius: 999px !important; background: var(--rn-glass) !important; backdrop-filter: var(--rn-blur); border: 1px solid var(--rn-line);
  font: 650 calc(var(--rn-fs) * 0.76) / 1.2 var(--rn-font) !important; letter-spacing: 0.1em !important; text-transform: uppercase; }
#side-0 .side-tag { color: var(--rn-today) !important; }
#side-1 .side-tag { color: var(--rn-runners) !important; }
.rl-attr { max-width: 30% !important; font-size: 9px !important; color: rgba(215, 224, 220, 0.55) !important; background: rgba(12, 17, 16, 0.42) !important; }
#side-0 .rl-attr { right: auto !important; left: 6px; text-align: left !important; }
html .rl { color: #dfe6e2; background: rgba(12, 17, 16, 0.58); box-shadow: none; border: 1px solid rgba(255,255,255,0.06);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
html .rl.village, html .rl.city, html .rl.small { background: rgba(12, 17, 16, 0.58); color: #dfe6e2; }
html .rl.hamlet { color: #b9c3be; }
html .rl.clinic { color: #9fd6cd; }
html .rl.store { color: #e0bf93; }
html .rl.hub { color: #cfc4a2; background: rgba(12, 17, 16, 0.5); }
html .rl.geo { color: rgba(185, 212, 228, 0.8); background: none; border: 0; backdrop-filter: none; }
html .rl.node { color: #e3e9e6; background: rgba(12, 17, 16, 0.72); }
html .rl.node.fake { background: rgba(130, 40, 32, 0.85); }
.rn-demo-cap-wrap { bottom: calc(var(--rn-gap) + var(--rn-pb-h) + 7em) !important; }

/* Guided demo: one proof at a time; advanced tools remain in the drawer. */
.rn-demo-context { position: absolute; top: 70px; left: 50%; transform: translateX(-50%); z-index: 6;
  font: 500 14px var(--rn-font); color: #c4d1cb; padding: 7px 14px; border-radius: 20px; background: rgba(9,16,14,.9); }
.rn-demo-heading { position: absolute; top: 112px; left: 50%; transform: translateX(-50%); z-index: 6;
  font: 650 30px var(--rn-font); color: white; text-align: center; text-shadow: 0 2px 12px #000; white-space: nowrap; }
.rn-demo-mode .rl.village, .rn-demo-mode .rl.city, .rn-demo-mode .rl.small, .rn-demo-mode .rl.hamlet { display: none; }
.rn-demo-mode .rn-host .sb-bb:not(.sb-inline) { top: 175px; width: min(620px, 85vw); }
.rn-demo-mode .sb-bb-foot, .rn-demo-mode .sb-load, .rn-demo-mode .sb-crates { display: none; }
.rn-demo-mode .rn-host .sb-bb:not(.sb-inline) .sb-bb-screen { max-height: 380px; }
.rn-demo-mode .rn-card { top: 42%; background: rgba(9,16,14,.97); }
.rn-demo-mode .rn-demo-card { background: rgba(9,16,14,.96); }
.rn-demo-mode .rn-demo-clip { left: 50%; transform: translate(-50%, 6px); top: 190px; width: 600px; }
.rn-demo-mode .rn-demo-clip.rn-on { transform: translate(-50%, 0); }
.rn-demo-mode .rn-demo-score { top: 22%; }
.rn-demo-mode .rn-demo-score td.rn-num { font-size: 28px; }
.rn-demo-mode .rn-demo-chain ol { font-size: 22px; line-height: 1.8; }
.rn-demo-mode .rn-demo-chain .rn-demo-note { font-size: 19px; }
.rn-demo-mode .rn-host .sb-gb { top: 174px; bottom: 285px; }
.rn-demo-mode .sb-gb-summary, .rn-demo-mode .sb-gb-list { display: none; }
.rn-demo-mode .sb-gb-main { grid-template-columns: minmax(0, 1fr); }
.rn-demo-mode .sb-gb-detail { grid-template-columns: 1fr 1.15fr; }
.rn-demo-mode .sb-gb-detail > div { padding: 20px; }
.rn-demo-mode .sb-stop { padding: 12px 0; }
.rn-demo-mode .rn-demo-cap { font-size: 28px; padding: 12px 24px; }
.rn-capture .pb, .rn-capture .rn-switch, .rn-capture .rn-iconbtn, .rn-capture .rn-chip { display: none !important; }
.rn-capture .rn-lines { bottom: 46px; }
.rn-capture .rn-demo-cap-wrap { bottom: 180px !important; }
.rn-capture .rn-close, .rn-capture .sb-bb-status button, .rn-capture .sb-gb-head button { visibility: hidden; }
[data-demo-beat="scoreboard"] .rn-lines, [data-demo-beat="close"] .rn-lines,
[data-demo-beat="title"] .rn-lines, [data-demo-beat="done"] .rn-lines { visibility: hidden; }

/* main.ts stopgap (#sb-toggle, #net-pill): this UI draws its own, so hide the duplicates while it is mounted. */
html.rn-ready #sb-toggle, html.rn-ready #net-pill { display: none !important; }
html.rn-ready .rn-app .tf { max-width: none !important; display: block !important; }
html.rn-ready .rn-app .sb-auditor-btn { display: inline-flex !important; }
.rn-actions:empty { display: none; }

/* ---------- H: hide every overlay, maps only ---------- */
.rn-host.rn-ui-off > :not(.rn-app), .rn-host.rn-ui-off .rn-app > :not(.rn-toast) { visibility: hidden !important; }
html.rn-ui-off .side-tag { visibility: hidden !important; }
`;

let injected = false;
export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return;
  const s = document.createElement('style');
  s.dataset.rn = 'ui';
  s.textContent = CSS;
  document.head.appendChild(s);
  injected = true;
}
