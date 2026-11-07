// Builds every node before the first tick (PLAN 13, patch 5): keys, certificates, home positions,
// home hubs and patrol loops. One AgentSetup per node, handed to the injected factory.
import { CERT_TTL_SEC, COUNTS } from '../contracts/config';
import type { AgentSetup, Cert, CarrierKind, KeySet, Mode, NodeId, NodeKind, Vec2 } from '../contracts/types';
import { generateKeySet } from '../privacy/core';
import { issueCert } from '../privacy/certs';
import { childRng } from './rng';
import { DISPATCH_POS, dist, type World } from './map';

export interface SharedKeys {
  authorities: KeySet[];      // health ministry, NGO, auditor office: certs need 2 of 3
  auditor: KeySet;            // auditor copy of every manifest (P1)
  store: KeySet;              // shared "store network" key: clinics seal requests to it
}

export interface SetupResult extends SharedKeys {
  setups: AgentSetup[];       // sorted by id
}

const pad = (n: number) => String(n).padStart(2, '0');

// Motorbike and boat patrol loops and the drone split are generated from the map (see fleetPlan below), so the
// same rules work on any district: each clinic belongs to its nearest hub (by road), each hub gets motorbikes
// and drones in proportion to its clinics, and each motorbike loops hub -> its share of those clinics -> hub.
// One hand-picked van per store (store -> the hub it shuttles to when the towers are down). Vans beyond one per
// store go where the demand is: the store nearest the most clinics per van (see vanPlan below).
const VAN_PLAN: { store: NodeId; hub: string }[] = [
  { store: 'store-A', hub: 'hub-2' },
  { store: 'store-B', hub: 'hub-1' },
  { store: 'store-C', hub: 'hub-3' },
];

/** Every van's store and shuttle hub: the fixed ones above, then extra vans to the busiest store per van. */
export function vanPlan(world: World): { store: NodeId; hub: string }[] {
  const stores = world.stores.slice(0, COUNTS.stores);
  const vanEta = (a: Vec2, b: Vec2) => {
    const e = world.map.eta('van', a, b);
    return Number.isFinite(e) ? e : dist(a, b);
  };
  const plan = VAN_PLAN.filter((p) => stores.some((s) => s.id === p.store)).slice(0, COUNTS.vans);
  const demand = new Map(stores.map((s) => [s.id, 0]));
  for (const v of world.villages.slice(0, COUNTS.clinics)) {
    // Same yardstick the stores use to decide who packs (van ETA to the clinic's cell, store.ts claim cost).
    const c = world.map.cellCenter(world.map.cellOf(v.pos));
    const near = stores.reduce((b, s) => (vanEta(s.pos, c) < vanEta(b.pos, c) ? s : b));
    demand.set(near.id, demand.get(near.id)! + 1);
  }
  while (plan.length < COUNTS.vans && stores.length) {
    const vansAt = (id: NodeId) => plan.filter((p) => p.store === id).length;
    // Relieve the busiest van: the store with the most clinics per van it already has gets the next one.
    const load = (id: NodeId) => demand.get(id)! / Math.max(1, vansAt(id));
    const pick = stores.reduce((b, s) => (load(s.id) > load(b.id) ? s : b));
    const used = new Set(plan.filter((p) => p.store === pick.id).map((p) => p.hub));
    const hubs = [...world.hubs].sort((a, b) => vanEta(pick.pos, a.pos) - vanEta(pick.pos, b.pos));
    plan.push({ store: pick.id, hub: (hubs.find((h) => !used.has(h.id)) ?? hubs[0]).id });
  }
  return plan;
}

/** Split n carriers over hubs in proportion to their clinic counts (largest remainder), at least 1 per busy hub. */
function share(n: number, counts: number[]): number[] {
  const busy: number[] = counts.map((c) => (c > 0 ? 1 : 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total || n <= 0) return counts.map(() => 0);
  const base = busy.slice(0, n);
  while (base.length < counts.length) base.push(0);
  const left = n - base.reduce((a, b) => a + b, 0);
  const want = counts.map((c) => (c / total) * left);
  const got = base.map((b, i) => b + Math.floor(want[i]));
  let rest = n - got.reduce((a, b) => a + b, 0);
  const order = want.map((w, i) => ({ i, r: w - Math.floor(w) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) got[order[k].i]++;
  return got;
}

/** Visit points nearest-first from a start, so a patrol loop doesn't zig-zag. */
function tour<T extends { pos: Vec2 }>(start: Vec2, pts: T[]): T[] {
  const left = [...pts];
  const out: T[] = [];
  let at = start;
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (dist(left[i].pos, at) < dist(left[bi].pos, at)) bi = i;
    at = left[bi].pos;
    out.push(...left.splice(bi, 1));
  }
  return out;
}

interface FleetPlan {
  motos: { hub: string; loop: Vec2[] }[];
  boats: { hub: string; patrol: Vec2[] }[];
  droneHubs: string[];
}

/** Patrols and home hubs for motorbikes, boats and drones, derived from the map's hubs and clinics. */
export function fleetPlan(world: World): FleetPlan {
  const villages = world.villages.slice(0, COUNTS.clinics);
  const hubs = world.hubs;
  const roadEta = (a: Vec2, b: Vec2) => {
    const e = world.map.eta('motorbike', a, b);
    return Number.isFinite(e) ? e : dist(a, b) / 1;
  };
  const byHub = hubs.map((h) => ({ hub: h, clinics: [] as typeof villages }));
  for (const v of villages) {
    const best = byHub.reduce((b, x) => (roadEta(x.hub.pos, v.pos) < roadEta(b.hub.pos, v.pos) ? x : b));
    best.clinics.push(v);
  }
  const counts = byHub.map((x) => x.clinics.length);

  const motos: FleetPlan['motos'] = [];
  const motoShare = share(COUNTS.motorbikes, counts);
  byHub.forEach(({ hub, clinics }, hi) => {
    const m = motoShare[hi];
    if (!m) return;
    // Clinics sorted by bearing from the hub, then cut into m runs of neighbours (one per bike).
    const sorted = [...clinics].sort((a, b) =>
      Math.atan2(a.pos.y - hub.pos.y, a.pos.x - hub.pos.x) - Math.atan2(b.pos.y - hub.pos.y, b.pos.x - hub.pos.x));
    for (let k = 0; k < m; k++) {
      const group = m <= sorted.length
        ? sorted.slice(Math.floor((k * sorted.length) / m), Math.floor(((k + 1) * sorted.length) / m))
        : [sorted[k % sorted.length]];
      motos.push({ hub: hub.id, loop: [{ ...hub.pos }, ...tour(hub.pos, group).map((v) => ({ ...v.pos }))] });
    }
  });

  // Boats: the riverside / lakeside clinics, cut into one run per boat by bearing around their centre.
  const wet = villages.filter((v) => v.riverside);
  const boats: FleetPlan['boats'] = [];
  if (wet.length) {
    const c = { x: wet.reduce((s, v) => s + v.pos.x, 0) / wet.length, y: wet.reduce((s, v) => s + v.pos.y, 0) / wet.length };
    const sorted = [...wet].sort((a, b) => Math.atan2(a.pos.y - c.y, a.pos.x - c.x) - Math.atan2(b.pos.y - c.y, b.pos.x - c.x));
    for (let k = 0; k < COUNTS.boats; k++) {
      const group = COUNTS.boats <= sorted.length
        ? sorted.slice(Math.floor((k * sorted.length) / COUNTS.boats), Math.floor(((k + 1) * sorted.length) / COUNTS.boats))
        : [sorted[k % sorted.length]];
      const hub = hubs.reduce((b, h) => (dist(h.pos, group[0].pos) < dist(b.pos, group[0].pos) ? h : b));
      boats.push({ hub: hub.id, patrol: group.map((v) => ({ ...world.water.snap(v.pos).q })) });
    }
  }

  // Drones fly straight, so they split by straight-line nearest hub, not by road.
  const droneCounts = hubs.map(() => 0);
  for (const v of villages) {
    let bi = 0;
    hubs.forEach((h, i) => { if (dist(h.pos, v.pos) < dist(hubs[bi].pos, v.pos)) bi = i; });
    droneCounts[bi]++;
  }
  const droneShare = share(COUNTS.drones, droneCounts);
  const droneHubs: string[] = [];
  // Interleave hubs so drone-01, drone-02, ... spread over the hubs like the old fixed list did.
  for (let k = 0; droneHubs.length < COUNTS.drones && k < COUNTS.drones; k++)
    byHub.forEach(({ hub }, hi) => { if (k < droneShare[hi] && droneHubs.length < COUNTS.drones) droneHubs.push(hub.id); });
  while (droneHubs.length < COUNTS.drones) droneHubs.push(hubs[droneHubs.length % hubs.length].id);
  return { motos, boats, droneHubs };
}

/** Where each carrier starts, its home hub, and its patrol loop. Pure layout, no keys. */
export function layoutNodes(world: World, mode: Mode): { id: NodeId; kind: NodeKind; home: Vec2; hubId?: string; patrol?: Vec2[] }[] {
  const posOf = (id: string): Vec2 => {
    const h = world.hubs.find((x) => x.id === id);
    if (h) return { ...h.pos };
    const v = world.villages.find((x) => x.id === id);
    if (v) return { ...v.pos };
    const s = world.stores.find((x) => x.id === id);
    if (s) return { ...s.pos };
    throw new Error(`unknown place ${id}`);
  };
  // Parked carriers fan out a little around their hub so they don't sit on one pixel.
  const parked = (hub: string, k: number): Vec2 => {
    const p = posOf(hub);
    const a = k * 2.399;                                            // golden angle
    return { x: p.x + 40 * Math.cos(a), y: p.y + 40 * Math.sin(a) };
  };
  const out: ReturnType<typeof layoutNodes> = [];
  world.stores.slice(0, COUNTS.stores).forEach((s) => out.push({ id: s.id, kind: 'store', home: { ...s.pos } }));
  world.villages.slice(0, COUNTS.clinics).forEach((v) => out.push({ id: v.clinicId, kind: 'clinic', home: { ...v.pos } }));
  vanPlan(world).forEach((p, i) =>
    out.push({ id: `van-${pad(i + 1)}`, kind: 'van', home: posOf(p.store), hubId: p.hub, patrol: [posOf(p.store), posOf(p.hub)] }));
  const plan = fleetPlan(world);
  plan.droneHubs.forEach((hub, i) =>
    out.push({ id: `drone-${pad(i + 1)}`, kind: 'drone', home: parked(hub, i), hubId: hub }));
  plan.motos.forEach((p, i) =>
    out.push({ id: `moto-${pad(i + 1)}`, kind: 'motorbike', home: parked(p.hub, i + 10), hubId: p.hub, patrol: p.loop }));
  plan.boats.forEach((p, i) =>
    out.push({ id: `boat-${pad(i + 1)}`, kind: 'boat', home: { ...p.patrol[0] }, hubId: p.hub, patrol: p.patrol }));
  if (mode === 'central') out.push({ id: 'dispatch', kind: 'dispatch', home: { ...DISPATCH_POS } });
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function makeSharedKeys(): Promise<SharedKeys> {
  return {
    authorities: await Promise.all([generateKeySet(), generateKeySet(), generateKeySet()]),
    auditor: await generateKeySet(),
    store: await generateKeySet(),
  };
}

/** One node's setup. `certified: false` makes an intruder (attack console) with no certificate. */
export async function makeSetup(
  seed: number, node: { id: NodeId; kind: NodeKind; home: Vec2; hubId?: string; patrol?: Vec2[] },
  shared: SharedKeys, storeIds: NodeId[], certified = true, keys?: KeySet,
): Promise<AgentSetup> {
  const k = keys ?? (await generateKeySet());
  const cert: Cert | null = certified
    ? await issueCert(node.id, node.kind, k.signPub, CERT_TTL_SEC, shared.authorities)
    : null;
  const isStore = node.kind === 'store';
  return {
    id: node.id,
    kind: node.kind,
    keys: k,
    cert,
    storeSealPub: shared.store.sealPub,
    storeSealPriv: isStore ? shared.store.sealPriv : undefined,
    storeIds: isStore ? storeIds.filter((s) => s !== node.id) : [],
    auditorSealPub: shared.auditor.sealPub,
    authoritySignPubs: shared.authorities.map((a) => a.signPub),
    home: { ...node.home },
    hubId: node.hubId,
    patrol: node.patrol?.map((p) => ({ ...p })),
    rng: childRng(seed, node.id),
  };
}

/** Every node for one run. Keys are fresh each run; they never change a sim decision. */
export async function buildSetups(seed: number, mode: Mode, world: World): Promise<SetupResult> {
  const shared = await makeSharedKeys();
  const nodes = layoutNodes(world, mode);
  const storeIds = nodes.filter((n) => n.kind === 'store').map((n) => n.id);
  const setups = await Promise.all(nodes.map((n) => makeSetup(seed, n, shared, storeIds)));
  return { ...shared, setups };
}

/** The hub nearest a point (used when an intruder spawns without a home hub). */
export const nearestHub = (world: World, p: Vec2): string =>
  world.hubs.reduce((best, h) => (dist(h.pos, p) < dist(best.pos, p) ? h : best)).id;

export const isCarrier = (k: NodeKind): k is CarrierKind => k === 'drone' || k === 'motorbike' || k === 'van' || k === 'boat';
