// WP6 dev page (/?dev=ui): the real layout over a stand-in map, driven by mock data, no engine needed.
// Mounts the same neighbours main.ts does (incident feed, playback bar, auditor button) so the page matches the app.
// Every handler call is logged to the console and echoed into the Attack Console so you can see it fire.
// Add &cards=1 to open the breach and sweep cards on load.
import { COUNTS, TICK_DT, WORLD_SIZE } from '../contracts/config';
import type {
  Alert, BreachDump, LedgerReport, Metrics, Mode, NodeKind, NodeState, Snapshot, UiHandlers, WorldEvent,
} from '../contracts/types';
import { createUI } from './index';
import { createThreatFeed } from './threatFeed';
import { createPlayback } from './playback';
import { createAuditorButton } from './glassbox';

// Small seeded generator so the mock looks the same every reload.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const MOCK_RESULTS: Partial<Record<WorldEvent['type'], string>> = {
  fakeCarrier: 'Hand-off refused: no valid carrier certificate',
  fakeClinic: 'Request dropped: no valid clinic certificate',
  replay: 'Dropped: nonce already seen',
  tamper: 'Dropped: bad signature from moto-04',
  collude: 'Clinic found 1.4 kg short; loss pinned between van-02 and clinic-6',
  packShort: 'Box short at clinic-3; packer key store-A named',
  flood: 'Rate-limited; urgent deliveries unaffected',
  spoofGps: 'Position jump flagged; hand-off refused',
  coerce: 'Hand-off flagged coerced; rider not blamed',
  stealKey: 'Key works until its cert expires at 24:00:00; boxes still unreadable',
};

function makeNodes(rng: () => number): NodeState[] {
  const nodes: NodeState[] = [];
  const add = (id: string, kind: NodeKind, x: number, y: number) =>
    nodes.push({ id, kind, pos: { x, y }, alive: true, boxes: [], battery: 1, cellSignal: true });
  for (let i = 0; i < COUNTS.stores; i++) add(`store-${'ABC'[i]}`, 'store', 3000 + i * 1500, 14000 + i * 6000);
  for (let i = 0; i < COUNTS.clinics; i++) add(`clinic-${i + 1}`, 'clinic', 14000 + rng() * 24000, 3000 + rng() * 34000);
  const carriers: [NodeKind, number, string][] = [
    ['drone', COUNTS.drones, 'drone'], ['motorbike', COUNTS.motorbikes, 'moto'], ['van', COUNTS.vans, 'van'], ['boat', COUNTS.boats, 'boat'],
  ];
  for (const [kind, n, prefix] of carriers)
    for (let i = 0; i < n; i++) add(`${prefix}-${String(i + 1).padStart(2, '0')}`, kind, rng() * WORLD_SIZE, rng() * WORLD_SIZE);
  return nodes;
}

const mockDump = (central: boolean, id: string): BreachDump => ({
  nodeId: id,
  readableLabels: [
    { packageId: 'p-31', requestId: 'r-12', attempt: 1, urgency: 3, size: 'M', cold: false, destCell: 'C12-7', deadline: 5400 },
    { packageId: 'p-44', requestId: 'r-19', attempt: 1, urgency: 2, size: 'S', cold: true, destCell: 'C15-3', deadline: 9000 },
  ],
  knownLocations: central
    ? [{ what: 'store', pos: { x: 3000, y: 14000 } }, { what: 'store', pos: { x: 4500, y: 20000 } }, { what: 'store', pos: { x: 6000, y: 26000 } },
       ...Array.from({ length: 10 }, (_, i) => ({ what: 'clinic' as const, pos: { x: 15000 + i * 2000, y: 9000 } }))]
    : [{ what: 'hub', pos: { x: 16000, y: 20000 } }],
  knownStockLevels: central ? 3 : 0,
  readableBeneficiaryNotes: central ? Array.from({ length: 14 }, (_, i) => `${8 + i} children 6-59 months, ${i % 4} new`) : [],
  nextHop: central ? null : 'van-02',
});

const mockLedger: LedgerReport = {
  boxes: 142, deliveredIntact: 131, deliveredShort: 1, skimmed: 3, stolen: 1, lostBreakdown: 4, inTransit: 2, duplicates: 2, badSignatures: 0,
  findings: [
    { packageId: 'p-31', kind: 'skim', holder: 'moto-04', cell: 'C9-5', kgLost: 1.2, t: 2400 },
    { packageId: 'p-58', kind: 'stolen', holder: 'moto-07', cell: 'C14-11', kgLost: 5.6, t: 3100 },
    { packageId: 'p-62', kind: 'packed-short', holder: 'store-A', cell: 'C1-7', kgLost: 0.8, t: 3300 },
    { packageId: 'p-70', kind: 'short-at-clinic', holder: 'van-02', cell: 'C16-4', kgLost: 1.4, t: 3500 },
  ],
};

/** A flat stand-in for the satellite map: one panel, or two halves on the compare page. */
function mockMap(root: HTMLElement): (split: boolean) => void {
  const bg = document.createElement('div');
  bg.style.cssText = 'position:absolute;inset:0;display:flex;';
  root.prepend(bg);
  const half = (tint: string, label: string) => {
    const d = document.createElement('div');
    d.style.cssText = `flex:1;position:relative;background:radial-gradient(circle at 45% 45%, ${tint}, #2c3a26 38%, #1f2a1c 70%, #141a14);` +
      'box-shadow:inset -1px 0 0 rgba(0,0,0,.5);';
    const lake = document.createElement('div');
    lake.style.cssText = 'position:absolute;left:30%;top:28%;width:18%;height:34%;border-radius:45% 55% 50% 50%;background:#16302e;opacity:.9;';
    const t = document.createElement('div');
    t.textContent = label;
    t.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 13px system-ui;letter-spacing:.2em;color:rgba(255,255,255,.18);';
    d.append(lake, t);
    return d;
  };
  return (split) => bg.replaceChildren(...(split ? [half('#5b6b3e', 'TODAY MAP'), half('#4f6a40', 'RUNNERS MAP')] : [half('#4f6a40', 'RUNNERS MAP')]));
}

export function mountDev(root: HTMLElement): void {
  const host = (root.querySelector('#ui') as HTMLElement | null) ?? root;
  const rng = lcg(7);
  let networkUp = true;
  let split = false;
  let speed = 1;
  let playing = true;
  const drawMap = mockMap(root);
  drawMap(false);
  const feed = createThreatFeed(host);   // main.ts mounts the feed before the UI; the UI adopts it into the sidebar

  const handlers: UiHandlers = {
    onEvent(ev) {
      console.log('[ui] onEvent', ev);
      if (ev.type === 'networkDown') networkUp = false;
      if (ev.type === 'networkUp') { networkUp = true; setTimeout(() => api.showLedger(mockLedger), 400); }
      const line = MOCK_RESULTS[ev.type];
      if (line) setTimeout(() => api.showAttackResult(line), 300);
    },
    onTool(t) { console.log('[ui] onTool', t); },
    onMode(m) { console.log('[ui] onMode', m); split = m === 'split'; drawMap(split); api.setMode(m); },
    onSpeed(x) { console.log('[ui] onSpeed', x); speed = x; },
    onReset() { console.log('[ui] onReset'); t = 0; reach.mesh = 0; reach.central = 0; },
    onFindingClick(f) { console.log('[ui] onFindingClick', f); api.showAttackResult(`Highlight ${f.holder} (${f.packageId})`); },
  };
  const api = createUI(host, handlers);
  const playback = createPlayback(host, {
    onPlayPause: (p) => { playing = p; },
    onSpeed: (x) => { speed = Math.min(60, x); },
    onSkip: () => { t += 3600; },
    onReset: () => handlers.onReset(),
  }, { speed, playing: true });
  createAuditorButton(host, () => api.showAttackResult('Auditor: the glass box opens here in the app'));

  const nodes = { mesh: makeNodes(lcg(7)), central: makeNodes(lcg(7)) };
  const reach = { mesh: 0, central: 0 };
  let t = 0;
  let pendingAlerts: Alert[] = [];

  const metricsFor = (mode: Mode): Metrics => {
    const r = reach[mode];
    return {
      t, requestsOpen: 6, boxesTotal: Math.round(t / 25), deliveredIntact: Math.round((r / 100) * (t / 25)),
      deliveredShort: mode === 'central' ? 2 : 0, skimmed: mode === 'mesh' ? 3 : 0, stolen: 1, lostBreakdown: 2,
      inTransit: 7, duplicates: 1, leaksPinpointed: mode === 'mesh' ? 3 : 0, attacksBlocked: mode === 'mesh' ? 4 : 0,
      reachPct: r, meanDeliverySec: 1500 + r * 8, carriersAlive: 21, carriersTotal: 22,
    };
  };

  const snap = (mode: Mode): Snapshot => {
    for (const n of nodes[mode]) {
      if (n.kind === 'store' || n.kind === 'clinic') continue;
      n.pos.x = (n.pos.x + (rng() - 0.5) * 120 + WORLD_SIZE) % WORLD_SIZE;
      n.pos.y = (n.pos.y + (rng() - 0.5) * 120 + WORLD_SIZE) % WORLD_SIZE;
      n.boxes = rng() < 0.4 ? ['p-1'] : [];
    }
    const ns = nodes[mode];
    const links: [string, string][] = [];
    for (let i = 0; i < ns.length; i++)
      for (let j = i + 1; j < ns.length; j++)
        if (Math.hypot(ns[i].pos.x - ns[j].pos.x, ns[i].pos.y - ns[j].pos.y) < 3000) links.push([ns[i].id, ns[j].id]);
    return {
      t, mode, nodes: ns, links, cellNetworkUp: networkUp,
      deadZones: [{ pos: { x: 26000, y: 18000 }, radius: 2500 }],
      hubs: [{ id: 'hub-1', pos: { x: 16000, y: 20000 } }, { id: 'hub-2', pos: { x: 24000, y: 30000 } }, { id: 'hub-3', pos: { x: 28000, y: 10000 } }],
      metrics: metricsFor(mode),
      newAlerts: mode === 'mesh' ? pendingAlerts : [],
      newLogs: [],
    };
  };

  // Fake clock: ~10 updates a second, each covering `speed` x TICK_DT sim seconds.
  const THREATS = [
    { kind: 'skim', outcome: 'detected', text: 'moto-04 skimmed 1.2 kg; van-02 weighed it at the next hand-off' },
    { kind: 'breach', outcome: 'contained', text: 'Hacked drone-03: one next stop leaked, no stores, no child data' },
    { kind: 'steal', outcome: 'succeeded', text: 'Box p-58 taken from moto-07 near C14-11' },
    { kind: 'fakeNode', outcome: 'blocked', text: 'Fake carrier refused: no valid certificate' },
  ] as const;
  setInterval(() => {
    if (!playing) return;
    if (rng() < 0.08) {
      const th = THREATS[Math.floor(rng() * THREATS.length)];
      feed.update([{ t, kind: th.kind, actor: 'mock', outcome: th.outcome, text: th.text }], [], 1);
    }
    playback.setTime(t);
    for (let k = 0; k < speed; k++) {
      t += TICK_DT * 4;
      reach.mesh = Math.min(96, reach.mesh + (networkUp ? 0.05 : 0.04));
      reach.central = Math.min(96, reach.central + (networkUp ? 0.05 : 0));
      if (Math.floor(t) % 400 === 0) {
        pendingAlerts.push({ t, kind: 'weight-mismatch', reportedBy: 'van-02', suspect: 'moto-04', packageId: `p-${Math.floor(t / 400)}`,
          cell: 'C9-5', kg: 1.2, text: 'van-02 weighed 1.2 kg less than the passport' });
      }
      if (Math.floor(t) % 700 === 0) {
        pendingAlerts.push({ t, kind: 'bad-signature', reportedBy: 'drone-03', suspect: 'moto-09', cell: 'C11-2',
          text: 'Dropped: bad signature from moto-09' });
      }
    }
    // Like main.ts: the Today run always rides along, so the comparison numbers exist on both pages.
    api.update(snap('mesh'), snap('central'));
    pendingAlerts = [];
  }, 100);

  // Seed the static panels so they are visible on load; close them with their buttons.
  api.showInspect({
    id: 'moto-04', kind: 'motorbike', dump: mockDump(false, 'moto-04'),
    logs: Array.from({ length: 20 }, (_, i) =>
      i % 2 ? `Handing box p-17 to van-02: its ETA to C12-7 is ${18 + i} min vs my ${31 + i} min.` : `Beacon from drone-0${(i % 8) + 1}, 1 box, spare 1`),
  });
  const sweepData = { kill: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], mesh: [91, 88, 84, 79, 71, 63, 52], central: [34, 30, 26, 21, 17, 12, 9] };
  // main.ts opens the sweep on S; mirror that here.
  window.addEventListener('keydown', (e) => { if ((e.key === 's' || e.key === 'S') && !(e.target instanceof HTMLInputElement)) api.showSweep(sweepData); });
  if (new URLSearchParams(location.search).get('cards')) {
    api.showBreach(mockDump(false, 'moto-04'), mockDump(true, 'dispatch'));
    api.showSweep(sweepData);
  }
  // Window hooks for poking cards from the console: __ui.showLedger(...), __ui.showBreach(...)
  (window as unknown as { __ui: typeof api; __mock: object }).__ui = api;
  (window as unknown as { __mock: object }).__mock = { mockLedger, mockDump };
}
