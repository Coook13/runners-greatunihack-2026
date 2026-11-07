// Shared look for the story views (black box, glass box, before/after). Same dark glass as the WP6 panels,
// bigger type so it reads from the back of the room, and a few inline SVG icons (no assets, works offline).
import type { NodeKind, Urgency } from '../contracts/types';

export const STORY = { text: '#e6ebe8', dim: '#93a19a', mesh: '#7fc2a6', central: '#d4a05e', bad: '#de8a76', glass: '#a9c7d8' };
export const URGENCY_COLOR: Record<Urgency, string> = { 1: STORY.mesh, 2: STORY.central, 3: STORY.bad };
export const URGENCY_NAME: Record<Urgency, string> = { 1: 'routine', 2: 'soon', 3: 'urgent' };

const PATHS = {
  drone: '<path d="M12 3v18M3.5 10.5 12 8l8.5 2.5M8.5 19.5 12 18l3.5 1.5"/>',
  motorbike: '<circle cx="5.5" cy="16" r="3"/><circle cx="18.5" cy="16" r="3"/><path d="M5.5 16 9.5 10h5l4 6M9.5 10 8.5 7H6.5M14.5 10l2-3h2"/>',
  van: '<path d="M2.5 6.5h11.5v9.5H2.5zM14 9.5h4l3.5 3.5v3H14"/><circle cx="6.5" cy="17" r="1.8"/><circle cx="17.5" cy="17" r="1.8"/>',
  boat: '<path d="M3 15h18l-3 4.5H6zM12 3.5V15M12 4.5l6 8h-6"/>',
  store: '<path d="M3 10 12 4l9 6v10H3zM9 20v-6h6v6"/>',
  clinic: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
  dispatch: '<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01M8 17.5h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M13.5 9.5 16 12"/>',
  check: '<path d="M5 12.5 9.5 17 19 7.5"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 3h6v3.5H9zM8.5 11h7M8.5 14h7M8.5 17h4.5"/>',
  blackbox: '<rect x="3.5" y="5" width="17" height="14.5" rx="2.5"/><rect x="6.5" y="8" width="11" height="5.5" rx="1"/><path d="M7.5 16.5h3M14 16.5h2.5M17 5V2.5"/>',
  glass: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  scale: '<path d="M4 20.5h16M6.5 20.5 8 11h8l1.5 9.5M12 11V6.5M9 6.5h6"/>',
} as const;

export type IconName = keyof typeof PATHS;

export const kindIcon = (k: NodeKind | null): IconName => (k ?? 'clinic') as IconName;

/** An inline SVG icon that takes the text colour. */
export function icon(name: IconName, size = 20, cls = ''): HTMLElement {
  const s = document.createElement('span');
  s.className = `sb-icon ${cls}`.trim();
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
  return s;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const CSS = `
.sb { color: #e6ebe8; font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 15px;
  pointer-events: auto; box-sizing: border-box; line-height: 1.35; }
.sb * { box-sizing: border-box; }
.sb-hidden { display: none !important; }
.sb-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.sb button { font: inherit; font-size: 14px; color: #e6ebe8; background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.sb button:hover { background: rgba(255,255,255,0.12); }
.sb-mono { font-family: ui-monospace, Consolas, monospace; }
.sb-dim { color: #93a19a; }
.sb-empty { color: #93a19a; font-style: italic; }
.sb-chip { display: inline-block; padding: 2px 9px; margin: 4px 5px 0 0; border-radius: 999px; font-size: 14px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); }
.sb-chip.sb-zero { color: #7fc2a6; border-color: rgba(127,194,166,0.35); }
.sb-chip.sb-hot { color: #de8a76; background: rgba(222,138,118,0.14); border-color: rgba(222,138,118,0.45); font-weight: 600; }

/* ---------- black box: rugged in-vehicle device ---------- */
.sb-bb { position: absolute; top: 84px; right: 404px; width: 440px; max-height: calc(100% - 100px); z-index: 12; }
.sb-bb.sb-inline { position: relative; top: auto; right: auto; width: 100%; max-height: none; }
.sb-bb-bezel { position: relative; padding: 12px 12px 10px; border-radius: 26px;
  background: linear-gradient(180deg, #2b322f 0%, #1a201e 100%);
  box-shadow: 0 12px 34px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07), inset 0 0 0 1px rgba(0,0,0,0.55); }
.sb-bump { position: absolute; width: 34px; height: 34px; border: 4px solid #121715; pointer-events: none; }
.sb-tl { top: -3px; left: -3px; border-right: 0; border-bottom: 0; border-top-left-radius: 26px; }
.sb-tr { top: -3px; right: -3px; border-left: 0; border-bottom: 0; border-top-right-radius: 26px; }
.sb-bl { bottom: -3px; left: -3px; border-right: 0; border-top: 0; border-bottom-left-radius: 26px; }
.sb-br { bottom: -3px; right: -3px; border-left: 0; border-top: 0; border-bottom-right-radius: 26px; }
.sb-bb-status { display: flex; align-items: center; gap: 8px; padding: 0 8px 10px; font-size: 13px; color: #93a19a; }
.sb-bb-brand { font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #e6ebe8; }
.sb-bb-id { font-family: ui-monospace, Consolas, monospace; color: #e6ebe8; }
.sb-bb-status .sb-space { flex: 1; }
.sb-bb-status button { font-size: 12px; padding: 3px 10px; }
.sb-bb-screen { background: #0b100e; border-radius: 14px; padding: 16px 18px 14px; border: 1px solid rgba(255,255,255,0.05);
  box-shadow: inset 0 2px 14px rgba(0,0,0,0.65); max-height: calc(100vh - 300px); overflow-y: auto; scrollbar-width: thin; }
.sb-bb-nextk { font-size: 13px; font-weight: 700; letter-spacing: 0.16em; color: #7fc2a6; }
.sb-bb-next { font-size: 27px; line-height: 1.2; font-weight: 700; margin: 4px 0 10px; }
.sb-bb-steps { list-style: none; margin: 0; padding: 0; }
.sb-bb-steps li { font-size: 17px; padding: 7px 0; border-top: 1px solid rgba(255,255,255,0.07); }
.sb-crates { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.sb-crate { border-radius: 10px; padding: 8px 10px 9px; background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08); border-left: 6px solid var(--u, #93a19a); }
.sb-crate-top { display: flex; align-items: center; gap: 6px; }
.sb-crate-top b { font-size: 16px; margin-right: auto; }
.sb-tag { font-size: 12px; padding: 1px 7px; border-radius: 6px; background: rgba(255,255,255,0.08); color: #c9d2cd; }
.sb-crate-u { font-size: 13px; font-weight: 600; color: var(--u, #93a19a); margin-top: 2px; }
.sb-crate-dest { font-size: 18px; font-weight: 600; margin-top: 3px; }
.sb-crate-lock { display: flex; align-items: center; gap: 5px; font-size: 13px; color: #7fc2a6; margin-top: 3px; }
.sb-crate-lock.sb-open { color: #de8a76; }
.sb-load { margin-top: 10px; font-size: 13px; color: #93a19a; }
.sb-load-bar { height: 8px; border-radius: 4px; background: rgba(255,255,255,0.08); margin-top: 4px; overflow: hidden; }
.sb-load-bar i { display: block; height: 100%; background: #7fc2a6; border-radius: 4px; }
.sb-lock { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 10px 12px; border-radius: 10px;
  font-size: 16px; font-weight: 600; color: #bfe3d3; background: rgba(127,194,166,0.10); border: 1px solid rgba(127,194,166,0.38); }
.sb-lock.sb-bad { color: #f0c2b7; background: rgba(222,138,118,0.12); border-color: rgba(222,138,118,0.45); }
.sb-station { margin-top: 10px; font-size: 15px; color: #93a19a; }
.sb-bb-foot { padding: 10px 8px 2px; font-size: 14px; color: #93a19a; }
.sb-bb-foot .sb-crew { margin-top: 6px; font-size: 13px; }

/* ---------- glass box: auditor view ---------- */
.sb-gb { position: absolute; top: 76px; bottom: 16px; left: 50%; transform: translateX(-50%); width: min(1240px, calc(100% - 32px));
  display: flex; flex-direction: column; z-index: 20; border-radius: 14px; overflow: hidden;
  background: rgba(13,18,17,0.92); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(169,199,216,0.25); box-shadow: 0 14px 44px rgba(0,0,0,0.5); }
.sb-gb-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.08); }
.sb-gb-icon { color: #a9c7d8; }
.sb-gb-title { font-size: 22px; font-weight: 700; }
.sb-gb-title span { font-weight: 400; color: #a9c7d8; margin-left: 6px; font-size: 18px; }
.sb-gb-head .sb-space { flex: 1; }
.sb-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; padding: 4px 10px;
  border-radius: 999px; color: #a9c7d8; border: 1px solid rgba(169,199,216,0.4); background: rgba(169,199,216,0.08); }
.sb-pill.sb-bad { color: #de8a76; border-color: rgba(222,138,118,0.5); background: rgba(222,138,118,0.1); }
.sb-gb-summary { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 12px 18px;
  border-bottom: 1px solid rgba(255,255,255,0.08); }
.sb-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.sb-tile { border: 1px solid rgba(255,255,255,0.08); border-radius: 9px; padding: 5px 9px; }
.sb-tile b { display: block; font-size: 24px; font-variant-numeric: tabular-nums; line-height: 1.15; }
.sb-tile span { font-size: 12.5px; color: #93a19a; }
.sb-tile.sb-bad b { color: #de8a76; }
.sb-findings { list-style: none; margin: 0; padding: 0; max-height: 128px; overflow-y: auto; scrollbar-width: thin; }
.sb-findings h4 { margin: 0; }
.sb-findings li { padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 14.5px; }
.sb-findings li:hover { background: rgba(255,255,255,0.06); }
.sb-findings .sb-ftag { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: #de8a76; margin-right: 6px; font-weight: 700; }
.sb-gb-main { flex: 1; min-height: 0; display: grid; grid-template-columns: 250px minmax(0, 1fr); }
.sb-gb-list { overflow-y: auto; border-right: 1px solid rgba(255,255,255,0.08); padding: 8px; scrollbar-width: thin; }
.sb-gb-list button { display: block; width: 100%; text-align: left; margin-bottom: 4px; padding: 7px 10px; background: transparent; border-color: transparent; }
.sb-gb-list button.sb-on { background: rgba(169,199,216,0.14); border-color: rgba(169,199,216,0.45); }
.sb-gb-list .sb-bid { font-family: ui-monospace, Consolas, monospace; font-size: 14px; }
.sb-gb-list .sb-bst { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #93a19a; }
.sb-dot { width: 8px; height: 8px; border-radius: 50%; background: #93a19a; flex: none; }
.sb-ok .sb-dot { background: #7fc2a6; } .sb-bad .sb-dot { background: #de8a76; }
.sb-gb-detail { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); }
.sb-gb-detail > div { overflow-y: auto; padding: 14px 18px; scrollbar-width: thin; }
.sb-gb-detail > div + div { border-left: 1px solid rgba(255,255,255,0.08); }
.sb-gb h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: #93a19a;
  display: flex; align-items: center; gap: 8px; }
.sb-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 15px; margin-bottom: 10px; }
.sb-kv .sb-k { color: #93a19a; }
.sb-items { width: 100%; border-collapse: collapse; font-size: 15px; margin: 4px 0 10px; }
.sb-items th { text-align: left; font-size: 12px; font-weight: 600; color: #93a19a; text-transform: uppercase; letter-spacing: 0.07em; padding: 4px 6px; }
.sb-items td { padding: 6px; border-top: 1px solid rgba(255,255,255,0.07); }
.sb-items td.sb-n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sb-note { margin: 8px 0; padding: 10px 12px; border-radius: 10px; background: rgba(169,199,216,0.08); border: 1px solid rgba(169,199,216,0.25); font-size: 16px; }
.sb-note small { display: block; color: #93a19a; font-size: 12.5px; margin-top: 3px; }
.sb-sig { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; }
.sb-sig.sb-ok { color: #7fc2a6; } .sb-sig.sb-bad { color: #de8a76; } .sb-sig.sb-unk { color: #93a19a; font-weight: 400; }
.sb-tl { list-style: none; margin: 0; padding: 0; position: relative; }
.sb-stop { position: relative; display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: 10px; padding: 6px 0; align-items: start; }
.sb-stop::before { content: ''; position: absolute; left: 18px; top: 0; bottom: 0; width: 2px; background: rgba(169,199,216,0.22); }
.sb-stop:first-child::before { top: 22px; } .sb-stop:last-child::before { bottom: calc(100% - 22px); }
.sb-node { position: relative; z-index: 1; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center;
  background: #121816; border: 2px solid rgba(169,199,216,0.55); color: #a9c7d8; }
.sb-stop-body { padding: 4px 8px; border-radius: 10px; border: 1px solid transparent; }
.sb-stop-who { font-size: 16px; font-weight: 600; }
.sb-stop-who small { font-weight: 400; color: #93a19a; font-size: 13px; margin-left: 6px; }
.sb-stop-meta { font-size: 13.5px; color: #93a19a; margin-top: 1px; }
.sb-stop-kg { text-align: right; padding-top: 4px; }
.sb-stop-kg b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
.sb-stop-kg span { font-size: 12.5px; color: #93a19a; font-variant-numeric: tabular-nums; }
.sb-stop.sb-bad .sb-node { border-color: #de8a76; color: #de8a76; background: rgba(222,138,118,0.15); }
.sb-stop.sb-bad .sb-stop-body { background: rgba(222,138,118,0.12); border-color: rgba(222,138,118,0.5); }
.sb-stop.sb-bad .sb-stop-kg span { color: #de8a76; font-weight: 700; }
.sb-stop-note { font-size: 15px; font-weight: 700; color: #de8a76; margin-top: 3px; }
.sb-tail { margin: 8px 0 0 48px; font-size: 15px; padding: 8px 10px; border-radius: 10px; }
.sb-tail.sb-ok { color: #7fc2a6; background: rgba(127,194,166,0.08); }
.sb-tail.sb-bad { color: #de8a76; background: rgba(222,138,118,0.12); font-weight: 700; }
.sb-tail.sb-dim { color: #93a19a; }
.sb-auditor-btn { position: absolute; left: 364px; bottom: 16px; z-index: 11; display: inline-flex !important; align-items: center; gap: 8px;
  font-size: 15px !important; font-weight: 600; padding: 9px 14px !important; color: #a9c7d8 !important;
  background: rgba(16,22,20,0.82) !important; border: 1px solid rgba(169,199,216,0.45) !important; border-radius: 10px !important;
  backdrop-filter: blur(10px); cursor: pointer; pointer-events: auto; font-family: Inter, system-ui, sans-serif; }

/* ---------- before / after card ---------- */
.sb-ba { position: absolute; inset: 0; z-index: 30; display: grid; place-items: center; padding: 24px;
  background: rgba(8,11,10,0.58); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.sb-ba-card { width: min(1120px, 100%); max-height: 100%; overflow-y: auto; border-radius: 16px; padding: 22px 26px 24px;
  background: rgba(16,22,20,0.94); border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 16px 50px rgba(0,0,0,0.5); }
.sb-ba-top { display: flex; align-items: flex-start; gap: 12px; }
.sb-ba-top .sb-space { flex: 1; }
.sb-ba-kicker { font-size: 13px; text-transform: uppercase; letter-spacing: 0.12em; color: #93a19a; }
.sb-ba-title { font-size: 32px; font-weight: 700; margin: 2px 0 0; }
.sb-ba-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 16px; }
.sb-ba-side { border-radius: 14px; padding: 18px 20px; border: 1px solid; }
.sb-ba-side.sb-today { border-color: rgba(212,160,94,0.38); background: rgba(212,160,94,0.05); }
.sb-ba-side.sb-runners { border-color: rgba(127,194,166,0.42); background: rgba(127,194,166,0.06); }
.sb-ba-head { display: flex; align-items: center; gap: 14px; }
.sb-ba-head h3 { margin: 0; font-size: 26px; }
.sb-ba-head p { margin: 2px 0 0; color: #93a19a; font-size: 15px; }
.sb-today .sb-ba-head .sb-icon, .sb-today h3 { color: #d4a05e; }
.sb-runners .sb-ba-head .sb-icon, .sb-runners h3 { color: #7fc2a6; }
.sb-ba-lines { list-style: none; margin: 14px 0 0; padding: 0; }
.sb-ba-lines li { display: flex; gap: 10px; align-items: flex-start; font-size: 20px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.07); }
.sb-today .sb-ba-lines .sb-icon { color: #d4a05e; margin-top: 3px; }
.sb-runners .sb-ba-lines .sb-icon { color: #7fc2a6; margin-top: 3px; }
.sb-ba-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.sb-ba-stat { border-radius: 10px; padding: 8px 10px; background: rgba(0,0,0,0.2); }
.sb-ba-stat b { display: block; font-size: 38px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.sb-ba-stat span { font-size: 14px; color: #93a19a; }
.sb-ba-foot { margin-top: 12px; font-size: 13px; color: #93a19a; }

@media (max-width: 1280px) {
  .sb-bb { right: 344px; width: 380px; }
  .sb-bb-next { font-size: 23px; }
  .sb-auditor-btn { left: 314px; }
  .sb-gb-detail { grid-template-columns: minmax(0, 1fr); }
  .sb-gb-detail > div { overflow: visible; } .sb-gb-detail { overflow-y: auto; }
  .sb-gb-detail > div + div { border-left: 0; border-top: 1px solid rgba(255,255,255,0.08); }
  .sb-gb-summary { grid-template-columns: minmax(0, 1fr); }
}
`;

let injected = false;
export function injectStoryStyles(): void {
  if (injected || typeof document === 'undefined') return;
  const s = document.createElement('style');
  s.dataset.rn = 'story';
  s.textContent = CSS;
  document.head.appendChild(s);
  injected = true;
}
