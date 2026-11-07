// LEAD integration. Two simulations of the same district, same seed, same incidents:
//   left  = "Today": a central dispatch server (every device holds the full picture)
//   right = "Runners": the mesh of black boxes
// URL params: ?mode=split|mesh|central  ?speed=20  ?seed=7  ?autoplay=1  ?threats=demo|low|high|off
// Dev pages: ?dev=render  ?dev=ui  ?dev=models  ?dev=intro
import { DEMO_SEED, TICK_DT, WARMUP_SEC } from './contracts/config';
import type { EngineApi, Mode, NodeId, Snapshot, Tool, WorldEvent } from './contracts/types';
import { meshFactories } from './agents';
import { centralFactories } from './baseline';
import { createEngine } from './sim/engine';
import { createWorld } from './sim/map';
import { createAdversary, type Adversary, type Intensity } from './sim/adversary';
import { createReporting, type Reporting } from './sim/reporting';
import { createRenderer, type Renderer } from './render';
import { createCameraLink } from './render/scene';
import { createUI, type Ui } from './ui';
import { createThreatFeed } from './ui/threatFeed';
import { createPlayback } from './ui/playback';
import { buildReport } from './ledger';
import { createBlackBoxView } from './ui/blackbox';
import { createAuditorButton, createGlassBoxView } from './ui/glassbox';
import type { SealedBox } from './contracts/types';

const q = new URLSearchParams(location.search);
const root = document.getElementById('app')!;
const uiRoot = document.getElementById('ui')!;

type Side = { mode: Mode; engine: EngineApi; renderer: Renderer | null; canvas: HTMLCanvasElement | null;
  last: Snapshot | null; adversary: Adversary; reporting: Reporting };

// Optional pages: glob only matches files that exist, so a missing module never breaks the build.
const optional = import.meta.glob(['./render/models/preview.ts', './intro/preview.ts']);

async function devPage(dev: string) {
  if (dev === 'render') return (await import('./render/dev')).mountDev(root);
  if (dev === 'ui') return (await import('./ui/dev')).mountDev(root);
  const path = dev === 'models' ? './render/models/preview.ts' : dev === 'intro' ? './intro/preview.ts' : '';
  const load = optional[path];
  if (!load) return (uiRoot.textContent = `${dev} preview is not built yet`);
  const mod = (await load()) as Record<string, (r: HTMLElement) => void>;
  return (mod.mountModelsPreview ?? mod.mountIntroPreview)(root);
}

async function boot() {
  const dev = q.get('dev');
  if (dev) return devPage(dev);

  const seed = Number(q.get('seed') ?? DEMO_SEED);
  let layout: Mode | 'split' = (q.get('mode') as Mode | 'split') ?? (q.get('autoplay') || q.get('demo') ? 'split' : 'mesh');   // main page: Runners on one map; 'split' = compare page
  let speed = Number(q.get('speed') ?? 20);                     // sim seconds per real second
  const intensity = (q.get('threats') as Intensity) ?? 'demo';
  const world = createWorld();
  // The renderer draws the sim's own roads and villages so movement lines up with the map.
  // (Water comes from the renderer's own geography until the real-map renderer lands.)
  const renderWorld = {
    roads: world.roadSegments.map(([a, b]) => [a, b]),
    villages: world.villages.map((v) => ({ name: v.name, pos: v.pos })),
  };

  const mainCanvas = document.getElementById('scene') as HTMLCanvasElement;
  let sides: Side[] = [];
  let tool: Tool = 'select';
  let paused = false;
  let pendingAttackLine = false;
  let pendingLedger = false;

  // The UI (src/ui/shell.ts) owns the sidebar, page switch and network pill; it starts with the sidebar closed.
  const feed = createThreatFeed(uiRoot);
  const ui: Ui = createUI(uiRoot, {
    onEvent: (ev) => applyAll(ev),
    onTool: (t) => { tool = t; sides.forEach((s) => s.renderer?.setTool(t)); },
    onMode: (m) => { layout = m; void relayout(); },
    onSpeed: (x) => { speed = x; playback?.setSpeed(x); },
    onReset: () => { void rebuild(); },
    onFindingClick: (f) => { sides.forEach((s) => { s.renderer?.highlight([f.holder]); s.renderer?.focus(f.holder); }); if (glassBox.isOpen()) glassBox.focus(f.packageId); },
  });

  // The story views: black box = what a crew sees in the vehicle; glass box = what an auditor sees.
  const blackBox = createBlackBoxView(uiRoot);
  const glassBox = createGlassBoxView(uiRoot);
  let selected: { id: NodeId; side: Side } | null = null;

  // Playback: play/pause, speed presets up to 300x, skip ahead an hour, reset. The director owns keys in demo mode.
  const demoMode = !!(q.get('autoplay') || q.get('demo'));
  const playback = createPlayback(uiRoot, {
    onPlayPause: (p) => { paused = !p; },
    onSpeed: (x) => { speed = x; },
    onSkip: (sec) => { void skipAhead(sec); },
    onReset: () => { void rebuild(); },
  }, { speed, playing: true, keys: !demoMode });
  const sealedBoxes = (e: EngineApi) =>
    [...((e as unknown as { boxes?: Map<string, { cb: { box: SealedBox } }> }).boxes?.values() ?? [])].map((b) => b.cb).filter(Boolean);
  createAuditorButton(uiRoot, async () => {
    const mesh = sides.find((x) => x.mode === 'mesh') ?? sides[0];
    const input = mesh.engine.ledgerInput();
    const report = await buildReport(input, mesh.last?.nodes);
    await glassBox.open({ report, receipts: input.receipts, boxes: sealedBoxes(mesh.engine) as never,
      auditorSealPriv: mesh.engine.auditorSealPriv(), signPubs: input.signPubs } as never);
  });

  function applyAll(ev: WorldEvent) {
    for (const s of sides) s.engine.apply(ev);
    if (ev.type === 'networkUp') pendingLedger = true;
    // Attack-console events report through the engine's 'attack-console' log lines (forwarded every tick below);
    // physical incidents (skim, steal, breakdown, breach, raid) show the first alert or world line they cause.
    if (['skim', 'steal', 'breakdown', 'breach', 'raid'].includes(ev.type)) pendingAttackLine = true;
  }

  // Each view lives in its own positioned frame so its 3D labels line up with its own canvas.
  function frameFor(i: number, split: boolean): HTMLDivElement {
    let f = document.getElementById(`side-${i}`) as HTMLDivElement | null;
    if (!f) { f = document.createElement('div'); f.id = `side-${i}`; root.insertBefore(f, uiRoot); }
    f.style.cssText = split
      ? `position:absolute;top:0;bottom:0;width:50%;left:${i === 0 ? '0' : '50%'};overflow:hidden;${i === 0 ? 'box-shadow:inset -2px 0 0 rgba(0,0,0,.45);' : ''}`
      : 'position:absolute;inset:0;overflow:hidden;';
    return f;
  }

  function layoutCanvases() {
    const split = sides.filter((s) => s.canvas).length === 2;
    document.querySelectorAll('.side-tag').forEach((e) => e.remove());
    if (!split) document.getElementById('side-1')?.remove();
    sides.forEach((s, i) => {
      if (!s.canvas) return;
      const f = frameFor(i, split);
      if (s.canvas && s.canvas.parentElement !== f) f.appendChild(s.canvas);
      if (s.canvas) s.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
      if (!split) return;
      const tag = document.createElement('div');
      tag.className = 'side-tag';
      tag.textContent = s.mode === 'central' ? 'TODAY: central dispatch' : 'RUNNERS: black box in every vehicle';
      tag.style.cssText = `position:absolute;top:64px;left:16px;padding:6px 12px;border-radius:8px;z-index:5;pointer-events:none;
        background:${s.mode === 'central' ? 'rgba(120,70,30,.88)' : 'rgba(20,90,80,.88)'};color:#fff;font:600 14px system-ui;letter-spacing:.04em`;
      f.appendChild(tag);
    });
    window.dispatchEvent(new Event('resize'));
  }

  function wireRenderer(s: Side) {
    const r = s.renderer!;
    r.setTool(tool);
    r.onSelect((id) => showInspect(id, s));
    r.onNodeClick((id, t) => onNodeTool(id, t, s));
    r.onZoneDraw((pos, radius) => applyAll({ type: 'deadZone', pos, radius }));
    // A plain click (no drag) with the storm tool drops a default-size dead zone.
    r.onGroundClick((pos, t) => { if (t === 'deadZone') applyAll({ type: 'deadZone', pos, radius: 2000 }); });
  }

  function showInspect(id: NodeId | null, side?: Side) {
    const s = side ?? sides.find((x) => x.mode === 'mesh') ?? sides[0];
    selected = id ? { id, side: s } : null;
    refreshSelected();
  }

  function refreshSelected() {
    if (!selected) { ui.showInspect(null); blackBox.show(null); return; }
    const { id, side } = selected;
    const info = side.engine.inspect(id);
    ui.showInspect(info ? { id, ...info } : null);
    const node = side.last?.nodes.find((n) => n.id === id);
    blackBox.show(info ? { id, ...info, pos: node?.pos, t: side.last?.t } as never : null);
  }

  function onNodeTool(id: NodeId, t: Tool, side?: Side) {
    if (t === 'select') return showInspect(id, side);
    if (t === 'skim') return applyAll({ type: 'skim', target: id, kg: ui.skimKg() });
    if (t === 'steal' || t === 'breakdown') return applyAll({ type: t, target: id });
    if (t === 'breach') {
      applyAll({ type: 'breach', target: id });
      const m = sides.find((x) => x.mode === 'mesh')?.engine.inspect(id)?.dump ?? null;
      const c = sides.find((x) => x.mode === 'central')?.engine.inspect(id)?.dump ?? null;
      ui.showBreach(m, c);
    }
  }

  // rebuild(): fresh engines from the seed (reset). relayout(): switch Simulation / Compare without
  // touching the running engines, so changing page never restarts the story.
  async function rebuild(reset = true) {
    sides.forEach((s) => { s.renderer?.dispose(); s.renderer = null; if (s.canvas && s.canvas !== mainCanvas) s.canvas.remove(); s.canvas = null; });
    const order: Mode[] = layout === 'split' || layout === 'central' ? ['central', 'mesh'] : ['mesh', 'central'];
    if (reset || sides.length !== 2) {
      sides = await Promise.all(order.map(async (mode) => {
        const engine = await createEngine({ seed, mode, factories: mode === 'mesh' ? meshFactories : centralFactories, warmupSec: WARMUP_SEC });
        return { mode, engine, canvas: null, renderer: null, last: null,
          adversary: createAdversary({ seed, intensity }), reporting: createReporting() } as Side;
      }));
    } else {
      sides = order.map((m) => sides.find((x) => x.mode === m)!);
    }
    // Both systems always run on the same seed so the numbers compare; only the visible ones get a 3D view.
    const shown = (i: number) => layout === 'split' || i === 0;
    sides.forEach((s, i) => { s.canvas = i === 0 ? mainCanvas : shown(i) ? document.createElement('canvas') : null; });
    const link = layout === 'split' ? createCameraLink() : undefined;
    layoutCanvases();
    for (const s of sides) { if (!s.canvas) continue; s.renderer = createRenderer(s.canvas, { seed, world: renderWorld, map: 'hawassa', baseLayer: 'sat', cameraLink: link, lowPower: layout === 'split', coverage: (world as unknown as { coverage?: { pos: { x: number; y: number }; radius: number }[] }).coverage }); wireRenderer(s); }
    drawnT = -1;
    ui.setMode(layout);
  }
  const relayout = () => rebuild(false);

  // One sim tick on every side: engines step together, incidents and reports follow, the UI hears every tick.
  async function tickOnce() {
    const snaps = await Promise.all(sides.map((s) => s.engine.step()));
    snaps.forEach((snap, i) => {
      const s = sides[i];
      s.last = snap;
      const threats = s.adversary.step(snap, s.engine);
      const reports = s.reporting.step(snap);
      if (s.mode === 'mesh' || sides.length === 1) feed.update(threats, reports, s.reporting.pending());
    });
    const mesh = sides.find((s) => s.mode === 'mesh')?.last ?? sides[0].last!;
    const other = sides.length === 2 ? sides.find((s) => s.mode === 'central')!.last! : undefined;
    ui.update(mesh, other);
    for (const l of mesh.newLogs) if (l.id === 'attack-console') ui.showAttackResult(l.text);
    if (pendingAttackLine) {
      const line = mesh.newAlerts[0]?.text ?? mesh.newLogs.find((l) => l.id === 'world')?.text;
      if (line) { ui.showAttackResult(line); pendingAttackLine = false; }
    }
  }

  // Fast-forward without drawing every frame, yielding now and then so the page stays responsive.
  let skipping = false;
  async function skipAhead(sec: number) {
    if (skipping) return;
    skipping = true;
    const wasPaused = paused;
    paused = true;
    try {
      const ticks = Math.round(sec / TICK_DT);
      for (let k = 0; k < ticks; k++) {
        await tickOnce();
        if (k % 200 === 0) { playback.setTime(sides[0]?.last?.t ?? 0); await new Promise((r) => setTimeout(r, 0)); }
      }
      for (const s of sides) if (s.last) s.renderer?.update(s.last);
      playback.setTime(sides[0]?.last?.t ?? 0);
    } finally {
      paused = wasPaused;
      skipping = false;
    }
  }

  // ---------- main loop ----------
  // The simulation runs on its own timer, so the chosen speed holds even when the 3D views draw slowly.
  // Drawing happens on animation frames and only when a side has a new snapshot.
  let ticksDue = 0;
  let busy = false;
  let lastSim = performance.now();
  let drawnT = -1;
  async function simLoop() {
    const now = performance.now();
    const dt = Math.min(0.5, (now - lastSim) / 1000);
    lastSim = now;
    if (busy || paused || skipping || !sides.length) return;
    ticksDue = Math.min(ticksDue + (dt * speed) / TICK_DT, 2400);  // never build an endless backlog
    if (ticksDue < 1) return;
    busy = true;
    try {
      const budgetEnd = performance.now() + 12;
      while (ticksDue >= 1 && performance.now() < budgetEnd) {
        ticksDue -= 1;
        await tickOnce();
      }
      if (pendingLedger) {
        pendingLedger = false;
        const mesh = sides.find((s) => s.mode === 'mesh') ?? sides[0];
        ui.showLedger(await buildReport(mesh.engine.ledgerInput(), mesh.last?.nodes));
      }
    } finally {
      busy = false;
    }
  }
  setInterval(() => { void simLoop(); }, 16);

  function frame() {
    requestAnimationFrame(frame);
    const t = sides[0]?.last?.t ?? -1;
    if (t === drawnT) return;
    drawnT = t;
    for (const s of sides) if (s.last) s.renderer?.update(s.last);
    playback.setTime(t);
    if (selected) refreshSelected();
  }

  await rebuild();
  // Console / director hook: runners.select('moto-04', 'mesh')
  (window as unknown as { runners: unknown }).runners = {
    select: (id: NodeId, mode: Mode = 'mesh') => showInspect(id, sides.find((x) => x.mode === mode)),
    sides: () => sides,
  };
  // The comparison chart opens on demand (S key, or the director at the end), never on load.
  let sweep: unknown = null;
  fetch('/sweep.json').then((r) => (r.ok ? r.json() : null)).then((d) => { sweep = d; }).catch(() => {});
  window.addEventListener('keydown', (e) => {
    if ((e.key === 's' || e.key === 'S') && sweep && !(e.target instanceof HTMLInputElement)) ui.showSweep(sweep);
  });
  requestAnimationFrame(frame);

  // The intro gets its own canvas on top: two three.js renderers must never share one WebGL context.
  const introCanvas = document.createElement('canvas');
  introCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:4;display:none';
  root.appendChild(introCanvas);
  if (q.get('intro') && !q.get('autoplay')) {
    introCanvas.style.display = 'block';
    const { playIntro } = await import('./intro');
    playIntro(introCanvas, { onDone: () => introCanvas.remove() });
  }

  if (q.get('autoplay') || q.get('demo')) {
    const { createDirector } = await import('./demo/director');
    const director = createDirector({
      engines: () => sides.map((s) => s.engine),
      getSnapshot: (i: number) => sides[i]?.last,
      renderers: Object.fromEntries(sides.map((s) => [s.mode, s.renderer])) as never,
      ui,
      onSpeed: (x: number) => { speed = x; playback.setSpeed(x); },
      onPause: (p: boolean) => { paused = p; playback.setPlaying(!p); },
      onReset: () => rebuild(),
      introCanvas,
      // Show the intro canvas only while the fly-in plays, then hand over to the live maps.
      playIntro: (async (c: HTMLCanvasElement, o: Record<string, unknown>) => {
        c.style.display = 'block';
        const { playIntro } = await import('./intro');
        const onDone = o.onDone as (() => void) | undefined;
        return playIntro(c, { ...o, onDone: () => { c.style.display = 'none'; onDone?.(); } });
      }) as never,
    });
    (window as unknown as { director: unknown }).director = director;
    if (q.get('autoplay') === '1') director.start();     // ?demo=1 waits for Space
  }
}

boot();
