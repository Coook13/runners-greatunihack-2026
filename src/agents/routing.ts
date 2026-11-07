// Pure routing helpers for the agent brain (PLAN 3.3, 3.5, 12 #7). No state, no I/O: easy to unit test.
import {
  CAPACITY, CELL_COVERAGE, DEMAND, DETOUR_BUDGET, DRONE_RANGE_M, HANDOFF_MARGIN, MEET_OFFSET, RADIO_RANGE, SIZE_UNITS, SPEED, TRANSFER_RADIUS,
  WORLD_SIZE,
} from '../contracts/config';
import type { CarrierKind, Hub, Label, MapQuery, NodeId, NodeKind, Vec2 } from '../contracts/types';

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const isCarrier = (k: NodeKind): k is CarrierKind => k === 'drone' || k === 'motorbike' || k === 'van' || k === 'boat';
export const units = (l: Pick<Label, 'size'>): number => SIZE_UNITS[l.size];

/** Most urgent first, then the earliest deadline, then id (so ties never depend on order of arrival). */
export const byUrgency = <T extends { urgency: number; deadline: number; packageId: string }>(a: T, b: T): number =>
  b.urgency - a.urgency || a.deadline - b.deadline || (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0);

/**
 * Tier rules (PLAN 3.3). Only vans ever take a box from a store, so only vans learn where stores are.
 * Carriers pass boxes to carriers. Clinics are reached by the signed last mile, never by a hand-off.
 */
export function canHandTo(from: NodeKind, to: NodeKind): boolean {
  if (from === 'store') return to === 'van';
  if (!isCarrier(from)) return false;
  return isCarrier(to);
}

/**
 * How close to a store a carrier of this kind could stand before its radio links with the store's
 * (a link needs both ends in range, so it is the shorter of the two ranges). Vans are allowed at stores.
 */
export const storeEarshot = (k: NodeKind): number => (k === 'van' ? 0 : Math.min(RADIO_RANGE[k], RADIO_RANGE.store));

/** A meeting spot is off limits to non-vans if it sits within radio earshot of a store (they would learn the store). */
export function meetAllowed(meet: Vec2, kinds: NodeKind[], knownStores: Vec2[]): boolean {
  const reach = Math.max(0, ...kinds.map(storeEarshot));
  if (!reach) return true;
  return knownStores.every((s) => dist(s, meet) > reach);
}

/**
 * Vans only: the first spot along my road route that is out of every known store's earshot for `kinds`
 * (with room for the random meeting offset), so a drone can take the box there without ever hearing a store.
 * Null when the whole route stays in earshot. Already out of earshot = my own position.
 */
export function releasePoint(path: Vec2[], knownStores: Vec2[], kinds: NodeKind[]): Vec2 | null {
  const reach = Math.max(0, ...kinds.map(storeEarshot)) + MEET_OFFSET[1] + 100;
  const clear = (p: Vec2) => knownStores.every((s) => dist(s, p) >= reach);
  if (!path.length) return null;
  if (clear(path[0])) return { ...path[0] };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (!clear(b)) continue;
    // Walk the segment in 50 m steps to find where it leaves earshot.
    const len = dist(a, b);
    for (let d = 0; d <= len; d += 50) {
      const p = { x: a.x + ((b.x - a.x) * d) / (len || 1), y: a.y + ((b.y - a.y) * d) / (len || 1) };
      if (clear(p)) return p;
    }
    return { ...b };
  }
  return null;
}

/** Vans and motorbikes stick to their job: they will not drive further than DETOUR_BUDGET to meet someone. */
export const detourOk = (kind: CarrierKind, from: Vec2, meet: Vec2): boolean =>
  !(kind === 'van' || kind === 'motorbike') || dist(from, meet) <= DETOUR_BUDGET;

export function nearestHub(hubs: Hub[], p: Vec2): Hub | null {
  let best: Hub | null = null;
  for (const h of hubs) if (!best || dist(h.pos, p) < dist(best.pos, p)) best = h;
  return best;
}

/** Inside a town's cell coverage (public tower map in config.ts), with a small margin. */
export const inCoverage = (p: Vec2, margin = 0): boolean => CELL_COVERAGE.some((c) => dist(p, c.pos) <= c.radius - margin);

const PARK_INSIDE = 300;          // metres inside the coverage edge, so the phone link is solid
const PARK_MAX = 8000;            // never park further than this from home

/**
 * Drones whose home hub has no cell signal: the nearest spot inside a town's coverage that no hub already
 * covers, so vans can reach them by phone while the towers are up. Null when the hub has signal (stay home)
 * or nothing suitable is near. Pure geography: towers and hubs are public, stores are never involved.
 */
export function phoneSpot(home: Vec2, hubs: Hub[]): Vec2 | null {
  if (inCoverage(home)) return null;
  const free = CELL_COVERAGE.filter((c) => hubs.every((h) => dist(h.pos, c.pos) > c.radius));
  let best: Vec2 | null = null;
  for (const c of free.length ? free : CELL_COVERAGE) {
    const d = dist(home, c.pos);
    if (d <= 0 || c.radius <= PARK_INSIDE) continue;
    const k = (c.radius - PARK_INSIDE) / d;
    const p = { x: c.pos.x + (home.x - c.pos.x) * k, y: c.pos.y + (home.y - c.pos.y) * k };
    if (dist(home, p) <= PARK_MAX && (!best || dist(home, p) < dist(home, best))) best = p;
  }
  return best;
}

/** A drone takes a box only if its battery covers: reach the meeting, fly to the clinic, then get back to a hub. */
export function droneCanCarry(battery: number, pos: Vec2, meet: Vec2, dest: Vec2, hubs: Hub[]): boolean {
  const hub = nearestHub(hubs, dest);
  const need = dist(pos, meet) + dist(meet, dest) + (hub ? dist(dest, hub.pos) : 0);
  return battery * DRONE_RANGE_M >= need;
}

const clamp = (v: number) => Math.min(WORLD_SIZE, Math.max(0, v));

/** A spot 100-300 m from the anchor in a random direction, so hand-off places never repeat. */
export function offsetPoint(anchor: Vec2, rng: () => number): Vec2 {
  const r = MEET_OFFSET[0] + rng() * (MEET_OFFSET[1] - MEET_OFFSET[0]);
  const a = rng() * 2 * Math.PI;
  return { x: clamp(anchor.x + r * Math.cos(a)), y: clamp(anchor.y + r * Math.sin(a)) };
}

export interface Party { id: NodeId; kind: CarrierKind; pos: Vec2; battery?: number }

const TRIES_PER_ANCHOR = 6;   // random offsets tried around each anchor before moving to the next one

/**
 * Where two carriers meet. Anchor = midpoint, except a drone meets a ground carrier near the ground carrier
 * (the drone can fly anywhere). If no random offset works for both, fall back to the ground party's own spot.
 */
export function chooseMeetPoint(
  a: Party, b: Party, map: MapQuery, rng: () => number, knownStores: Vec2[] = [], onMyRoute: Vec2[] = [],
): Vec2 | null {
  const mid = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 };
  const ground = a.kind !== 'drone' ? a : b.kind !== 'drone' ? b : null;
  // Spots on a's own planned route come first (a passes them anyway, so they are no detour for a).
  const anchors: { p: Vec2; route: boolean }[] = onMyRoute.map((p) => ({ p, route: true }));
  if (ground && (a.kind === 'drone' || b.kind === 'drone')) anchors.push({ p: ground.pos, route: false });
  anchors.push({ p: mid, route: false });
  const hub = nearestHub(map.hubs(), mid);
  if (hub) anchors.push({ p: hub.pos, route: false });
  const ok = (p: Vec2, route = false) =>
    map.passable(a.kind, p) && map.passable(b.kind, p) &&
    (route || detourOk(a.kind, a.pos, p)) && detourOk(b.kind, b.pos, p) &&
    meetAllowed(p, [a.kind, b.kind], knownStores);
  for (const anchor of anchors) {
    for (let i = 0; i < TRIES_PER_ANCHOR; i++) {
      const p = offsetPoint(anchor.p, rng);
      if (ok(p, anchor.route)) return p;
    }
  }
  // Last resort: meet exactly where one of them already is (always passable for that one).
  for (const p of [...onMyRoute, ground?.pos, b.pos, a.pos]) if (p && ok(p, onMyRoute.includes(p))) return { ...p };
  return null;
}

/**
 * Travel time, or Infinity when this kind can't actually get there. Boats are the case that matters: their
 * route stops at the bank nearest a land target, so a plain eta would look short for a trip they can't finish.
 */
export function etaTo(map: MapQuery, kind: CarrierKind, from: Vec2, to: Vec2): number {
  if (kind === 'boat') {
    const path = map.route(kind, from, to);
    const end = path[path.length - 1] ?? from;
    if (dist(end, to) > TRANSFER_RADIUS) return Infinity;
  }
  const e = map.eta(kind, from, to);
  return Number.isFinite(e) ? e : Infinity;
}

/** Time until the box would reach dest if handed over: both reach the meeting, then the receiver drives on. */
export function handoffEta(map: MapQuery, giver: Party, receiver: Party, meet: Vec2, dest: Vec2): number {
  const meetT = Math.max(map.eta(giver.kind, giver.pos, meet), map.eta(receiver.kind, receiver.pos, meet));
  return meetT + etaTo(map, receiver.kind, meet, dest);
}

/** The 20% rule (PLAN 3.5): only hand over when the other side is clearly faster, so boxes never ping-pong. */
export const beats = (mine: number, theirs: number, margin = HANDOFF_MARGIN): boolean =>
  Number.isFinite(theirs) && theirs < mine * (1 - margin);

export interface Candidate extends Party { spare: number }

export interface HandoffInput {
  me: Party;
  myEta: number;                         // my own time to deliver; Infinity if I can't
  label: Pick<Label, 'size'>;
  dest: Vec2;
  candidates: Candidate[];
  map: MapQuery;
  rng: () => number;
  knownStores?: Vec2[];                  // vans only; empty for everyone else
  pairCounts?: Record<NodeId, number>;   // earlier hand-offs with each partner (pair rotation)
  exclude?: Set<NodeId>;                 // e.g. whoever just gave me this box, or nodes with no valid cert
  onMyRoute?: Vec2[];                    // vans: release spots on my own route (no detour for me)
}

export interface HandoffDecision { to: Candidate; meet: Vec2; myEta: number; theirEta: number }

/**
 * Pick who (if anyone) should take this box. Rules, in order:
 * tier rule, spare capacity, meeting spot both can reach, drone battery, then the 20% ETA margin.
 * Pair rotation (PLAN 12 #7b): among the ones that pass, each earlier hand-off with the same partner
 * adds another 20% to its score, so the same two carriers don't keep pairing up.
 */
export function decideHandoff(i: HandoffInput): HandoffDecision | null {
  const need = units(i.label);
  const sorted = [...i.candidates].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  let best: (HandoffDecision & { score: number }) | null = null;
  for (const c of sorted) {
    if (c.id === i.me.id || i.exclude?.has(c.id)) continue;
    if (!canHandTo(i.me.kind, c.kind) || c.spare < need || need > CAPACITY[c.kind]) continue;
    // Cheapest check: a straight line is the shortest any route can be, so if even that can't beat me, skip routing.
    if (!beats(i.myEta, dist(c.pos, i.dest) / SPEED[c.kind])) continue;
    // Cheap check next: even with no meeting cost they must beat me.
    if (!beats(i.myEta, etaTo(i.map, c.kind, c.pos, i.dest))) continue;
    const meet = chooseMeetPoint(i.me, c, i.map, i.rng, i.knownStores ?? [], i.onMyRoute ?? []);
    if (!meet) continue;
    if (c.kind === 'drone' && !droneCanCarry(c.battery ?? 1, c.pos, meet, i.dest, i.map.hubs())) continue;
    const theirEta = handoffEta(i.map, i.me, c, meet, i.dest);
    if (!beats(i.myEta, theirEta)) continue;
    const score = theirEta * (1 + HANDOFF_MARGIN * (i.pairCounts?.[c.id] ?? 0));
    if (!best || score < best.score) best = { to: c, meet, myEta: i.myEta, theirEta, score };
  }
  if (!best) return null;
  const { score: _s, ...decision } = best;
  return decision;
}

/** A van keeps a box at the hub for drones and motorbikes, unless waiting would risk the deadline. */
export const vanShouldDeliver = (deadline: number, t: number, vanEta: number): boolean =>
  deadline - t < 2 * vanEta;   // leave a spare trip's worth of time

/** PLAN 12 #4: a clinic asking for DEMAND.demandAnomalyX times its usual volume gets flagged for a human. */
export function demandAnomaly(history: number[], next: number): boolean {
  if (history.length < 3) return false;
  const mean = history.reduce((s, v) => s + v, 0) / history.length;
  return next > DEMAND.demandAnomalyX * mean;
}

export const minutes = (sec: number): string => (Number.isFinite(sec) ? `${Math.max(1, Math.round(sec / 60))} min` : 'never');

// ---------- standing relay posts for clinics out of cell coverage (towers up) ----------
/** A hover spot that links a clinic with no cell signal to the phone network: the last post sits in coverage. */
export interface DarkPost { id: string; pos: Vec2; clinic: NodeId; index: number; of: number }
/** "I hold this post", gossiped in beacons so posts out of coverage are known to everyone by phone. */
export interface PostClaim { post: string; by: NodeId; since: number; t: number }

export const POST_REACH = 0.95 * RADIO_RANGE.drone;     // posts sit still, so links are planned close to full range
export const POST_CLAIM_TTL = 20;                       // seconds without a fresh claim and the post is free again
export const MAX_DARK_POSTS = 3;

/** Nearest point `inside` metres within any town's coverage. */
export function nearestCoveragePoint(p: Vec2, inside = 300): Vec2 | null {
  let best: { q: Vec2; d: number } | null = null;
  for (const c of CELL_COVERAGE) {
    if (c.radius <= inside) continue;
    const d = dist(p, c.pos);
    const k = d > 0 ? Math.min(1, (c.radius - inside) / d) : 0;
    const q = { x: c.pos.x + (p.x - c.pos.x) * k, y: c.pos.y + (p.y - c.pos.y) * k };
    const dq = dist(p, q);
    if (!best || dq < best.d) best = { q, d: dq };
  }
  return best?.q ?? null;
}

/**
 * Posts for every known clinic with no cell coverage, unless a covered clinic is in radio range of it (that
 * clinic passes its requests on). Posts are evenly spaced from the clinic to the nearest coverage point, at
 * most POST_REACH apart. Cheapest chains first, within `max` posts in total. Clinics are public (PLAN 13 #18).
 */
export function darkPosts(clinics: { id: NodeId; pos: Vec2 }[], max = MAX_DARK_POSTS): DarkPost[] {
  const sorted = [...clinics].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const covered = sorted.filter((c) => inCoverage(c.pos));
  const chains: DarkPost[][] = [];
  for (const c of sorted) {
    if (inCoverage(c.pos)) continue;
    if (covered.some((o) => dist(o.pos, c.pos) <= 0.95 * RADIO_RANGE.clinic)) continue;
    const q = nearestCoveragePoint(c.pos);
    if (!q) continue;
    const k = Math.max(1, Math.ceil(dist(c.pos, q) / POST_REACH));
    chains.push(Array.from({ length: k }, (_, i) => ({
      id: `post:${c.id}#${i + 1}`, clinic: c.id, index: i + 1, of: k,
      pos: { x: c.pos.x + ((q.x - c.pos.x) * (i + 1)) / k, y: c.pos.y + ((q.y - c.pos.y) * (i + 1)) / k },
    })));
  }
  chains.sort((a, b) => a.length - b.length || (a[0].clinic < b[0].clinic ? -1 : 1));
  const out: DarkPost[] = [];
  let budget = max;
  for (const ch of chains) if (ch.length <= budget) { out.push(...ch); budget -= ch.length; }
  return out;
}

export interface PostCandidate { id: NodeId; pos: Vec2; free: boolean; battery: number }

/**
 * Who holds each post. A live claim keeps it (the earliest claim wins, ties to the lower id), otherwise the
 * nearest free drone with battery for the trip takes it. Everyone who heard the same claims gets the same answer.
 */
export function assignPosts(posts: DarkPost[], cands: PostCandidate[], claims: PostClaim[], now: number, hubs: Hub[]): Map<string, NodeId> {
  const out = new Map<string, NodeId>();
  const taken = new Set<NodeId>();
  const live = claims.filter((c) => now - c.t <= POST_CLAIM_TTL)
    .sort((a, b) => a.since - b.since || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0));
  for (const p of posts) {
    const c = live.find((x) => x.post === p.id && !taken.has(x.by));
    if (c) { out.set(p.id, c.by); taken.add(c.by); }
  }
  const sortedC = [...cands].sort((a, b) => (a.id < b.id ? -1 : 1));
  // Fill each chain from the coverage end outward: a post is only newly staffed once the next one toward
  // coverage is, so the outer drone's claim always has a relay to reach everyone by phone.
  const order = [...posts].sort((a, b) => (a.clinic < b.clinic ? -1 : a.clinic > b.clinic ? 1 : b.index - a.index));
  for (const p of order) {
    if (out.has(p.id)) continue;
    if (p.index < p.of && !out.has(`post:${p.clinic}#${p.index + 1}`)) continue;
    let best: PostCandidate | null = null;
    for (const c of sortedC) {
      if (!c.free || taken.has(c.id) || live.some((x) => x.by === c.id)) continue;
      const hub = nearestHub(hubs, p.pos);
      if (c.battery * DRONE_RANGE_M < dist(c.pos, p.pos) + (hub ? dist(p.pos, hub.pos) : 0) + 2000) continue;
      if (!best || dist(c.pos, p.pos) < dist(best.pos, p.pos)) best = c;
    }
    if (best) { out.set(p.id, best.id); taken.add(best.id); }
  }
  return out;
}
