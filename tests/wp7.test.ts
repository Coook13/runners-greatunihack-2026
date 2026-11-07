import { describe, expect, it } from 'vitest';
import type { Action, Agent, AgentSetup, AgentView, BreachDump, CarriedBox, MapQuery, Msg, NodeKind, Vec2 } from '../src/contracts/types';
import { CELL_SIZE, DWELL, SPEED, TICK_DT } from '../src/contracts/config';
import { generateKeySet } from '../src/privacy/core';
import { centralFactories } from '../src/baseline';
import { dwellPoints, raid } from '../src/baseline/raiders';

// ---------- raiders ----------
// Build a track sampled every `dt` s: drive between waypoints, pausing `pause` s at each one.
function track(stops: Vec2[], pause: number, dt = 1): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < stops.length; i++) {
    for (let k = 0; k < pause / dt; k++) out.push({ ...stops[i] });
    const a = stops[i], b = stops[(i + 1) % stops.length];
    for (let k = 1; k <= 20; k++) out.push({ x: a.x + ((b.x - a.x) * k) / 20, y: a.y + ((b.y - a.y) * k) / 20 });
  }
  return out;
}

describe('wp7 raiders', () => {
  const store = { x: 5000, y: 20000 };

  it('detects a dwell only when the stop lasts DWELL.minSec', () => {
    const stop = (sec: number) => Array.from({ length: sec + 1 }, () => ({ ...store }));
    expect(dwellPoints(stop(DWELL.minSec + 5), 1)).toHaveLength(1);
    expect(dwellPoints(stop(DWELL.minSec - 5), 1)).toHaveLength(0);
  });

  it('finds a store from a van that keeps returning to it', () => {
    const clinics = [{ x: 15000, y: 10000 }, { x: 30000, y: 25000 }, { x: 20000, y: 35000 }];
    const tr = track([store, clinics[0], store, clinics[1], store, clinics[2]], 60);
    const r = raid({ 'van-01': tr }, 1, [store]);
    expect(r.score).toBe(1);
  });

  it('misses when dwells rotate and never repeat near the store', () => {
    // Hand-offs scattered far apart; the store itself is never visible in this van's track.
    const spots = Array.from({ length: 8 }, (_, i) => ({ x: 12000 + i * 1500, y: 15000 + (i % 3) * 1500 }));
    const r = raid({ 'van-01': track(spots, 60) }, 1, [store]);
    expect(r.dwells.length).toBeGreaterThan(5);
    expect(r.score).toBe(0);
  });

  it('only watches vans by default', () => {
    const tr = track([store, { x: 15000, y: 10000 }, store, { x: 30000, y: 25000 }], 60);
    expect(raid({ 'drone-01': tr }, 1, [store]).score).toBe(0);
  });
});

// ---------- central agents in a tiny fake world ----------
const map: MapQuery = {
  cellOf: (p) => `C${Math.floor(p.x / CELL_SIZE)}-${Math.floor(p.y / CELL_SIZE)}`,
  cellCenter: () => ({ x: 0, y: 0 }),
  route: (_k, _f, to) => [to],
  eta: (k, f, t) => Math.hypot(f.x - t.x, f.y - t.y) / SPEED[k],
  passable: () => true,
  hubs: () => [],
};

let seed = 1;
const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

interface Node { a: Agent; kind: NodeKind; pos: Vec2; inv: CarriedBox[]; path: Vec2[]; inbox: Msg[] }

// The engine's scenario is the only source of demand: put one admission in clinic-1's inbox.
function demand(w: Awaited<ReturnType<typeof world>>) {
  w.nodes.get('clinic-1')!.inbox.push({ id: 'd-1', from: 'scenario', to: 'clinic-1', kind: 'order', body: { type: 'demand', urgency: 2 }, hops: 0, t: 0 });
}

async function world(netUp: () => boolean) {
  const shared = await generateKeySet();
  const auditor = await generateKeySet();
  const nodes = new Map<string, Node>();
  const add = async (id: string, kind: NodeKind, pos: Vec2) => {
    const s: AgentSetup = {
      id, kind, keys: await generateKeySet(), cert: null, storeSealPub: shared.sealPub, storeIds: [],
      auditorSealPub: auditor.sealPub, authoritySignPubs: [], home: pos, rng,
    };
    nodes.set(id, { a: centralFactories[kind](s), kind, pos: { ...pos }, inv: [], path: [], inbox: [] });
  };
  await add('dispatch', 'dispatch', { x: 5000, y: 20000 });
  await add('store-A', 'store', { x: 5000, y: 20000 });
  await add('clinic-1', 'clinic', { x: 8000, y: 22000 });
  await add('van-01', 'van', { x: 5100, y: 20100 });
  let t = 0;
  const step = async () => {
    const ids = [...nodes.keys()].sort();
    const views = ids.map((id): AgentView => {
      const n = nodes.get(id)!;
      const inbox = n.inbox; n.inbox = [];
      return {
        self: id, kind: n.kind, t, dt: TICK_DT, pos: n.pos, battery: 1, inventory: n.inv, inbox, mode: 'central', map,
        cellSignal: netUp(),
        neighbours: ids.filter((o) => o !== id).map((o) => {
          const m = nodes.get(o)!; return { id: o, kind: m.kind, pos: m.pos, dist: Math.hypot(m.pos.x - n.pos.x, m.pos.y - n.pos.y) };
        }).filter((x) => x.dist < 3000),
      };
    });
    const acts: Action[][] = await Promise.all(ids.map((id, i) => nodes.get(id)!.a.tick(views[i])));
    ids.forEach((id, i) => {
      const n = nodes.get(id)!;
      for (const x of acts[i]) {
        if (x.type === 'send' && netUp()) {
          const msg: Msg = { ...x.msg, id: `${id}-${t}`, t, hops: 0 };
          for (const [rid, r] of nodes) if (rid !== id && (x.msg.to === '*' || x.msg.to === rid)) r.inbox.push(msg);
        }
        if (x.type === 'spawnBox') n.inv.push({ box: x.box, measuredKg: x.kg, passport: [] });
        if (x.type === 'moveTo') n.path = [...x.path];
        if (x.type === 'stop') n.path = [];
        if (x.type === 'consume') n.inv = n.inv.filter((c) => c.box.label.packageId !== x.packageId);
        if (x.type === 'stamp') n.inv.find((c) => c.box.label.packageId === x.packageId)?.passport.push(x.receipt);
        if (x.type === 'transfer') {
          const to = nodes.get(x.to)!; const k = n.inv.findIndex((c) => c.box.label.packageId === x.packageId);
          if (k >= 0 && Math.hypot(to.pos.x - n.pos.x, to.pos.y - n.pos.y) <= 25) to.inv.push(...n.inv.splice(k, 1));
        }
      }
      // Move straight toward the path end.
      const goal = n.path[n.path.length - 1];
      if (goal && n.kind === 'van') {
        const d = Math.hypot(goal.x - n.pos.x, goal.y - n.pos.y), stepM = SPEED.van * TICK_DT;
        n.pos = d <= stepM ? { ...goal } : { x: n.pos.x + ((goal.x - n.pos.x) * stepM) / d, y: n.pos.y + ((goal.y - n.pos.y) * stepM) / d };
      }
    });
    t += TICK_DT;
  };
  return { nodes, step, get t() { return t; } };
}

const exposure = (d: BreachDump) => d.knownLocations.length + d.knownStockLevels + d.readableBeneficiaryNotes.length;

describe('wp7 central baseline', () => {
  it('delivers with the network up, and every device then holds the full picture', async () => {
    const w = await world(() => true);
    demand(w);
    let consumed = 0;
    const clinic = w.nodes.get('clinic-1')!;
    for (let i = 0; i < 2 * 3600 / TICK_DT && consumed === 0; i++) {
      await w.step();
      if (clinic.a.receipts().length) consumed = clinic.a.receipts().length;
    }
    expect(consumed).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) await w.step();   // let the next picture broadcast land

    const minimalMesh: BreachDump = { nodeId: 'moto-01', readableLabels: [], knownLocations: [], knownStockLevels: 0, readableBeneficiaryNotes: [], nextHop: 'van-02' };
    for (const id of ['dispatch', 'van-01', 'store-A']) {
      const d = w.nodes.get(id)!.a.dump();
      expect(d.knownLocations.some((l) => l.what === 'store')).toBe(true);
      expect(d.knownStockLevels).toBeGreaterThan(0);
      expect(d.readableBeneficiaryNotes.length).toBeGreaterThan(0);
      expect(exposure(d)).toBeGreaterThan(exposure(minimalMesh));
    }
  }, 120000);

  it('stalls with the network down: no request ever reaches dispatch', async () => {
    const w = await world(() => false);
    demand(w);
    for (let i = 0; i < 3600 / TICK_DT; i++) await w.step();
    expect(w.nodes.get('clinic-1')!.a.receipts()).toHaveLength(0);
    expect(w.nodes.get('dispatch')!.a.dump().knownStockLevels).toBe(0);
  }, 120000);
});
