// WP6 entry: createUI(root, handlers) builds the UI over the map and returns the UiApi.
//
// Minimal by default. On the map:
//   top left    wordmark          top centre  page switch (Simulation | Compare with today)
//   top right   tool chip (only when a tool other than Select is armed), NETWORK DOWN/UP pill, panels button
//   bottom      the lead's playback bar (.pb), one line of key numbers per side just above it
// Everything else lives in ONE right sidebar, closed by default (Tab or \ toggles it): tools, numbers table,
// Leak Finder, numbers table, reach chart, inspector, Attack Console, incident feed (.tf), ledger, the other run's minimap.
// Breach result and sweep chart open as centred cards. Esc closes everything. H hides all UI.
import type { BreachDump, LedgerReport, Mode, NodeId, NodeKind, Snapshot, Tool, UiApi, UiHandlers } from '../contracts/types';
import { createAttackConsole } from './attackConsole';
import { createBreachCard } from './breachCard';
import { createSweepCard } from './charts';
import { createControls, TOOLS } from './controls';
import { el, injectStyles, panel } from './dom';
import { exposure, SKIM_DEFAULT_KG } from './format';
import { createInspector } from './inspector';
import { createLeakFinder } from './leakFinder';
import { createLedgerView } from './ledgerView';
import { createMetrics } from './metrics';
import { createMinimap } from './minimap';
import { createShell, kbd, typing } from './shell';
import { createStrip } from './strip';

const METRICS_EVERY_MS = 200;   // DOM + chart redraw budget; snapshots can arrive 100+ times a second at 60x
const MINIMAP_EVERY_MS = 66;
const LEAK_POPUP_MS = 8000;     // a new loss opens the sidebar at the Leak Finder for this long

export interface Ui extends UiApi {
  /** kg the presenter typed for the skim tool; the lead reads it when the skim tool hits a carrier. */
  skimKg(): number;
  /** Keep the toolbar in sync when the lead changes tool or mode from a keyboard shortcut or the demo script. */
  setTool(t: Tool): void;
  setMode(m: Mode | 'split'): void;
}

// Section ids and their keys: T tools, M numbers, I inspector, L leak finder, A attack console, F incident feed.
const SECTION_KEYS: Record<string, string> = { t: 'tools', m: 'numbers', i: 'inspector', l: 'leaks', a: 'attacks', f: 'incidents' };

export function createUI(root: HTMLElement, h: UiHandlers): Ui {
  injectStyles();
  root.classList.add('rn-host');
  const ui = el('div', 'rn-app');   // not 'rn-root': main.ts has stopgap CSS keyed on that name
  document.documentElement.classList.add('rn-ready');
  root.append(ui);

  const metrics = createMetrics();
  const minimap = createMinimap();
  const inspector = createInspector();
  const leaks = createLeakFinder(h);
  const attacks = createAttackConsole(h);
  const breach = createBreachCard();
  const ledger = createLedgerView(h);
  const sweep = createSweepCard();
  const strip = createStrip();

  // Reset wipes the UI's own history too, then tells the lead.
  const clearAll = () => { metrics.reset(); leaks.reset(); attacks.reset(); inspector.show(null); strip.reset(); paintBadge(); };
  const controls = createControls({ ...h, onReset: () => { clearAll(); h.onReset(); } }, SKIM_DEFAULT_KG);

  // ---------- on the map ----------
  const shell = createShell(root, ui);
  const toolChip = el('button', 'rn-chip rn-glass rn-hidden');
  toolChip.dataset.tip = 'Click to go back to Select';
  toolChip.addEventListener('click', () => { controls.setTool('select'); h.onTool('select'); });
  shell.cluster.prepend(toolChip, controls.net);
  ui.append(controls.switcher, strip.root, breach.root, sweep.root);

  // ---------- the sidebar, top to bottom ----------
  const actions = el('div', 'rn-actions');           // the auditor's glass box button lands here
  const tools = panel('Tools');
  tools.body.append(controls.root);
  const [numbersRoot, chartRoot] = metrics.roots;
  shell.addSection('actions', actions);
  shell.addSection('tools', tools.root);
  shell.addSection('leaks', leaks.root);          // high up: a new loss opens the sidebar right here
  shell.addSection('numbers', numbersRoot);
  shell.addSection('chart', chartRoot);
  shell.addSection('inspector', inspector.root);
  shell.addSection('attacks', attacks.root);
  shell.addSection('ledger', ledger.root);
  shell.addSection('other', minimap.root);
  attacks.root.classList.add('rn-collapsed');
  minimap.root.classList.add('rn-collapsed');

  // Panels other files mount straight into the root: adopt them into this layout instead of letting them float.
  const adopt = () => {
    const tf = root.querySelector<HTMLElement>(':scope > .tf');
    if (tf) {
      shell.addSection('incidents', tf, ledger.root);
      tf.querySelector('h3')?.addEventListener('click', () => tf.classList.toggle('rn-collapsed'));
    }
    const auditor = root.querySelector<HTMLElement>(':scope > .sb-auditor-btn');
    if (auditor) { actions.append(auditor); auditor.title = 'Auditor: open the glass box (G)'; }
    controls.root.querySelector('.rn-own-play')?.classList.toggle('rn-hidden', !!document.querySelector('.pb'));
    actions.classList.toggle('rn-hidden', !actions.childElementCount);
  };
  adopt();
  new MutationObserver(adopt).observe(root, { childList: true });

  // ---------- tool chip, badge ----------
  const paintChip = () => {
    const t = controls.tool();
    toolChip.classList.toggle('rn-hidden', t === 'select');
    if (t !== 'select') toolChip.replaceChildren('Tool', el('b', '', TOOLS.find((x) => x.tool === t)?.label ?? t));
  };
  controls.onChange(() => { paintChip(); strip.setSplit(controls.mode() === 'split'); });
  const badge = shell.sideButton.querySelector('.rn-badge') as HTMLElement;
  function paintBadge(): void { const n = leaks.count(); badge.textContent = n ? String(n) : ''; }

  // ---------- keyboard ----------
  const auditorButton = () => actions.querySelector<HTMLButtonElement>('.sb-auditor-btn');
  const help = () => shell.toast([kbd('Tab'), 'panels', kbd('Space'), 'play', kbd('S'), 'sweep', kbd('G'), 'glass box',
    kbd('H'), 'hide UI', kbd('Esc'), 'close'], 6000);
  const closeStory = () => {
    // Story views (black box, glass box, before/after) close through their own buttons so their own state stays right.
    root.querySelectorAll<HTMLElement>('.sb-bb:not(.sb-hidden):not(.sb-inline), .sb-gb:not(.sb-hidden), .sb-ba:not(.sb-hidden)').forEach((v) => {
      const b = [...v.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Close');
      b?.click();
    });
  };
  let lastKeySection = '';
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    const k = e.key;
    if (k === 'Tab' || k === '\\') { e.preventDefault(); shell.toggle(); lastKeySection = ''; return; }
    if (k === 'Escape') {
      breach.root.classList.add('rn-hidden');
      sweep.root.classList.add('rn-hidden');
      closeStory();
      shell.close();
      return;
    }
    if (e.repeat) return;
    const lower = k.toLowerCase();
    const sec = SECTION_KEYS[lower];
    if (sec) {
      e.preventDefault();
      if (shell.isOpen() && lastKeySection === sec) { shell.close(); lastKeySection = ''; return; }
      shell.focus(sec);
      lastKeySection = sec;
      return;
    }
    if (lower === 'h') {
      const off = !shell.hidden();
      shell.setHidden(off);
      if (off) shell.toast(['UI hidden. Press', kbd('H'), 'to show it'], 2500);
      else shell.toastEl.classList.remove('rn-on');
      return;
    }
    if (lower === 'g') { auditorButton()?.click(); return; }
    if (k === '?') help();
  });
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  if (!q?.get('autoplay') && !q?.get('demo')) setTimeout(help, 1200);

  // ---------- drawing: latest data, one redraw per frame budget ----------
  let main: Snapshot | null = null;
  let other: Snapshot | undefined;
  let lastT = -Infinity;
  let dirty = false;
  let miniDirty = false;
  let lastMetricsAt = 0;
  let lastMiniAt = 0;
  let sweepData: unknown = null;
  shell.onOpenChange((on) => { if (on) { dirty = true; miniDirty = !!other; } });

  const frame = (now: number) => {
    if (dirty && main && now - lastMetricsAt >= METRICS_EVERY_MS) {
      strip.render();
      controls.sync(main.t, main.cellNetworkUp);
      if (shell.isOpen()) metrics.render();   // the table and chart only cost anything when someone can see them
      lastMetricsAt = now;
      dirty = false;
    }
    if (miniDirty && other && shell.isOpen() && !minimap.root.classList.contains('rn-collapsed') && now - lastMiniAt >= MINIMAP_EVERY_MS) {
      minimap.draw(other);
      lastMiniAt = now;
      miniDirty = false;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return {
    update(m: Snapshot, o?: Snapshot) {
      if (m.t < lastT) clearAll();      // engine was reset from elsewhere
      lastT = m.t;
      main = m;
      other = o;
      metrics.update(m, o);
      strip.update(m, o);
      // Alerts must never be dropped by throttling, so they go straight in.
      // Only the main run feeds the lists: both runs share a seed, so their box ids collide.
      const fresh = leaks.addAlerts(m.newAlerts);
      attacks.addAlerts(m.newAlerts);
      if (fresh) {
        paintBadge();
        const glassOpen = !!root.querySelector('.sb-gb:not(.sb-hidden)');
        if (!shell.hidden() && !glassOpen) shell.focus('leaks', { auto: true, ms: LEAK_POPUP_MS });
      }
      minimap.setVisible(!!o);
      dirty = true;
      miniDirty = !!o;
    },
    showInspect(info: { id: NodeId; kind: NodeKind; dump: BreachDump; logs: string[] } | null) {
      inspector.show(info);
    },
    showBreach(mesh: BreachDump | null, central: BreachDump | null) {
      sweep.root.classList.add('rn-hidden');
      breach.show(mesh, central);
      if (mesh) strip.setExposure('mesh', exposure(mesh).score);
      if (central) strip.setExposure('central', exposure(central).score);
      dirty = true;
    },
    showLedger(r: LedgerReport) {
      ledger.show(r);
      leaks.addFindings(r.findings);
      paintBadge();
      shell.focus('ledger');
    },
    showSweep(data: unknown) {
      // The lead calls this from the S key: a second press with the card up closes it.
      const open = !sweep.root.classList.contains('rn-hidden');
      if (open && data === sweepData) { sweep.root.classList.add('rn-hidden'); return; }
      sweepData = data;
      breach.root.classList.add('rn-hidden');
      sweep.show(data);
    },
    showAttackResult(line: string) {
      attacks.showResult(line);
    },
    skimKg: () => controls.skimKg(),
    setTool: (t) => controls.setTool(t),
    setMode: (m) => controls.setMode(m),
  };
}
