// WP1 sim engine tests. Uses tiny local dummy agents, never WP2's real ones.
import { describe, expect, it } from 'vitest';
import { MAX_HOPS, RADIO_RANGE, SPEED, TICK_DT, TRANSFER_RADIUS } from '../src/contracts/config';
import type {
  Action, Agent, AgentSetup, AgentView, BreachDump, EngineApi, Factories, Receipt, SealedBox,
} from '../src/contracts/types';
import { createEngine } from '../src/sim/engine';
import { buildTopology, recipients, type NetNode } from '../src/sim/network';
import { mulberry32 } from '../src/sim/rng';
import { layoutNodes } from '../src/sim/setup';
import { cellCenter, cellOf, createWorld, dist, hasCoverage } from '../src/sim/map';

// Positions come from whichever district src/sim/map.ts selects, so these tests are map-agnostic.
const W = createWorld();
/** A real clinic inside town cell coverage (the map decides which ones are). */
const coveredClinic = () => {
  const v = W.villages.find((x) => hasCoverage(x.pos));
  if (!v) throw new Error('no clinic inside cell coverage on this map');
  return v;
};
const coveredStore = () => {
  const st = W.stores.find((x) => hasCoverage(x.pos));
  if (!st) throw new Error('no store inside cell coverage on this map');
  return st;
};

const emptyDump = (id: string): BreachDump =>
  ({ nodeId: id, readableLabels: [], knownLocations: [], knownStockLevels: 0, readableBeneficiaryNotes: [], nextHop: null });

const fakeBox = (packageId: string, size: 'S' | 'M' | 'L' = 'S'): SealedBox => ({
  label: { packageId, requestId: `r-${packageId}`, attempt: 1, urgency: 2, size, cold: false, destCell: 'C10-10', deadline: 9999 },
  sealed: { epk: 'x', iv: 'x', ct: 'x' },
  packedBy: 'store-A',
  packSig: 'x',
});

/** Dummy agents driven by a per-node script: (view, setup) => actions. Everyone else idles. */
function scripted(script: Record<string, (v: AgentView, s: AgentSetup) => Action[]>): Factories {
  const f = (s: AgentSetup): Agent => ({
    id: s.id,
    kind: s.kind,
    async tick(v) { return script[s.id]?.(v, s) ?? []; },
    dump: () => emptyDump(s.id),
    receipts: () => [],
  });
  return { drone: f, motorbike: f, van: f, boat: f, store: f, clinic: f, dispatch: f };
}

/** A busier dummy world for determinism: carriers patrol, stores pack boxes, vans pick up, clinics consume. */
function patrolFactories(): Factories {
  const f = (s: AgentSetup): Agent => {
    let leg = 0, n = 0;
    const holds: Receipt[] = [];
    return {
      id: s.id,
      kind: s.kind,
      async tick(v) {
        const acts: Action[] = [];
        if (s.kind === 'store' && Math.floor(v.t) % 300 === 0 && v.t % 1 === 0)
          acts.push({ type: 'spawnBox', box: fakeBox(`${s.id}-p${++n}`), kg: 2.8 + Math.round(s.rng() * 10) / 10 });
        if (s.kind === 'store')
          for (const cb of v.inventory) {
            const van = v.neighbours.find((x) => x.kind === 'van' && x.dist <= TRANSFER_RADIUS);
            if (van) acts.push({ type: 'transfer', packageId: cb.box.label.packageId, to: van.id });
          }
        if (s.kind === 'clinic') for (const cb of v.inventory) acts.push({ type: 'consume', packageId: cb.box.label.packageId });
        if (s.patrol && s.patrol.length > 1 && (v.kind !== 'store')) {
          const tgt = s.patrol[leg % s.patrol.length];
          if (dist(v.pos, tgt) < 5) {
            leg++;
            acts.push({ type: 'moveTo', path: v.map.route(v.kind as 'van', v.pos, s.patrol[leg % s.patrol.length]) });
          } else if (v.t === 0) acts.push({ type: 'moveTo', path: v.map.route(v.kind as 'van', v.pos, tgt) });
        }
        if (s.kind === 'drone' && v.t === 0) acts.push({ type: 'moveTo', path: [{ x: v.pos.x + 3000 * s.rng(), y: v.pos.y + 3000 * s.rng() }] });
        for (const cb of v.inventory)
          if (!cb.passport.some((r) => r.to === s.id)) {
            const r: Receipt = { packageId: cb.box.label.packageId, requestId: cb.box.label.requestId, attempt: 1, kind: 'pickup',
              from: 'x', to: s.id, t: v.t, seq: cb.passport.length, cell: v.map.cellOf(v.pos), measuredKg: cb.measuredKg, sigTo: 'sig' };
            holds.push(r);
            acts.push({ type: 'stamp', packageId: cb.box.label.packageId, receipt: r });
          }
        if (v.kind !== 'store' && v.kind !== 'clinic') acts.push({ type: 'send', msg: { from: s.id, to: '*', kind: 'beacon', body: { p: v.pos } } });
        return acts;
      },
      dump: () => emptyDump(s.id),
      receipts: () => holds,
    };
  };
  return { drone: f, motorbike: f, van: f, boat: f, store: f, clinic: f, dispatch: f };
}

async function run(e: EngineApi, sec: number) {
  let s = await e.step();
  for (let i = 1; i < sec / TICK_DT; i++) s = await e.step();
  return s;
}

describe('WP1 world', () => {
  const w = W;
  it('cells round-trip and every clinic is on the road network', () => {
    expect(cellOf(cellCenter('C12-7'))).toBe('C12-7');
    expect(w.villages).toHaveLength(10);
    expect(w.hubs).toHaveLength(3);
    for (const v of w.villages) {
      const path = w.map.route('van', w.stores[0].pos, v.pos);
      expect(path[path.length - 1]).toEqual(v.pos);
      expect(Number.isFinite(w.map.eta('van', w.stores[0].pos, v.pos))).toBe(true);
    }
    // Drones fly straight, so they always beat a van over the same trip.
    expect(w.map.eta('drone', w.hubs[0].pos, w.villages[0].pos)).toBeLessThan(w.map.eta('van', w.hubs[0].pos, w.villages[0].pos));
  });
  it('mulberry32 is deterministic', () => {
    const a = mulberry32(7), b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('WP1 network', () => {
  const chain = (n: number, gap: number): NetNode[] =>
    Array.from({ length: n }, (_, i) => ({ id: `moto-${i}`, kind: 'motorbike' as const, pos: { x: 15000 + i * gap, y: 2000 }, alive: true }));

  it('delivers within a radio-connected group, hop by hop', () => {
    const topo = buildTopology(chain(3, 1500), { cellUp: false, deadZones: [] });
    expect(recipients(topo, 'moto-0', '*')).toEqual([{ id: 'moto-1', hops: 1 }, { id: 'moto-2', hops: 2 }]);
    expect(recipients(topo, 'moto-0', 'moto-2')).toEqual([{ id: 'moto-2', hops: 2 }]);
  });

  it('does not deliver across a dead zone', () => {
    const topo = buildTopology(chain(3, 1500), { cellUp: false, deadZones: [{ pos: { x: 16500, y: 2000 }, radius: 300 }] });
    expect(recipients(topo, 'moto-0', '*')).toEqual([]);
    expect(recipients(topo, 'moto-0', 'moto-2')).toEqual([]);
  });

  it(`stops after MAX_HOPS (${MAX_HOPS})`, () => {
    const topo = buildTopology(chain(MAX_HOPS + 2, 1500), { cellUp: false, deadZones: [] });
    const got = recipients(topo, 'moto-0', '*').map((r) => r.id);
    expect(got).toContain(`moto-${MAX_HOPS}`);
    expect(got).not.toContain(`moto-${MAX_HOPS + 1}`);
  });

  it('cell signal links both ends only while the network is up', () => {
    const c = coveredClinic(), st = coveredStore();
    // Far enough apart that only the cell network can join them (no radio path).
    expect(dist(c.pos, st.pos)).toBeGreaterThan(4000);
    const nodes: NetNode[] = [
      { id: c.clinicId, kind: 'clinic', pos: { ...c.pos }, alive: true },
      { id: st.id, kind: 'store', pos: { ...st.pos }, alive: true },
    ];
    expect(recipients(buildTopology(nodes, { cellUp: true, deadZones: [] }), c.clinicId, st.id)).toEqual([{ id: st.id, hops: 1 }]);
    expect(recipients(buildTopology(nodes, { cellUp: false, deadZones: [] }), c.clinicId, st.id)).toEqual([]);
  });
});

describe('WP1 engine', () => {
  it('same seed gives identical metrics and positions', async () => {
    const go = async () => {
      const e = await createEngine({ seed: 7, mode: 'mesh', factories: patrolFactories() });
      e.apply({ type: 'networkDown', t: 300 });
      e.apply({ type: 'skim', t: 700 });
      e.apply({ type: 'breakdown', t: 800 });
      const s = await run(e, 1200);
      return JSON.stringify({ m: s.metrics, n: s.nodes });
    };
    const a = await go();
    const b = await go();
    expect(a).toBe(b);
    expect(JSON.parse(a).m.boxesTotal).toBeGreaterThan(0);
  });

  it('runs a transfer only within TRANSFER_RADIUS, and the passport moves with the box', async () => {
    const r: Receipt = { packageId: 'p-1', requestId: 'r-p-1', attempt: 1, kind: 'pickup', from: 'store-A', to: 'store-A', t: 0, seq: 0, cell: 'C2-10', measuredKg: 3, sigTo: 's' };
    const e = await createEngine({
      seed: 1, mode: 'mesh', factories: scripted({
        'store-A': (v) => v.t === 0 ? [{ type: 'spawnBox', box: fakeBox('p-1'), kg: 3 }, { type: 'spawnBox', box: fakeBox('p-2'), kg: 3 }]
          : v.t === 0.5 ? [{ type: 'stamp', packageId: 'p-1', receipt: r }, { type: 'transfer', packageId: 'p-1', to: 'van-01' }]
            : v.t === 10 ? [{ type: 'transfer', packageId: 'p-2', to: 'van-01' }] : [],
        // van-01 starts at store-A, then drives off after the first hand-off.
        'van-01': (v) => v.t === 1 ? [{ type: 'moveTo', path: [{ x: v.pos.x + 500, y: v.pos.y }] }] : [],
      }),
    });
    const logs: string[] = [];
    let s;
    for (let i = 0; i < 30; i++) { s = await e.step(); logs.push(...s.newLogs.map((l) => l.text)); }
    const van = s!.nodes.find((n) => n.id === 'van-01')!;
    const store = s!.nodes.find((n) => n.id === 'store-A')!;
    expect(van.boxes).toEqual(['p-1']);
    expect(store.boxes).toEqual(['p-2']);
    expect(logs.some((l) => /p-2 to van-01 failed: \d+ m apart/.test(l))).toBe(true);
    const passport = e.ledgerInput().receipts.filter((x) => x.packageId === 'p-1');
    expect(passport).toHaveLength(1);
  });

  it('refuses a transfer the receiver has no room for', async () => {
    const storePos = W.stores.find((x) => x.id === 'store-A')!.pos;
    const droneHome = layoutNodes(W, 'mesh').find((n) => n.id === 'drone-01')!.home;
    // Long enough for drone-01 to fly from its hub to the store on this map, plus a margin.
    const arriveSec = Math.ceil(dist(droneHome, storePos) / SPEED.drone) + 30;
    const logs: string[] = [];
    let tried = false;
    const e = await createEngine({
      seed: 1, mode: 'mesh', factories: scripted({
        'store-A': (v) => {
          if (v.t === 0) return [{ type: 'spawnBox', box: fakeBox('big', 'L'), kg: 9 }];
          const d = v.neighbours.find((n) => n.id === 'drone-01');
          if (!tried && d && d.dist <= TRANSFER_RADIUS) { tried = true; return [{ type: 'transfer', packageId: 'big', to: 'drone-01' }]; }
          return [];
        },
        // drone-01 flies over to the store first (drones carry 2 units; an L box is 4).
        'drone-01': (v) => v.t === 0 ? [{ type: 'moveTo', path: [storePos] }] : [],
      }),
    });
    let s;
    for (let i = 0; i <= arriveSec / TICK_DT + 1; i++) { s = await e.step(); logs.push(...s.newLogs.map((l) => l.text)); }
    expect(tried).toBe(true);
    expect(s!.nodes.find((n) => n.id === 'store-A')!.boxes).toEqual(['big']);
    expect(dist(s!.nodes.find((n) => n.id === 'drone-01')!.pos, storePos)).toBeLessThan(1);
    expect(logs.some((l) => /big to drone-01 failed: no room/.test(l))).toBe(true);
  });

  it('a skim lowers what the next scale reads, and an alert naming the holder pinpoints it', async () => {
    const seen: number[] = [];
    const e = await createEngine({
      seed: 1, mode: 'mesh', factories: scripted({
        'store-A': (v) => v.t === 0 ? [{ type: 'spawnBox', box: fakeBox('p-9'), kg: 5 }] : v.t === 0.5 ? [{ type: 'transfer', packageId: 'p-9', to: 'van-01' }] : [],
        'van-01': (v) => {
          if (v.inventory[0]) seen.push(v.inventory[0].measuredKg);
          return v.t === 3 ? [{ type: 'alert', alert: { t: 3, kind: 'weight-mismatch', reportedBy: 'van-01', packageId: 'p-9', suspect: 'van-01', cell: 'C2-10', kg: 1.2, text: 'mismatch' } }] : [];
        },
      }),
    });
    e.apply({ type: 'skim', target: 'van-01', kg: 1.2, t: 2 });
    let s;
    for (let i = 0; i < 10; i++) s = await e.step();
    expect(seen[0]).toBe(5);
    expect(seen[seen.length - 1]).toBe(3.8);
    expect(s!.metrics.skimmed).toBe(1);
    expect(s!.metrics.leaksPinpointed).toBe(1);
  });

  it('demand reaches the clinic inbox and network events change the snapshot', async () => {
    const inbox: unknown[] = [];
    const e = await createEngine({ seed: 3, mode: 'mesh', factories: scripted({
      'clinic-4': (v) => {
        inbox.push(...v.inbox.filter((m) => m.from === 'scenario'));
        // The clinic turns demand into a request and broadcasts it; the engine counts it as one request made.
        return v.inbox.some((m) => m.from === 'scenario')
          ? [{ type: 'send', msg: { from: 'clinic-4', to: '*', kind: 'request', body: { requestId: 'clinic-4-r1', createdAt: v.t } } }] : [];
      },
    }) });
    e.apply({ type: 'demand', target: 'clinic-4' });
    e.apply({ type: 'networkDown' });
    e.apply({ type: 'deadZone', pos: { x: 14000, y: 20500 }, radius: 2000 });
    const s = await e.step();
    expect(inbox).toHaveLength(1);
    expect((inbox[0] as { kind: string; body: { type: string } }).body.type).toBe('demand');
    expect(s.cellNetworkUp).toBe(false);
    expect(s.deadZones).toHaveLength(1);
    expect(s.metrics.requestsOpen).toBe(1);
    expect(s.nodes.filter((n) => n.kind === 'store')).toHaveLength(3);
    expect(s.nodes.some((n) => n.kind === 'dispatch')).toBe(false);
  });

  it('only vans (and stores) are ever told a store is in radio range; hubs sit out of every store range', async () => {
    for (const h of W.hubs) for (const st of W.stores) expect(dist(h.pos, st.pos)).toBeGreaterThan(RADIO_RANGE.store);
    const storePos = W.stores.find((x) => x.id === 'store-A')!.pos;
    const seen: Record<string, string[]> = { 'drone-01': [], 'van-01': [] };
    const watch = (id: string) => (v: AgentView): Action[] => {
      seen[id].push(...v.neighbours.map((n) => n.kind));
      return v.t === 0 ? [{ type: 'moveTo', path: [{ x: storePos.x + 10, y: storePos.y }] }] : [];
    };
    const e = await createEngine({ seed: 1, mode: 'mesh', factories: scripted({ 'drone-01': watch('drone-01'), 'van-01': watch('van-01') }) });
    const flight = Math.ceil(dist(layoutNodes(W, 'mesh').find((n) => n.id === 'drone-01')!.home, storePos) / SPEED.drone) + 10;
    for (let i = 0; i < flight / TICK_DT; i++) await e.step();
    expect(seen['drone-01']).not.toContain('store');
    expect(seen['van-01']).toContain('store');
  });

  it('flood gets rate-limited and counted as blocked', async () => {
    const e = await createEngine({ seed: 3, mode: 'mesh', factories: scripted({}) });
    await e.step();
    e.apply({ type: 'flood', target: 'moto-01' });
    const s = await e.step();
    expect(s.newAlerts.some((a) => a.kind === 'rate-limited')).toBe(true);
    expect(s.metrics.attacksBlocked).toBe(1);
    expect(s.nodes.some((n) => n.fake)).toBe(true);
  });

  it('attack console: fake carrier has no cert, spoofed GPS jumps, packShort under-packs', async () => {
    const certs: Record<string, unknown> = {};
    const views: Record<string, AgentView> = {};
    const f = scripted({ 'store-B': (v) => v.t === 1 ? [{ type: 'spawnBox', box: fakeBox('ps-1'), kg: 6 }] : [] });
    const wrap = (k: keyof Factories) => (s: AgentSetup) => {
      certs[s.id] = s.cert;
      const a = f[k](s);
      return { ...a, tick: async (v: AgentView) => { views[s.id] = v; return a.tick(v); } };
    };
    const factories = Object.fromEntries((Object.keys(f) as (keyof Factories)[]).map((k) => [k, wrap(k)])) as unknown as Factories;
    const e = await createEngine({ seed: 5, mode: 'mesh', factories });
    expect(certs['moto-01']).not.toBeNull();
    await e.step();
    const before = { ...views['moto-02'].pos };
    e.apply({ type: 'fakeCarrier', target: 'moto-01' });
    e.apply({ type: 'spoofGps', target: 'moto-02' });
    e.apply({ type: 'packShort', target: 'store-B', kg: 2.8 });
    const s = await run(e, 2);
    const fake = s.nodes.find((n) => n.fake)!;
    expect(fake.id).toMatch(/^fake-/);
    expect(certs[fake.id]).toBeNull();
    expect(Math.abs(views['moto-02'].pos.x - before.x)).toBeGreaterThan(4000);
    // The store's scale reads what is really in the box: 6 - 2.8.
    expect(views['store-B'].inventory[0].measuredKg).toBeCloseTo(3.2);
  });

  it('central mode adds the dispatch server; warmup fast-forwards', async () => {
    const e = await createEngine({ seed: 7, mode: 'central', factories: scripted({}), warmupSec: 60 });
    const s = await e.step();
    expect(s.t).toBe(60.5);
    expect(s.nodes.some((n) => n.id === 'dispatch')).toBe(true);
    expect(e.inspect('dispatch')!.kind).toBe('dispatch');
    expect(e.auditorSealPriv()).toBeDefined();
  });
});

describe('WP1 attack console: replay, tamper, collude', () => {
  it('replay re-delivers an old request; tamper changes it but keeps the signature; collude rigs carrier scales', async () => {
    const got: { kind: string; body: unknown; sig?: string }[] = [];
    const scales: number[] = [];
    const cv = coveredClinic();
    const clinic = cv.clinicId, destCell = cellOf(cv.pos);
    expect(hasCoverage(W.stores.find((x) => x.id === 'store-A')!.pos)).toBe(true);
    const e = await createEngine({
      seed: 2, mode: 'mesh', factories: scripted({
        [clinic]: (v) => v.t === 0 ? [{ type: 'send', msg: { from: clinic, to: '*', kind: 'request', body: { requestId: 'q1', destCell, createdAt: 0 }, sig: 'S' } }] : [],
        // store-A and this clinic both sit in town cell coverage, so store-A hears the clinic.
        'store-A': (v) => {
          got.push(...v.inbox.filter((m) => m.kind === 'request').map((m) => ({ kind: m.kind, body: m.body, sig: m.sig })));
          return v.t === 0 ? [{ type: 'spawnBox', box: fakeBox('c-1'), kg: 5 }] : v.t === 0.5 ? [{ type: 'transfer', packageId: 'c-1', to: 'van-01' }] : [];
        },
        'van-01': (v) => { if (v.inventory[0]) scales.push(v.inventory[0].measuredKg); return []; },
      }),
    });
    await run(e, 2);
    e.apply({ type: 'replay' });
    e.apply({ type: 'tamper', target: clinic });
    e.apply({ type: 'collude', target: 'van-01', kg: 1.4 });
    await run(e, 2);
    expect(got.length).toBe(3);                                       // original + replay + tampered copy
    expect(got[1]).toEqual(got[0]);
    expect((got[2].body as { destCell: string }).destCell).not.toBe(destCell);
    expect(got[2].sig).toBe('S');
    expect(scales[scales.length - 1]).toBe(5);                        // rigged: still reads the old weight
    const s = await e.step();
    expect(s.metrics.skimmed + s.metrics.inTransit).toBeGreaterThan(0);
    expect(s.metrics.requestsOpen).toBe(2);                            // q1 once (replays don't add) + the box's own request
  });
});
