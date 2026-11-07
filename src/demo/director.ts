// Auto-play demo director: plays the 3-minute stage demo on a real-time clock, on the real Hawassa map.
// Story (PLAN section 1, "The change we are making"): today's paperwork gives everything away and a theft
// goes unnoticed; Runners' black box tells the crew only the next step, catches the skim at the next
// hand-off, leaks nothing when stolen, keeps delivering with the network down, and the auditor's glass
// box shows the chain of custody. demo/claims-to-proof.md maps every claim to the beat that shows it.
//
// The director only fires WorldEvents (EngineApi.apply, mirrored to every run with one sim time) and moves
// the camera. It reads EngineApi.inspect / ledgerInput for live numbers. Routes come from the sim.
// Targets (which van, which vehicle) are picked from the latest Snapshot when the beat fires.
//
// Keys: Space = pause / resume (starts if idle), Right arrow = next beat now, R = reset.
// The last beat logs 'DEMO_DONE' (scripts/record-demo.mjs waits for it).
import { TICK_DT } from '../contracts/config';
import type {
  Alert, BreachDump, EngineApi, LedgerReport, Mode, NodeId, NodeState, Receipt, Snapshot, Tool, UiApi, Vec2, WorldEvent,
} from '../contracts/types';
import { exposure } from '../privacy/breach';
import { CAPTIONS } from './captions';
import { createChainCard, createClipboardCard, createScoreboard, type DemoCard, type ChainData, type ClipboardData, type ScoreData, type ScoreSide } from './cards';
import { findOptional, findView, type AnyFn, type ViewLike } from './optional';
import { createCaptionOverlay, type CaptionOverlay } from './overlay';

// ---------- public types ----------

/** Any renderer. Every method is optional and only called if it exists. */
export interface RendererLike {
  focusOn?(id: NodeId): void;
  focus?(id: NodeId): void;                       // WP5 renderer extra (glide camera to a node)
  flyTo?(pos: Vec2, zoom?: number): void;         // zoom: ZOOM_WIDE = whole district, ZOOM_CLOSE = one vehicle
  highlight?(ids: NodeId[]): void;
}

/** UiApi plus the optional extras the WP6 Ui exposes. */
export type UiLike = UiApi & { setTool?(t: Tool): void; setMode?(m: Mode | 'split'): void; closePanels?(): void };

/** What src/ui/blackbox.ts's view.show() takes (id, kind, dump, logs, pos, t), plus the engine and snapshot. */
export interface BlackBoxInfo { id: NodeId; kind: NodeState['kind']; dump: BreachDump; logs: string[]; pos?: Vec2; t?: number; engine: EngineApi; snapshot: Snapshot | null }
export interface GlassBoxInfo { packageId: string; receipts: Receipt[]; leak: Alert | null; report: LedgerReport | null; engine: EngineApi }

export interface DirectorOptions {
  engines: EngineApi[] | (() => EngineApi[]);     // 1 or 2; a function if main.ts rebuilds engines on reset
  getSnapshot?: (engineIndex: number) => Snapshot | null | undefined;   // latest snapshot of engines[i]
  renderer?: RendererLike | RendererLike[];       // camera moves go to all of these...
  renderers?: Partial<Record<Mode, RendererLike>>; // ...unless a per-side renderer is given
  ui?: UiLike;
  onCaption?: (text: string) => void;             // given: called instead of the built-in overlay
  onSpeed?: (x: number) => void;                  // given: each beat sets its suggested sim speed
  onPause?: (paused: boolean) => void;            // given: pause / resume the sim with the director
  onReset?: () => void | Promise<void>;           // given: R also resets the engines to the seed
  onDone?: () => void;
  introCanvas?: HTMLCanvasElement;                // for playIntro; default #scene
  playIntro?: AnyFn;                              // default: src/intro/* playIntro, if it exists
  showBlackBox?: (info: BlackBoxInfo | null) => void;  // default: a view from src/ui/blackbox.ts createBlackBoxView, else the inspector
  showGlassBox?: (info: GlassBoxInfo | null) => void;  // default: src/ui/glassbox.ts if it exists, else our chain card
  viewParent?: HTMLElement;                       // where auto-built black/glass box views mount; default #ui
  buildReport?: (engine: EngineApi, nodes?: NodeState[]) => Promise<LedgerReport>;  // default: WP4 buildReport
  cards?: boolean;                                // default true in a browser: clipboard, chain, scoreboard
  keys?: boolean;                                 // default true in a browser
  now?: () => number;                             // ms clock, for tests
  pollMs?: number;                                // clock resolution, default 100 ms
  log?: (line: string) => void;                   // default console.log; receives 'DEMO_DONE'
}

export interface Beat {
  id: string;
  atSec: number;                                  // real seconds from start()
  caption: string;                                // default caption; live beats write their own
  speed?: number;                                 // suggested sim speed while this beat plays
  live?: boolean;                                 // true: the action writes the caption
  holdSec?: number;                               // if the action is still running at the next beat, wait up to this long
  action(): void | Promise<unknown>;
}

export interface DirectorState { index: number; elapsedSec: number; started: boolean; paused: boolean; done: boolean }

export interface Director {
  start(): void;                                  // start, or resume if paused
  pause(): void;
  resume(): void;
  toggle(): void;                                 // what Space does
  next(): void;                                   // fire the next beat now; later beats keep their spacing
  reset(): void;                                  // back to beat 0, idle; calls onReset
  dispose(): void;
  state(): DirectorState;
  readonly timeline: Beat[];
}

// ---------- tunables ----------

export const DEMO_DONE = 'DEMO_DONE';
export const SKIM_KG = 1.2;
export const ZOOM_WIDE = 1;
export const ZOOM_CLOSE = 4;
const FOLLOW_EVERY_MS = 1000;                     // black box / inspector refresh for the vehicle we follow
const WATCH_EVERY_MS = 500;                       // Leak Finder poll

// ---------- pure helpers (unit tested) ----------

const alive = (s: Snapshot | null | undefined) => (s?.nodes ?? []).filter((n) => n.alive && !n.fake);
const kindOf = (s: Snapshot | null | undefined, id: NodeId) => s?.nodes.find((n) => n.id === id)?.kind;
const isRider = (k: string | undefined) => k === 'motorbike' || k === 'boat' || k === 'drone';
const byLoadThenId = (a: NodeState, b: NodeState) => b.boxes.length - a.boxes.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const loadedIn = (s: Snapshot | null | undefined, id: NodeId) => alive(s).some((n) => n.id === id && n.boxes.length > 0);

/** The most loaded van (today's paperwork lives on it). */
export function pickVan(s: Snapshot | null | undefined): NodeId | null {
  return alive(s).filter((n) => n.kind === 'van').sort(byLoadThenId)[0]?.id ?? null;
}

/**
 * The vehicle to skim in the Runners run: a loaded carrier that is in radio range of another vehicle
 * or a clinic right now (so a hand-off, and the weigh-in that catches the skim, is close). Motorbikes first.
 */
export function pickHandoffSoon(s: Snapshot | null | undefined): NodeId | null {
  const nodes = alive(s).filter((n) => n.boxes.length > 0 && n.kind !== 'store' && n.kind !== 'clinic' && n.kind !== 'dispatch');
  const linked = new Set<NodeId>();
  for (const [a, b] of s?.links ?? []) {
    const ka = kindOf(s, a), kb = kindOf(s, b);
    if (ka && kb && ka !== 'store' && kb !== 'store' && ka !== 'dispatch' && kb !== 'dispatch') { linked.add(a); linked.add(b); }
  }
  const score = (n: NodeState) => (linked.has(n.id) ? 2 : 0) + (n.kind === 'motorbike' ? 1 : 0);
  return nodes.sort((a, b) => score(b) - score(a) || byLoadThenId(a, b))[0]?.id ?? null;
}

/** A loaded rider (never a van): `prefer` if it still holds a crate, else the most loaded one. */
export function pickRider(s: Snapshot | null | undefined, prefer?: NodeId | null): NodeId | null {
  if (prefer && isRider(kindOf(s, prefer)) && loadedIn(s, prefer)) return prefer;
  const riders = alive(s).filter((n) => isRider(n.kind));
  return riders.filter((n) => n.boxes.length > 0).sort(byLoadThenId)[0]?.id ?? riders.sort(byLoadThenId)[0]?.id ?? null;
}

/** Radio links with a drone on at least one end: drones relaying for the fleet. */
export function droneLinks(s: Snapshot | null | undefined): { count: number; drones: NodeId[] } {
  const drones = new Set<NodeId>();
  let count = 0;
  for (const [a, b] of s?.links ?? []) {
    const da = kindOf(s, a) === 'drone', db = kindOf(s, b) === 'drone';
    if (!da && !db) continue;
    count++;
    if (da) drones.add(a);
    if (db) drones.add(b);
  }
  return { count, drones: [...drones].sort() };
}

/** Middle of everything on the map, for the wide shot. */
export function mapCentre(s: Snapshot | null | undefined): Vec2 | null {
  const nodes = s?.nodes ?? [];
  if (!nodes.length) return null;
  const xs = nodes.map((n) => n.pos.x), ys = nodes.map((n) => n.pos.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** The live alert that catches the skim: a weight mismatch (or short delivery) after the skim, naming our target if possible. */
export function findLeakAlert(alerts: Alert[], sinceT: number, target: NodeId | null): Alert | null {
  const after = alerts.filter((a) => (a.kind === 'weight-mismatch' || a.kind === 'short-delivery') && a.t >= sinceT && a.suspect);
  return after.find((a) => a.suspect === target) ?? after.find((a) => a.kind === 'weight-mismatch') ?? after[0] ?? null;
}

/** Alerts that name a holder, raised at or after t. Today's side should stay at 0. */
export const alertsNaming = (alerts: Alert[], sinceT: number): number => alerts.filter((a) => a.t >= sinceT && !!a.suspect).length;

/** Worst-case length of the demo: last beat plus every hold. Must stay under 180 s. */
export const totalSec = (beats: Beat[]): number =>
  beats.reduce((m, b) => Math.max(m, b.atSec), 0) + beats.reduce((s, b) => s + (b.holdSec ?? 0), 0);

// ---------- the director ----------

export function createDirector(opts: DirectorOptions): Director {
  const now = opts.now ?? (() => performance.now());
  const pollMs = opts.pollMs ?? 100;
  const log = opts.log ?? ((line: string) => console.log(line));
  const inBrowser = typeof document !== 'undefined';
  const engines = () => (typeof opts.engines === 'function' ? opts.engines() : opts.engines);
  const idxOf = (m: Mode) => engines().findIndex((e) => e.mode === m);
  const R = () => Math.max(0, idxOf('mesh'));      // Runners run (falls back to the only run)
  const T = () => idxOf('central');                // today's run, -1 if absent
  const snap = (i: number) => (i >= 0 ? opts.getSnapshot?.(i) ?? null : null);
  const eng = (i: number) => (i >= 0 ? engines()[i] ?? null : null);

  // Captions and cards.
  let overlay: CaptionOverlay | null = null;
  const say = (text: string) => {
    if (opts.onCaption) return opts.onCaption(text);
    if (!inBrowser) return;
    overlay ??= createCaptionOverlay();
    overlay.show(text);
  };
  const useCards = (opts.cards ?? true) && inBrowser;
  let clip: DemoCard<ClipboardData> | null = null, chain: DemoCard<ChainData> | null = null, board: DemoCard<ScoreData> | null = null;
  const cards = () => {
    if (useCards && !clip) { clip = createClipboardCard(); chain = createChainCard(); board = createScoreboard(); }
    return { clip, chain, board };
  };
  const hideCards = () => { clip?.hide(); chain?.hide(); board?.hide(); };

  // Camera: per-side renderer if given, else every renderer. Each method only if it exists.
  const all = (): RendererLike[] => (opts.renderer ? (Array.isArray(opts.renderer) ? opts.renderer : [opts.renderer]) : []);
  const forSide = (side?: Mode) => (side && opts.renderers?.[side] ? [opts.renderers[side]!] : all().concat(Object.values(opts.renderers ?? {})));
  const focus = (id: NodeId | null, side: Mode = 'mesh') => {
    if (!id) return;
    const pos = snap(side === 'mesh' ? R() : T())?.nodes.find((n) => n.id === id)?.pos;
    for (const r of forSide(side)) {
      if (r.focusOn) r.focusOn(id);
      else if (r.focus) r.focus(id);
      else if (r.flyTo && pos) r.flyTo(pos, ZOOM_CLOSE);
    }
  };
  const wide = () => {
    const c = mapCentre(snap(R()));
    for (const r of forSide()) if (r.flyTo && c) r.flyTo(c, ZOOM_WIDE);
  };
  const highlight = (ids: NodeId[], side?: Mode) => forSide(side).forEach((r) => r.highlight?.(ids));
  const setTool = (t: Tool) => opts.ui?.setTool?.(t);

  /** Queue an event in every run, stamped with one sim time so each run applies it on the same tick. */
  const mirror = (make: WorldEvent | ((i: number) => WorldEvent | null)) => {
    const es = engines();
    const ts = es.map((_, i) => snap(i)?.t).filter((t): t is number => typeof t === 'number');
    const t = ts.length ? Math.max(...ts) + TICK_DT : undefined;
    es.forEach((e, i) => {
      const ev = typeof make === 'function' ? make(i) : make;
      if (ev) e.apply(t === undefined ? ev : { ...ev, t });
    });
  };

  const delivered = (i: number) => snap(i)?.metrics.deliveredIntact ?? 0;
  const inspectInfo = (i: number, id: NodeId | null) => {
    const e = eng(i);
    const info = id && e ? e.inspect(id) : null;
    return info && id ? { id, ...info } : null;
  };

  // Optional modules, loaded once on demand.
  const viewParent = () => opts.viewParent ?? (inBrowser ? document.getElementById('ui') ?? document.body : null);
  const given = (fn?: (x: never) => void): ViewLike | null => (fn ? { show: (i) => fn(i as never), hide: () => fn(null as never) } : null);
  let optional: Promise<{ intro: AnyFn | null; black: ViewLike | null; glass: ViewLike | null }> | null = null;
  const mods = () => (optional ??= Promise.all([
    opts.playIntro ? Promise.resolve(opts.playIntro) : findOptional('intro'),
    given(opts.showBlackBox) ?? findView('blackbox', viewParent()),
    given(opts.showGlassBox) ?? findView('glassbox', viewParent()),
  ]).then(([intro, black, glass]) => ({ intro, black, glass })));
  const hideViews = () => { if (optional) optional.then((m) => { m.black?.hide(); m.glass?.hide(); }).catch(() => {}); };

  const buildReport = opts.buildReport ?? (async (engine: EngineApi, nodes?: NodeState[]) =>
    (await import('../ledger')).buildReport(engine.ledgerInput(), nodes));

  // ---------- story state shared by the beats (cleared on reset) ----------
  const freshStory = () => ({
    van: null as NodeId | null,                         // today's van with the paperwork
    breachVehicle: null as NodeId | null,               // compare the same last-mile role on both sides
    vehicle: null as NodeId | null,                     // Runners vehicle we skim and open
    follow: null as NodeId | null,                      // its black box keeps refreshing
    theftT: 0,
    targets: [] as (NodeId | null)[],
    leak: null as Alert | null,
    watching: false,
    pendingSkim: false,
    leakBeatReached: false,
    report: null as LedgerReport | null,
    breaches: [null, null] as (BreachDump | null)[],     // [today, runners] captured at the actual breach
    outageBase: [] as number[],
    outageDelivered: [] as (number | null)[],
  });
  let story = freshStory();

  const showBlack = async (id: NodeId | null) => {
    const i = R();
    const info = inspectInfo(i, id);
    if (!info) return;
    opts.ui?.showInspect(info);                         // the inspector always shows labels only + next hop
    const s = snap(i);
    const { black } = await mods();
    black?.show({ ...info, pos: s?.nodes.find((n) => n.id === info.id)?.pos, t: s?.t, engine: eng(i)!, snapshot: s } satisfies BlackBoxInfo);
  };
  const refreshClipboard = () => {
    const ti = T();
    const info = inspectInfo(ti, story.van);
    if (!info) return;
    const naming = story.theftT ? alertsNaming(eng(ti)!.ledgerInput().alerts, story.theftT) : null;
    cards().clip?.show({ vehicle: info.id, dump: info.dump, alertsNamingHolder: naming });
  };
  const showCaught = (a: Alert) => {
    story.follow = null;
    hideViews(); hideCards(); opts.ui?.closePanels?.();
    const suspect = a.suspect ?? a.reportedBy;
    focus(suspect);
    highlight([suspect], 'mesh');
    say(CAPTIONS.caught(a));
    if (a.packageId) cards().chain?.show({ packageId: a.packageId,
      receipts: eng(R())?.ledgerInput().receipts ?? [], heading: 'Loss detected' });
  };

  // Queue the incident only when both runs actually have cargo in transit.
  // Startup speed varies by machine; an empty carrier would silently ignore a skim.
  const trySkim = () => {
    const ri = R(), ti = T();
    const targets = engines().map((_, i) =>
      i === ti && loadedIn(snap(ti), story.van ?? '') ? story.van : pickHandoffSoon(snap(i)));
    if (targets.some((id) => !id)) return;
    story.targets = targets;
    story.vehicle = targets[ri];
    story.theftT = Math.max(...engines().map((_, i) => snap(i)?.t ?? 0));
    story.pendingSkim = false;
    story.watching = true;
    mirror((i) => ({ type: 'skim', kg: SKIM_KG, target: targets[i]! }));
    say(CAPTIONS.theft(SKIM_KG));
  };

  // ---------- the timeline ----------
  const timeline: Beat[] = [
    {
      id: 'intro', atSec: 0, speed: 10, caption: CAPTIONS.hook, holdSec: 2,
      action: async () => {
        highlight([]); setTool('select'); hideCards();
        const { intro } = await mods();
        const canvas = opts.introCanvas ?? (inBrowser ? (document.getElementById('scene') as HTMLCanvasElement | null) : null);
        if (!intro || !canvas) return wide();
        await new Promise<void>((resolve) => {
          try {
            const r = intro(canvas, { onDone: () => resolve(), captions: say });
            if (r instanceof Promise) r.then(() => resolve(), () => resolve());
          } catch (e) {
            console.warn('[demo] intro failed', e);
            resolve();
          }
        });
      },
    },
    { id: 'map', atSec: 13, speed: 10, caption: CAPTIONS.map, action: () => wide() },
    {
      id: 'split', atSec: 21, speed: 10, caption: CAPTIONS.split, live: true,
      action: () => say(T() >= 0 && engines().length > 1 ? CAPTIONS.split : CAPTIONS.single),
    },
    {
      id: 'clipboard', atSec: 29, speed: 6, caption: CAPTIONS.clipboard('a van', 0), live: true,
      action: () => {
        const ti = T();
        if (ti < 0) return say(CAPTIONS.single);
        story.van = pickVan(snap(ti));
        const info = inspectInfo(ti, story.van);
        if (!info) return;
        focus(info.id, 'central');
        highlight([info.id], 'central');
        refreshClipboard();
        say(CAPTIONS.clipboard(info.id, exposure(info.dump).storeLocations));
      },
    },
    {
      id: 'theft', atSec: 38, speed: 10, caption: CAPTIONS.theft(SKIM_KG), live: true,
      action: () => {
        story.leak = null;
        story.pendingSkim = true;
        say('Waiting for loaded carriers on both sides.');
        setTool('skim');
        trySkim();
        later(1500, () => setTool('select'));
      },
    },
    { id: 'today-blind', atSec: 46, speed: 20, caption: CAPTIONS.todayBlind, action: () => refreshClipboard() },
    {
      id: 'black-box', atSec: 55, speed: 6, caption: CAPTIONS.blackBox(null), live: true,
      action: async () => {
        hideCards(); opts.ui?.closePanels?.();
        story.follow = story.vehicle;
        focus(story.vehicle);
        highlight(story.vehicle ? [story.vehicle] : [], 'mesh');
        say(CAPTIONS.blackBox(story.vehicle));
        await showBlack(story.vehicle);
      },
    },
    { id: 'crew', atSec: 64, speed: 30, caption: CAPTIONS.crew, action: () => {} },
    {
      id: 'handoff', atSec: 72, speed: 40, caption: CAPTIONS.handoffWait,
      action: () => {
        story.leakBeatReached = true;
        if (story.leak) showCaught(story.leak);
      },
    },
    {
      id: 'breach-today', atSec: 90, speed: 10, caption: CAPTIONS.breachToday(0, 0), live: true,
      action: () => {
        story.watching = false;
        story.follow = null;
        hideViews(); hideCards(); opts.ui?.closePanels?.();
        const ti = T();
        story.breachVehicle = pickRider(snap(R()));
        const info = inspectInfo(ti, story.breachVehicle);
        if (!info) return breachRunners();
        eng(ti)!.apply({ type: 'breach', target: info.id });
        opts.ui?.showBreach(null, info.dump);
        const x = exposure(info.dump);
        story.breaches[0] = info.dump;
        focus(info.id, 'central');
        say(CAPTIONS.breachToday(x.storeLocations, x.beneficiaryNotes));
      },
    },
    { id: 'breach-runners', atSec: 98, speed: 10, caption: CAPTIONS.breachRunners(0, 0), live: true, action: () => breachRunners() },
    {
      id: 'network-down', atSec: 107, speed: 40, caption: CAPTIONS.networkDown,
      action: () => {
        hideCards(); hideViews(); opts.ui?.showBreach(null, null); opts.ui?.closePanels?.();
        story.outageBase = engines().map((_, i) => delivered(i));
        mirror({ type: 'networkDown' });
        highlight([]);
        wide();
      },
    },
    {
      id: 'swarm', atSec: 116, speed: 40, caption: CAPTIONS.swarm(0), live: true,
      action: () => {
        const d = droneLinks(snap(R()));
        highlight(d.drones, 'mesh');
        say(CAPTIONS.swarm(d.count));
      },
    },
    {
      id: 'outage', atSec: 125, speed: 40, caption: CAPTIONS.outage(0, null), live: true,
      action: () => {
        const since = (i: number) => (i >= 0 ? Math.max(0, delivered(i) - (story.outageBase[i] ?? 0)) : null);
        say(CAPTIONS.outage(since(R()) ?? 0, since(T())));
      },
    },
    {
      id: 'network-up', atSec: 134, speed: 20, caption: CAPTIONS.networkUp,
      action: () => {
        story.outageDelivered = engines().map((_, i) => Math.max(0, delivered(i) - (story.outageBase[i] ?? delivered(i))));
        mirror({ type: 'networkUp' });
        highlight([]);
      },
    },
    {
      id: 'ledger', atSec: 139, speed: 10, caption: CAPTIONS.ledgerPending, live: true,
      action: async () => {
        const e = eng(R());
        if (!e) return;
        say(CAPTIONS.ledgerPending);
        const r = await buildReport(e, snap(R())?.nodes);
        story.report = r;
        opts.ui?.showLedger(r);
        say(CAPTIONS.ledger(r.boxes, r.deliveredIntact, r.findings.length));
      },
    },
    { id: 'glass-box', atSec: 147, speed: 6, caption: CAPTIONS.glassBoxGeneric, live: true, action: () => glassBox() },
    {
      id: 'scoreboard', atSec: 157, speed: 6, caption: CAPTIONS.score(null, { delivered: 0, named: 0 }), live: true,
      action: () => {
        hideCards(); hideViews(); opts.ui?.showBreach(null, null); opts.ui?.closePanels?.();
        const side = (i: number, which: 0 | 1): ScoreSide | null => {
          const s = snap(i);
          if (!s) return null;
          return { delivered: s.metrics.deliveredIntact, named: s.metrics.leaksPinpointed,
            losses: s.metrics.skimmed + s.metrics.stolen + s.metrics.deliveredShort,
            duringOutage: story.outageDelivered[i] ?? null, breach: story.breaches[which] };
        };
        const today = side(T(), 0);
        const runners = side(R(), 1) ?? { delivered: 0, named: 0, losses: 0, duringOutage: null, breach: null };
        cards().board?.show({ today, runners });
        say(CAPTIONS.score(today, runners));
      },
    },
    { id: 'close', atSec: 166, speed: 6, caption: CAPTIONS.close, action: () => {} },
    { id: 'title', atSec: 172, speed: 6, caption: CAPTIONS.title, action: () => {} },
    { id: 'done', atSec: 176, caption: CAPTIONS.title, live: true, action: () => { log(DEMO_DONE); opts.onDone?.(); } },
  ];

  function breachRunners() {
    const ri = R();
    // Breach a drone or motorbike: vans are the one tier allowed to know store locations, so they'd blur the point.
    const s = snap(ri);
    const nonVan = s?.nodes.filter((n) => (n.kind === 'drone' || n.kind === 'motorbike') && n.alive)
      .sort((a, b) => b.boxes.length - a.boxes.length || (a.id < b.id ? -1 : 1))[0]?.id ?? null;
    const id = story.breachVehicle ?? nonVan ?? pickRider(s);
    const info = inspectInfo(ri, id);
    if (!info) return;
    eng(ri)!.apply({ type: 'breach', target: info.id });
    const ti = T();
    const todayDump = story.breaches[0];
    opts.ui?.showBreach(info.dump, todayDump);
    const x = exposure(info.dump);
    story.breaches[1] = info.dump;
    focus(info.id);
    highlight([info.id], 'mesh');
    say(CAPTIONS.breachRunners(x.storeLocations, x.beneficiaryNotes));
  }

  async function glassBox() {
    hideCards(); hideViews(); opts.ui?.closePanels?.();
    opts.ui?.showBreach(null, null);                    // one card at a time: close the breach card first
    const e = eng(R());
    if (!e) return;
    const input = e.ledgerInput();
    const pkg = story.leak?.packageId ?? story.report?.findings[0]?.packageId ?? null;
    if (!pkg) return say(CAPTIONS.glassBoxGeneric);
    const receipts = input.receipts.filter((r) => r.packageId === pkg);
    const { glass } = await mods();
    if (glass) glass.show({ packageId: pkg, receipts, leak: story.leak, report: story.report, engine: e } satisfies GlassBoxInfo);
    else cards().chain?.show({ packageId: pkg, receipts });
    const holder = story.leak?.suspect ?? story.report?.findings.find((f) => f.packageId === pkg)?.holder ?? null;
    const kg = story.leak?.kg ?? story.report?.findings.find((f) => f.packageId === pkg)?.kgLost;
    if (holder) {
      focus(holder);
      highlight([holder], 'mesh');
      say(CAPTIONS.glassBox(pkg, receipts.length, kg, holder));
    } else say(CAPTIONS.glassBoxGeneric);
  }

  // ---------- clock ----------
  let index = 0, started = false, paused = false, done = false;
  let banked = 0;                    // seconds run before the current running stretch
  let runFrom = 0;                   // now() when the current running stretch began
  let gate: { open: boolean; maxSec: number; frozenAt: number | null } = { open: true, maxSec: 0, frozenAt: null };
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFollow = 0, lastWatch = 0;
  const pending = new Set<ReturnType<typeof setTimeout>>();

  const elapsed = () => (gate.frozenAt !== null || !started || paused || done ? banked : banked + (now() - runFrom) / 1000);

  function later(ms: number, fn: () => void) {
    const h = setTimeout(() => { pending.delete(h); fn(); }, ms);
    pending.add(h);
  }

  function fire(beat: Beat) {
    if (inBrowser) {
      document.documentElement.dataset.demoBeat = beat.id;
      window.dispatchEvent(new CustomEvent('runners:beat', { detail: { id: beat.id, elapsedSec: elapsed() } }));
    }
    if (beat.speed !== undefined) opts.onSpeed?.(beat.speed);
    if (!beat.live) say(beat.caption);
    try {
      const r = beat.action();
      if (r instanceof Promise) {
        if (beat.holdSec) {
          const g = { open: false, maxSec: beat.holdSec, frozenAt: null };
          gate = g;
          r.finally(() => { g.open = true; });
        }
        r.catch((e) => console.warn(`[demo] beat ${beat.id} failed`, e));
      }
    } catch (e) {
      console.warn(`[demo] beat ${beat.id} failed`, e);
    }
  }

  function fireDue() {
    while (index < timeline.length && timeline[index].atSec <= elapsed()) {
      if (!gate.open) {
        // The previous beat (the intro) is still running: hold the clock at this boundary, up to maxSec.
        if (gate.frozenAt === null) { banked = timeline[index].atSec; gate.frozenAt = now(); }
        if (now() - gate.frozenAt < gate.maxSec * 1000) return;
        gate.open = true;
      }
      if (gate.frozenAt !== null) { gate.frozenAt = null; runFrom = now(); }
      fire(timeline[index++]);
    }
    if (index >= timeline.length) finish();
  }

  function finish() {
    if (done) return;
    banked = elapsed();
    done = true;
    stopTimer();
  }

  // Background jobs: keep the followed black box fresh; watch for the Leak Finder alert after the theft.
  function poll() {
    fireDue();
    if (story.pendingSkim) trySkim();
    const ms = now();
    if (story.follow && ms - lastFollow >= FOLLOW_EVERY_MS) {
      lastFollow = ms;
      void showBlack(story.follow);
    }
    if (story.watching && !story.leak && ms - lastWatch >= WATCH_EVERY_MS) {
      lastWatch = ms;
      const e = eng(R());
      const a = e ? findLeakAlert(e.ledgerInput().alerts, story.theftT, story.vehicle) : null;
      if (a) {
        story.leak = a;
        story.watching = false;
        if (story.leakBeatReached) showCaught(a);       // before that beat, the hand-off beat shows it
      }
    }
  }

  function startTimer() { if (!timer) timer = setInterval(poll, pollMs); }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  // ---------- controls ----------
  function start() {
    if (done) return;
    if (started) return resume();
    started = true; paused = false; banked = 0; runFrom = now();
    opts.onPause?.(false);
    startTimer();
    fireDue();
  }
  function pause() {
    if (!started || paused || done) return;
    banked = elapsed();
    paused = true;
    opts.onPause?.(true);
    overlay?.setStatus('Paused. Space to resume');
  }
  function resume() {
    if (!started || !paused || done) return;
    paused = false;
    runFrom = now();
    opts.onPause?.(false);
    overlay?.setStatus(null);
  }
  function toggle() {
    if (!started) start();
    else if (paused) resume();
    else pause();
  }
  function next() {
    if (done) return;
    if (!started) { started = true; paused = false; runFrom = now(); startTimer(); }
    gate = { open: true, maxSec: 0, frozenAt: null };
    if (index >= timeline.length) return finish();
    const beat = timeline[index++];
    banked = Math.max(elapsed(), beat.atSec);
    runFrom = now();
    fire(beat);
    if (index >= timeline.length) finish();
  }
  function clearJobs() {
    stopTimer();
    pending.forEach((h) => clearTimeout(h));
    pending.clear();
  }
  function reset() {
    clearJobs();
    const wasPaused = paused;
    index = 0; started = false; paused = false; done = false; banked = 0;
    gate = { open: true, maxSec: 0, frozenAt: null };
    story = freshStory();
    highlight([]);
    setTool('select');
    hideCards();
    hideViews();
    overlay?.hide();
    overlay?.setStatus(null);
    if (wasPaused) opts.onPause?.(false);
    const r = opts.onReset?.();
    if (r instanceof Promise) r.catch((e) => console.warn('[demo] reset failed', e));
  }

  // ---------- keyboard ----------
  const typing = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); reset(); }
  };
  // A focused button (NETWORK DOWN, say) would also click on Space keyup. Swallow it.
  const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e.target)) e.preventDefault(); };
  const bindKeys = (opts.keys ?? true) && typeof window !== 'undefined';
  if (bindKeys) {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  }

  return {
    start, pause, resume, toggle, next, reset,
    dispose() {
      clearJobs();
      if (bindKeys) {
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
      }
      overlay?.dispose(); overlay = null;
      clip?.dispose(); chain?.dispose(); board?.dispose(); clip = chain = board = null;
    },
    state: () => ({ index, elapsedSec: elapsed(), started, paused, done }),
    timeline,
  };
}
