// Swarm behaviours for carriers: who takes which box (a local auction), drones that hover as radio relays
// when the mesh splits, separation and formations in flight, patrol coverage of clinics, and return-to-charge.
// Pure and deterministic: every function takes what ONE carrier knows (its own view plus the beacons it heard)
// and returns a decision plus plain-English reasons for the inspector log. No global state, never src/sim.
import {
  CAPACITY, CELL_COVERAGE, DETOUR_BUDGET, DRONE_RANGE_M, HANDOFF_MARGIN, MEET_OFFSET, RADIO_RANGE, RESEND_EVERY, SIZE_UNITS,
  SPEED, WORLD_SIZE,
} from '../contracts/config';
import type { CarrierKind, CellId, Hub, Label, MapQuery, NodeId, NodeKind, NodeState, SizeClass, Urgency, Vec2 } from '../contracts/types';
import { BEACON_EVERY } from './common';
import { canHandTo, dist, droneCanCarry, minutes, nearestHub } from './routing';

/** Every swarm number in one place, so the lead can tune them without reading the code. */
export const SWARM = {
  FRESH_SEC: 3 * BEACON_EVERY + 0.5,       // heard this recently = in my radio group right now
  STALE_MAX_SEC: 300,                      // older than this, even a slow carrier's last position is a guess
  // auction
  ETA_REF_SEC: 600,                        // bid = weight * REF / (REF + eta): 10 min away scores half
  URGENCY_WEIGHT: { 1: 1, 2: 1.5, 3: 2.2 } as Record<Urgency, number>,
  LOAD_WEIGHT: 0.3,                        // a full hold costs this much bid
  OUTBID_MARGIN: 0.02,                     // a challenger must beat the standing winner by this much (no ping-pong)
  DROP_TOLERANCE: 0.2,                     // a winner keeps its bid frozen unless its fresh bid falls 20% below it
  SETTLE_SEC: 2 * BEACON_EVERY,            // hold a win this long before acting on it
  WINNER_TIMEOUT_SEC: 6 * BEACON_EVERY,    // a winner silent this long loses the box: re-auction (covers 6 hops)
  RETRACT_GRACE_SEC: 2 * BEACON_EVERY + 0.5,
  AWARD_TIMEOUT_SEC: RESEND_EVERY,         // a win with no hand-off offer for this long is withdrawn
  COOL_SEC: 2 * RESEND_EVERY,
  SEEN_TTL_SEC: 60,
  // relays
  MAX_RELAYS: 3,
  RELAY_SAFETY: 0.85,                      // plan links at 85% of radio range (positions are a few seconds old)
  RELAY_ALT: 160,
  RELAY_MAX_DIST: 10000,
  // flight
  SEP_MIN: 80, SEP_BUFFER: 120, ALT_SEP: 10, ALT_EAST: 110, ALT_WEST: 130, ALT_STEP: 10, MAX_SUBLAYER: 2,
  LOOKAHEAD_SEC: 10, CLIMB_RATE: 5, CONSIDER_R: 3000,
  ALIGN_RADIUS: 400, ALIGN_DEG: 30, ALIGN_WEIGHT: 0.3, ALIGN_MAX_DEG: 15,
  ARRIVE_DIST: 200,
  // formation
  FORMATION_RADIUS: 1500, V_BACK: 110, V_SIDE: 110, LINE_GAP: 130, FORM_GAIN: 0.1, LEADER_EASE: 0.8, LEADER_HYST: 150,
  LAG_DIST: 330, BREAK_DIST: 500,
  // patrol
  VISIT_RADIUS: 250, PATROL_MAX_ETA: 1800, CLAIM_TTL_SEC: 120,
  // charging
  RESERVE_M: 2000, RETURN_FACTOR: 1.3, RESUME_AT: 0.9,
  // network
  NET_TTL_SEC: 600,
};
export const MAX_BID = Math.max(...Object.values(SWARM.URGENCY_WEIGHT));

// ---------- small helpers ----------
const V = (x: number, y: number): Vec2 => ({ x, y });
const add = (a: Vec2, b: Vec2): Vec2 => V(a.x + b.x, a.y + b.y);
const sub = (a: Vec2, b: Vec2): Vec2 => V(a.x - b.x, a.y - b.y);
const mul = (a: Vec2, k: number): Vec2 => V(a.x * k, a.y * k);
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const len = (a: Vec2): number => Math.hypot(a.x, a.y);
const unit = (a: Vec2): Vec2 => { const l = len(a); return l > 1e-9 ? V(a.x / l, a.y / l) : V(0, 0); };
const clampLen = (a: Vec2, max: number): Vec2 => (len(a) > max ? mul(unit(a), max) : a);
const rotate = (a: Vec2, r: number): Vec2 => V(a.x * Math.cos(r) - a.y * Math.sin(r), a.x * Math.sin(r) + a.y * Math.cos(r));
const angleBetween = (a: Vec2, b: Vec2): number => Math.atan2(a.x * b.y - a.y * b.x, dot(a, b));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const km = (m: number): string => `${(m / 1000).toFixed(1)} km`;
const sortedKeys = <T>(o: Record<string, T>): string[] => Object.keys(o).sort(cmp);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length < 120;
const rec = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const CARRIER_KINDS: CarrierKind[] = ['drone', 'motorbike', 'van', 'boat'];
const NODE_KINDS: NodeKind[] = [...CARRIER_KINDS, 'store', 'clinic', 'dispatch'];

/** Two bids shown so they never look equal when they are not. */
function showPair(a: number, b: number): [string, string] {
  return a.toFixed(2) === b.toFixed(2) ? [a.toFixed(3), b.toFixed(3)] : [a.toFixed(2), b.toFixed(2)];
}
const groupName = (ids: NodeId[]): string =>
  ids.length <= 3 ? ids.join(', ') : `${ids.slice(0, 2).join(', ')} +${ids.length - 2}`;

// ================================================================================================
// What a carrier knows about others: one Peer per beacon it heard (fresh or stale), plus clinics it met.
// ================================================================================================
export type SwarmRole = 'courier' | 'relay' | 'patrol' | 'idle' | 'charging';
export interface HoldingInfo { packageId: string; destCell: CellId; urgency: Urgency; size?: SizeClass }
export interface NetObservation { down: boolean; t: number; by: NodeId }

/** Extra beacon fields the swarm needs (proposed as an optional `swarm` field on Beacon; see swarm-notes.md). */
export interface SwarmBeacon {
  bids: Bid[];                            // my winner table: best live bid per task (CBBA "who wins what")
  seen: Record<NodeId, number>;           // freshest time I have heard from each node (CBBA timestamps)
  role: SwarmRole;
  dest?: CellId;                          // the cell I am flying to now (formations)
  vel?: Vec2;                             // m/s (separation, alignment)
  alt?: number;                           // metres (separation)
  relaySlot?: string;                     // relay post I hold
  patrolClaim?: { site: string; t: number };
  visits?: Record<string, number>;        // last visit per clinic I know
  net?: NetObservation;                   // freshest first-hand "towers up/down" I know
}

export interface Peer {
  id: NodeId;
  kind: NodeKind;
  pos: Vec2;
  heardAt: number;
  battery?: number;
  holding?: HoldingInfo[];
  swarm?: Partial<SwarmBeacon>;
}

/** Beacons are unsigned and can come from an intruder, so every field is checked before use. */
export function readSwarm(raw: unknown): Partial<SwarmBeacon> | undefined {
  const r = rec(raw);
  if (!r) return undefined;
  const out: Partial<SwarmBeacon> = {};
  if (Array.isArray(r.bids)) {
    out.bids = r.bids.flatMap((b) => {
      const x = rec(b);
      return x && isStr(x.task) && isStr(x.bidder) && isNum(x.value) && isNum(x.stamp)
        ? [{ task: x.task, bidder: x.bidder, value: x.value, stamp: x.stamp }] : [];
    });
  }
  const seen = rec(r.seen);
  if (seen) out.seen = Object.fromEntries(Object.entries(seen).filter(([k, t]) => isStr(k) && isNum(t))) as Record<NodeId, number>;
  if (isStr(r.role) && ['courier', 'relay', 'patrol', 'idle', 'charging'].includes(r.role)) out.role = r.role as SwarmRole;
  if (isStr(r.dest)) out.dest = r.dest;
  const vel = rec(r.vel);
  if (vel && isNum(vel.x) && isNum(vel.y)) out.vel = V(vel.x, vel.y);
  if (isNum(r.alt)) out.alt = r.alt;
  if (isStr(r.relaySlot)) out.relaySlot = r.relaySlot;
  const pc = rec(r.patrolClaim);
  if (pc && isStr(pc.site) && isNum(pc.t)) out.patrolClaim = { site: pc.site, t: pc.t };
  const visits = rec(r.visits);
  if (visits) out.visits = Object.fromEntries(Object.entries(visits).filter(([k, t]) => isStr(k) && isNum(t))) as Record<string, number>;
  const net = rec(r.net);
  if (net && typeof net.down === 'boolean' && isNum(net.t) && isStr(net.by)) out.net = { down: net.down, t: net.t, by: net.by };
  return out;
}

/** A Peer from a beacon body. `livePos` = exact position when it is also a radio neighbour this tick. */
export function peerFromBeacon(body: unknown, heardAt: number, livePos?: Vec2): Peer | null {
  const b = rec(body);
  const pos = rec(b?.pos);
  if (!b || !isStr(b.id) || !isStr(b.kind) || !NODE_KINDS.includes(b.kind as NodeKind) || !pos || !isNum(pos.x) || !isNum(pos.y)) return null;
  const holding = Array.isArray(b.holding)
    ? b.holding.flatMap((h) => {
      const x = rec(h);
      if (!x || !isStr(x.packageId) || !isStr(x.destCell) || ![1, 2, 3].includes(x.urgency as number)) return [];
      const size: SizeClass | undefined = x.size === 'S' || x.size === 'M' || x.size === 'L' ? x.size : undefined;
      const item: HoldingInfo = { packageId: x.packageId, destCell: x.destCell, urgency: x.urgency as Urgency, ...(size ? { size } : {}) };
      return [item];
    })
    : undefined;
  return {
    id: b.id, kind: b.kind as NodeKind, pos: livePos ? { ...livePos } : V(pos.x, pos.y), heardAt,
    ...(isNum(b.battery) ? { battery: Math.max(0, Math.min(1, b.battery)) } : {}),
    ...(holding ? { holding } : {}),
    ...(b.swarm !== undefined ? { swarm: readSwarm(b.swarm) } : {}),
  };
}

const fresh = (p: Peer, now: number): boolean => now - p.heardAt <= SWARM.FRESH_SEC;

/** The box a carrier is flying first: most urgent, then packageId (same rule for everyone). */
export function primaryDest(holding: { destCell: CellId; urgency: Urgency; packageId?: string }[] | undefined): CellId | null {
  if (!holding?.length) return null;
  const h = [...holding].sort((a, b) => b.urgency - a.urgency || cmp(a.packageId ?? '', b.packageId ?? '') || cmp(a.destCell, b.destCell));
  return h[0].destCell;
}

// ================================================================================================
// 1. Task allocation by local auction (CBBA-style: bundle building + timestamped max-consensus)
// ================================================================================================
export interface Bid { task: string; bidder: NodeId; value: number; stamp: number }

/** One hand-off leg: "box p-17, now held by van-02, needs a next carrier". A new holder means a new task. */
export interface Task {
  id: string;
  packageId: string;
  holder: NodeId;
  holderKind: CarrierKind;
  pos: Vec2;                               // holder's last known position
  dest: Vec2;                              // centre of the destination cell
  destCell: CellId;
  urgency: Urgency;
  units: number;
}
export const taskId = (packageId: string, holder: NodeId): string => `${packageId}@${holder}`;

export interface Bidder { id: NodeId; kind: CarrierKind; pos: Vec2; battery: number; spare: number }
export interface Gossip { from: NodeId; t: number; bids: Bid[]; seen: Record<NodeId, number> }

export interface AuctionState {
  table: Record<string, Bid>;              // best live bid per task, mine included
  runnerUp: Record<string, Bid>;           // second best (log lines only, not gossiped)
  seen: Record<NodeId, number>;
  mine: Record<string, { value: number; since: number }>;
  cool: Record<string, number>;            // tasks I gave up on, until when
}
export const emptyAuction = (): AuctionState => ({ table: {}, runnerUp: {}, seen: {}, mine: {}, cool: {} });

export interface AuctionInput {
  me: Bidder;                              // spare = capacity minus what I already hold
  now: number;
  tasks: Task[];                           // tasks I know now (boxTasks + ownTasks)
  gossip: Gossip[];                        // swarm fields from beacons received THIS tick
  map: Pick<MapQuery, 'eta' | 'hubs'>;
  trusted?: (id: NodeId) => boolean;       // e.g. not in my blocked set (no cert)
  bidding?: boolean;                       // vans listen but do not bid
  engaged?: string[];                      // task ids with a hand-off deal in progress
}
export interface Award { task: Task; value: number; since: number; settled: boolean }
export interface AuctionResult {
  state: AuctionState;
  wins: Award[];
  out: { bids: Bid[]; seen: Record<NodeId, number> };   // put these in my beacon
  reasons: string[];
}

/** Tasks from fresh beacons: every box another carrier holds that is not already at its last mile. */
export function boxTasks(peers: Peer[], now: number, map: Pick<MapQuery, 'cellCenter'>, me?: NodeId): Task[] {
  const out: Task[] = [];
  for (const p of [...peers].sort((a, b) => cmp(a.id, b.id))) {
    if (p.id === me || !fresh(p, now) || !CARRIER_KINDS.includes(p.kind as CarrierKind)) continue;
    for (const h of p.holding ?? []) {
      const dest = map.cellCenter(h.destCell);
      if (dist(p.pos, dest) <= 2000) continue;                 // it is already doing the last mile
      out.push({
        id: taskId(h.packageId, p.id), packageId: h.packageId, holder: p.id, holderKind: p.kind as CarrierKind,
        pos: { ...p.pos }, dest, destCell: h.destCell, urgency: h.urgency, units: SIZE_UNITS[h.size ?? 'M'],
      });
    }
  }
  return out;
}

/** My own boxes as tasks, so I can see (and log) who wins the next leg. */
export function ownTasks(me: { id: NodeId; kind: CarrierKind; pos: Vec2 }, labels: Label[], map: Pick<MapQuery, 'cellCenter'>): Task[] {
  return labels.map((l) => ({
    id: taskId(l.packageId, me.id), packageId: l.packageId, holder: me.id, holderKind: me.kind, pos: { ...me.pos },
    dest: map.cellCenter(l.destCell), destCell: l.destCell, urgency: l.urgency, units: SIZE_UNITS[l.size],
  })).sort((a, b) => cmp(a.id, b.id));
}

export const gossipFromPeer = (p: Peer): Gossip | null =>
  p.swarm?.bids || p.swarm?.seen ? { from: p.id, t: p.heardAt, bids: p.swarm.bids ?? [], seen: p.swarm.seen ?? {} } : null;

type BidCalc = { ok: true; base: number; eta: number; holderEta: number } | { ok: false; why: string };
const ground = (k: CarrierKind) => k === 'van' || k === 'motorbike';

/** My bid for one task with an empty hold: urgency-weighted inverse ETA (pickup + delivery). Load is taken off later. */
export function bidFor(me: Bidder, t: Task, map: Pick<MapQuery, 'eta' | 'hubs'>): BidCalc {
  if (t.holder === me.id) return { ok: false, why: 'it is my own box' };
  if (!canHandTo(t.holderKind, me.kind)) return { ok: false, why: `tier rule: a ${me.kind} can't take a box from a ${t.holderKind}` };
  if (t.units > CAPACITY[me.kind]) return { ok: false, why: `too big for a ${me.kind}` };
  if (ground(me.kind) && ground(t.holderKind) && dist(me.pos, t.pos) > 2 * DETOUR_BUDGET) return { ok: false, why: 'too far to meet by road' };
  const eta = map.eta(me.kind, me.pos, t.pos) + map.eta(me.kind, t.pos, t.dest);
  if (!Number.isFinite(eta)) return { ok: false, why: `I can't reach ${t.destCell}` };
  if (me.kind === 'drone' && !droneCanCarry(me.battery, me.pos, t.pos, t.dest, map.hubs())) return { ok: false, why: 'battery too low' };
  const holderEta = map.eta(t.holderKind, t.pos, t.dest);
  if (!(eta < holderEta * (1 - HANDOFF_MARGIN))) {
    return { ok: false, why: `${t.holder} gets it there in ${minutes(holderEta)}, I'd take ${minutes(eta)} (needs 20% better)` };
  }
  return { ok: true, base: (SWARM.URGENCY_WEIGHT[t.urgency] * SWARM.ETA_REF_SEC) / (SWARM.ETA_REF_SEC + eta), eta, holderEta };
}

/** Total order every node uses: higher bid wins, a tie goes to the lower NodeId. */
const better = (a: Bid, b: Bid): number => b.value - a.value || cmp(a.bidder, b.bidder);

/**
 * One auction round for one carrier. Call it every tick, before building the beacon.
 * a. Merge: timestamps take the max; per task, each bidder's freshest bid counts; bids go stale when the bidder
 *    has been silent for WINNER_TIMEOUT (re-auction) or has spoken since without renewing it (withdrawn).
 * b. Bundle: I add tasks in order of my bid while I have room. I take a task if nobody beats me
 *    (challengers must clear OUTBID_MARGIN; a standing winner defends with its frozen bid).
 * Everyone applies the same order (value, then NodeId), so all nodes that heard the same bids agree.
 */
export function auctionStep(prev: AuctionState, i: AuctionInput): AuctionResult {
  const S = SWARM, now = i.now, me = i.me.id;
  const trusted = (id: NodeId) => id === me || (i.trusted ? i.trusted(id) : true);
  const reasons: string[] = [];
  const known = new Map(i.tasks.map((t) => [t.id, t] as const));
  const label = (id: string) => { const t = known.get(id); return t ? `${t.packageId} (${t.holder}'s box to ${t.destCell})` : id; };

  // a. timestamps
  const seen: Record<NodeId, number> = {};
  for (const k of sortedKeys(prev.seen)) if (now - prev.seen[k] <= S.SEEN_TTL_SEC) seen[k] = prev.seen[k];
  seen[me] = now;
  const bump = (k: NodeId, t: number) => { if (t <= now && t > (seen[k] ?? -Infinity)) seen[k] = t; };
  const gossip = i.gossip.filter((g) => trusted(g.from)).sort((a, b) => cmp(a.from, b.from) || a.t - b.t);
  for (const g of gossip) {
    bump(g.from, g.t);
    for (const k of sortedKeys(g.seen)) if (trusted(k) && k !== me) bump(k, g.seen[k]);
  }

  // a. candidate bids: per task, per bidder, the freshest one
  const cand = new Map<string, Map<NodeId, Bid>>();
  const addBid = (b: Bid, from: NodeId) => {
    if (b.bidder === me || !trusted(b.bidder) || !(b.value > 0) || b.stamp > now) return;
    if (b.value > MAX_BID) { reasons.push(`Ignored a bid of ${b.value.toFixed(2)} from ${b.bidder} via ${from}: above the highest possible bid.`); return; }
    const per = cand.get(b.task) ?? new Map<NodeId, Bid>();
    const old = per.get(b.bidder);
    if (!old || b.stamp > old.stamp) per.set(b.bidder, { ...b });
    cand.set(b.task, per);
  };
  for (const k of sortedKeys(prev.table)) addBid(prev.table[k], me);
  for (const g of gossip) for (const b of g.bids) addBid(b, g.from);

  const table: Record<string, Bid> = {};
  const runnerUp: Record<string, Bid> = {};
  const alive = (b: Bid) => now - b.stamp <= S.WINNER_TIMEOUT_SEC && !((seen[b.bidder] ?? -Infinity) > b.stamp + S.RETRACT_GRACE_SEC);
  for (const task of [...cand.keys()].sort(cmp)) {
    const live = [...cand.get(task)!.values()].filter(alive).sort(better);
    const was = prev.table[task];
    if (was && was.bidder !== me && known.has(task) && !live.some((b) => b.bidder === was.bidder)) {
      reasons.push(now - was.stamp > S.WINNER_TIMEOUT_SEC
        ? `Winner ${was.bidder} for ${label(task)} went silent ${Math.round(now - was.stamp)} s ago: re-auctioning.`
        : `${was.bidder} withdrew its bid for ${label(task)}: re-auctioning.`);
    }
    if (live[0]) table[task] = live[0];
    if (live[1]) runnerUp[task] = live[1];
  }

  // b. bundle building
  const mine: AuctionState['mine'] = {};
  const cool: Record<string, number> = {};
  for (const k of sortedKeys(prev.cool)) if (prev.cool[k] > now) cool[k] = prev.cool[k];
  const engaged = new Set(i.engaged ?? []);
  if (i.bidding !== false) {
    const cap = CAPACITY[i.me.kind];
    let spare = i.me.spare;
    let load = cap - spare;
    const options: { task: Task; base: number; sortVal: number }[] = [];
    for (const t of [...known.values()].sort((a, b) => cmp(a.id, b.id))) {
      if (t.holder === me || cool[t.id] !== undefined) continue;
      const c = bidFor(i.me, t, i.map);
      if (!c.ok) {
        if (prev.mine[t.id]) reasons.push(`Dropping my bid for ${label(t.id)}: ${c.why}.`);
        continue;
      }
      options.push({ task: t, base: c.base, sortVal: prev.mine[t.id]?.value ?? c.base });
    }
    options.sort((a, b) => b.sortVal - a.sortVal || cmp(a.task.id, b.task.id));
    for (const o of options) {
      const id = o.task.id;
      const held = prev.mine[id];
      if (o.task.units > spare) {
        if (held) reasons.push(`Dropping my bid for ${label(id)}: no room left in my hold.`);
        continue;
      }
      const freshVal = r3(o.base - (S.LOAD_WEIGHT * load) / cap);
      const value = held && freshVal >= held.value * (1 - S.DROP_TOLERANCE) ? held.value : freshVal;
      if (!(value > 0)) continue;
      const top = table[id];
      const win = held
        ? !top || better({ task: id, bidder: me, value, stamp: now }, top) < 0
        : !top || value > top.value + S.OUTBID_MARGIN;
      if (!win) {
        if (held && top) { const [a, b] = showPair(top.value, value); reasons.push(`Lost ${label(id)}: ${top.bidder} bid ${a} vs my ${b}.`); }
        continue;
      }
      if (held && now - held.since > S.AWARD_TIMEOUT_SEC && !engaged.has(id)) {
        cool[id] = now + S.COOL_SEC;
        reasons.push(`No hand-off offer from ${o.task.holder} for ${o.task.packageId} after ${Math.round(now - held.since)} s: withdrawing my bid.`);
        continue;
      }
      if (top) runnerUp[id] = top;
      table[id] = { task: id, bidder: me, value, stamp: now };
      mine[id] = { value, since: held ? held.since : now };
      if (!held) {
        if (top) { const [a, b] = showPair(value, top.value); reasons.push(`Bid ${a} for ${label(id)}; ${top.bidder} bid ${b}; I win.`); }
        else reasons.push(`Bid ${value.toFixed(2)} for ${label(id)}; no other bids; I win.`);
      }
      spare -= o.task.units;
      load += o.task.units;
    }
  }
  for (const id of sortedKeys(table)) if (table[id].bidder === me && !mine[id]) delete table[id];

  const wins: Award[] = sortedKeys(mine).flatMap((id) => {
    const t = known.get(id);
    return t ? [{ task: t, value: mine[id].value, since: mine[id].since, settled: now - mine[id].since >= S.SETTLE_SEC }] : [];
  });
  const state: AuctionState = { table, runnerUp, seen, mine, cool };
  return { state, wins, out: { bids: sortedKeys(table).map((k) => table[k]), seen: { ...seen } }, reasons };
}

/** Holder side: who won the next leg of my box, with a log line. Null = nobody beats me by 20%: keep it. */
export function auctionWinner(state: AuctionState, task: string): { bid: Bid; reason: string } | null {
  const bid = state.table[task];
  if (!bid) return null;
  const ru = state.runnerUp[task];
  const [a, b] = ru ? showPair(bid.value, ru.value) : [bid.value.toFixed(2), ''];
  return { bid, reason: `Auction for ${task.split('@')[0]}: ${bid.bidder} won with ${a}${ru ? ` (runner-up ${ru.bidder} ${b})` : ''}. Offering it the box.` };
}

// ================================================================================================
// Network status: is the cell network down? A node inside town coverage with no signal knows first-hand;
// everyone else learns it from beacons. The freshest observation wins.
// ================================================================================================
export const inTownCoverage = (p: Vec2): boolean => CELL_COVERAGE.some((c) => dist(p, c.pos) <= c.radius - 50);

export function netStatus(i: { me: NodeId; pos: Vec2; cellSignal: boolean; now: number; peers: Peer[]; prev?: NetObservation | null }): {
  obs: NetObservation | null; down: boolean; reasons: string[];
} {
  const own: NetObservation | null = i.cellSignal ? { down: false, t: i.now, by: i.me }
    : inTownCoverage(i.pos) ? { down: true, t: i.now, by: i.me } : null;
  const all = [own, i.prev ?? null, ...i.peers.map((p) => p.swarm?.net ?? null)]
    .filter((o): o is NetObservation => !!o && o.t <= i.now && i.now - o.t <= SWARM.NET_TTL_SEC)
    .sort((a, b) => b.t - a.t || cmp(a.by, b.by));
  const obs = all[0] ?? null;
  const down = obs?.down ?? false;
  const reasons: string[] = [];
  if (down !== (i.prev?.down ?? false)) {
    reasons.push(down
      ? obs!.by === i.me ? 'No cell signal inside town coverage: the towers are down. Mesh only from here.'
        : `${obs!.by} reports the towers are down. Mesh only from here.`
      : 'Cell network is back up.');
  }
  return { obs, down, reasons };
}

// ================================================================================================
// 2. Connectivity relays: when the towers are down and the mesh I know about has split into groups,
// idle drones hover on the line between the closest members of two groups. Groups are worked out from
// last known positions (relays left out), so a bridge stays in place once it works: no flapping.
// ================================================================================================
export interface RelaySlot {
  id: string;                              // relay:<groupA>~<groupB>#<n>, stable while the groups exist
  pos: Vec2;
  cell: CellId | null;
  index: number;
  of: number;
  bridge: [NodeId, NodeId];                // the two members it links
  groups: [NodeId[], NodeId[]];
  gap: number;
  assignee: NodeId | null;
}
export interface RelayInput {
  me: { id: NodeId; kind: NodeKind; pos: Vec2; battery: number; carrying: { urgency: Urgency }[]; busy?: boolean; relaySlot?: string | null };
  now: number;
  networkDown: boolean;
  peers: Peer[];                           // carriers from beacons (fresh and stale) + clinics met (never move)
  hubs: Hub[];
  maxRelays?: number;
  cellOf?: (p: Vec2) => CellId;
}
export interface RelayPlan {
  groups: NodeId[][];
  slots: RelaySlot[];
  mine: RelaySlot | null;
  role: 'relay' | null;
  phase: 'relay' | null;
  alt: number | null;
  reasons: string[];
}
interface GNode { id: NodeId; kind: NodeKind; pos: Vec2; weight: number }

const linkRange = (a: NodeKind, b: NodeKind) => Math.min(RADIO_RANGE[a], RADIO_RANGE[b]);
const relayReach = (k: NodeKind) => Math.min(RADIO_RANGE.drone, RADIO_RANGE[k]) * SWARM.RELAY_SAFETY;
/** Fewest relays that close a gap: first and last legs reach the end nodes, the middle legs are drone to drone. */
export function relaysNeeded(gap: number, a: NodeKind, b: NodeKind): number {
  const ra = relayReach(a), rb = relayReach(b), rd = RADIO_RANGE.drone * SWARM.RELAY_SAFETY;
  return gap <= ra + rb ? 1 : 1 + Math.ceil((gap - ra - rb) / rd);
}

/** Radio groups from positions: two nodes link when both are within each other's range. */
export function radioGroups<T extends { id: NodeId; kind: NodeKind; pos: Vec2 }>(nodes: T[]): T[][] {
  const ns = [...nodes].sort((a, b) => cmp(a.id, b.id));
  const parent = ns.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  for (let a = 0; a < ns.length; a++) {
    for (let b = a + 1; b < ns.length; b++) {
      if (dist(ns[a].pos, ns[b].pos) <= linkRange(ns[a].kind, ns[b].kind)) parent[find(a)] = find(b);
    }
  }
  const byRoot = new Map<number, T[]>();
  ns.forEach((n, k) => { const r = find(k); byRoot.set(r, [...(byRoot.get(r) ?? []), n]); });
  return [...byRoot.values()].sort((x, y) => cmp(x[0].id, y[0].id));
}

export function planRelays(i: RelayInput): RelayPlan {
  const S = SWARM, now = i.now, me = i.me;
  const max = i.maxRelays ?? S.MAX_RELAYS;
  const empty = (reasons: string[]): RelayPlan => ({ groups: [], slots: [], mine: null, role: null, phase: null, alt: null, reasons });
  if (me.kind !== 'drone') return empty([]);
  if (!i.networkDown) return empty(me.relaySlot ? ['Towers are back up: leaving my relay post.'] : []);

  // Who I can place on the map. Stores never (a drone must not learn them), relays left out, drones only when fresh.
  const latest = new Map<NodeId, Peer>();
  for (const p of i.peers) if (p.id !== me.id && (!latest.has(p.id) || p.heardAt > latest.get(p.id)!.heardAt)) latest.set(p.id, p);
  const nodes: GNode[] = [];
  if (!me.relaySlot) nodes.push({ id: me.id, kind: me.kind, pos: me.pos, weight: me.carrying.length ? 2 : 1 });
  for (const p of [...latest.values()].sort((a, b) => cmp(a.id, b.id))) {
    if (p.kind === 'store' || p.kind === 'dispatch' || !(RADIO_RANGE[p.kind] > 0)) continue;
    const age = now - p.heardAt;
    if (p.kind !== 'clinic') {
      if (age > (p.kind === 'drone' ? S.FRESH_SEC : S.STALE_MAX_SEC)) continue;
      if (age <= S.FRESH_SEC && p.swarm?.role === 'relay') continue;
    }
    nodes.push({ id: p.id, kind: p.kind, pos: { ...p.pos }, weight: p.kind === 'clinic' || p.holding?.length ? 2 : 1 });
  }
  const comps = radioGroups(nodes);
  const groups = comps.map((c) => c.map((n) => n.id));
  const weight = (c: GNode[]) => c.reduce((s, n) => s + n.weight, 0);

  // Candidate bridges between groups that matter (a clinic, a box, or two nodes), cheapest per relay first.
  type Edge = { a: number; b: number; na: GNode; nb: GNode; gap: number; k: number; benefit: number };
  const sig = comps.map((c, k) => ({ c, k })).filter((x) => weight(x.c) >= 2);
  const edges: Edge[] = [];
  for (let x = 0; x < sig.length; x++) {
    for (let y = x + 1; y < sig.length; y++) {
      let best: Edge | null = null;
      for (const na of sig[x].c) {
        for (const nb of sig[y].c) {
          const gap = dist(na.pos, nb.pos);
          const k = relaysNeeded(gap, na.kind, nb.kind);
          const e: Edge = { a: sig[x].k, b: sig[y].k, na, nb, gap, k, benefit: Math.min(weight(sig[x].c), weight(sig[y].c)) / k };
          if (!best || e.k < best.k || (e.k === best.k && e.gap < best.gap)) best = e;   // ties keep the lower ids
        }
      }
      if (best && best.k <= max) edges.push(best);
    }
  }
  edges.sort((p, q) => q.benefit - p.benefit || p.k - q.k || p.gap - q.gap || cmp(comps[p.a][0].id, comps[q.a][0].id) || cmp(comps[p.b][0].id, comps[q.b][0].id));
  const top = comps.map((_, k) => k);
  const findTop = (k: number): number => (top[k] === k ? k : (top[k] = findTop(top[k])));
  let budget = max;
  const slots: RelaySlot[] = [];
  for (const e of edges) {
    if (findTop(e.a) === findTop(e.b) || e.k > budget) continue;
    top[findTop(e.a)] = findTop(e.b);
    budget -= e.k;
    const ra = relayReach(e.na.kind), rb = relayReach(e.nb.kind), rd = RADIO_RANGE.drone * S.RELAY_SAFETY;
    const scale = e.gap / (ra + rb + (e.k - 1) * rd);
    const dir = unit(sub(e.nb.pos, e.na.pos));
    const [ka, kb] = [comps[e.a][0].id, comps[e.b][0].id].sort(cmp);
    let s = ra * scale;
    for (let n = 1; n <= e.k; n++) {
      const pos = add(e.na.pos, mul(dir, s));
      slots.push({
        id: `relay:${ka}~${kb}#${n}`, pos, cell: i.cellOf ? i.cellOf(pos) : null, index: n, of: e.k,
        bridge: [e.na.id, e.nb.id], groups: [groups[e.a], groups[e.b]], gap: e.gap, assignee: null,
      });
      s += rd * scale;
    }
  }

  // Who flies each post: idle drones in my group (same beacons, so everyone computes the same answer).
  // A drone already on a post keeps it; otherwise nearest wins, ties to the lower NodeId.
  type Cand = { id: NodeId; pos: Vec2; battery: number; slot: string | null };
  const cands: Cand[] = [];
  const meUrgent = me.carrying.some((c) => c.urgency === 3);
  if (!meUrgent && !me.carrying.length && !me.busy) cands.push({ id: me.id, pos: me.pos, battery: me.battery, slot: me.relaySlot ?? null });
  for (const p of latest.values()) {
    if (p.kind !== 'drone' || !fresh(p, now) || p.holding?.length) continue;
    const role = p.swarm?.role ?? 'idle';
    if (role === 'courier' || role === 'charging') continue;
    cands.push({ id: p.id, pos: p.pos, battery: p.battery ?? 1, slot: role === 'relay' ? p.swarm?.relaySlot ?? null : null });
  }
  cands.sort((a, b) => cmp(a.id, b.id));
  const canFly = (c: Cand, s: RelaySlot) => {
    const d = dist(c.pos, s.pos);
    const hub = nearestHub(i.hubs, s.pos);
    return d <= S.RELAY_MAX_DIST && c.battery * DRONE_RANGE_M >= d + (hub ? dist(s.pos, hub.pos) : 0) + S.RESERVE_M;
  };
  const taken = new Set<NodeId>();
  for (const s of slots) {
    let best: Cand | null = null;
    for (const c of cands) {
      if (taken.has(c.id) || !canFly(c, s)) continue;
      const key = (x: Cand) => [x.slot === s.id ? 0 : 1, dist(x.pos, s.pos)];
      const [k1, k2] = key(c);
      const [b1, b2] = best ? key(best) : [Infinity, Infinity];
      if (!best || k1 < b1 || (k1 === b1 && (k2 < b2 || (k2 === b2 && c.id < best.id)))) best = c;
    }
    if (best) { s.assignee = best.id; taken.add(best.id); }
  }
  const assigned = slots.filter((s) => s.assignee);
  const mine = assigned.find((s) => s.assignee === me.id) ?? null;

  const reasons: string[] = [];
  const where = (s: RelaySlot) => s.cell ?? 'the gap';
  if (mine) {
    reasons.push(mine.id === me.relaySlot
      ? `Holding relay post ${where(mine)}: still bridging ${groupName(mine.groups[0])} and ${groupName(mine.groups[1])}.`
      : `Network down: ${groupName(mine.groups[0])} and ${groupName(mine.groups[1])} are cut off (${km(mine.gap)} gap). ` +
        `I'm the nearest idle drone: relay ${mine.index} of ${mine.of} at ${where(mine)}.`);
  } else if (me.relaySlot) {
    const s = assigned.find((x) => x.id === me.relaySlot);
    reasons.push(s ? `${s.assignee} takes relay post ${where(s)}; I'm free again.` : 'My relay post is no longer needed; I am free again.');
  } else if (meUrgent && slots.length) {
    reasons.push('Not relaying: I carry an urgent box.');
  }
  return { groups, slots: assigned, mine, role: mine ? 'relay' : null, phase: mine ? 'relay' : null, alt: mine ? S.RELAY_ALT : null, reasons };
}

// ================================================================================================
// 3. Separation and alignment in flight. Altitude layers by direction (east-ish 110 m, west-ish 130 m, split on
// the north-south line so head-on traffic is always on different layers). When two same-layer drones are
// heading for a close pass, the higher NodeId yields one 10 m sub-layer (east down, west up). If they are
// still within the buffer at the same height, they push apart sideways. Same-corridor drones align headings.
// ================================================================================================
export interface Flier { id: NodeId; pos: Vec2; vel: Vec2; alt: number }
export interface SeparationInput {
  me: Flier;
  desired: Vec2;                           // where I want to go, as a velocity (toward() or formation())
  others: Flier[];                         // other drones I can see (radio neighbours + beacon vel/alt)
  speed?: number;
  cellOf?: (p: Vec2) => CellId;
}
export type Band = 'east' | 'west';
export interface SeparationResult { vel: Vec2; alt: number; band: Band | null; sublayer: number; reasons: string[] }

/** Compass track 0..180 = east band, 180..360 = west band. Opposite headings never share a band. */
export const bandOf = (vel: Vec2): Band => {
  const track = (Math.atan2(vel.x, vel.y) * 180) / Math.PI;      // 0 = north, clockwise
  return track >= 0 && track < 180 ? 'east' : 'west';
};
export const layerAlt = (band: Band, sub: number): number =>
  band === 'east' ? SWARM.ALT_EAST - sub * SWARM.ALT_STEP : SWARM.ALT_WEST + sub * SWARM.ALT_STEP;

/** Closest approach of two straight flights within the look-ahead. */
export function closestApproach(a: Flier, b: Flier, horizon = SWARM.LOOKAHEAD_SEC): { d: number; t: number } {
  const p = sub(b.pos, a.pos), w = sub(b.vel, a.vel);
  const ww = dot(w, w);
  const t = ww < 1e-9 ? 0 : Math.max(0, Math.min(horizon, -dot(p, w) / ww));
  return { d: len(add(p, mul(w, t))), t };
}

/** Velocity toward a point at a given speed (slows to land exactly on it within one tick). */
export const toward = (pos: Vec2, goal: Vec2, speed: number, dt = 0.5): Vec2 => {
  const d = sub(goal, pos);
  return len(d) <= speed * dt ? mul(d, 1 / dt) : mul(unit(d), speed);
};

export function separate(i: SeparationInput): SeparationResult {
  const S = SWARM, me = i.me, want = i.desired;
  if (len(want) < 0.5) return { vel: want, alt: me.alt, band: null, sublayer: 0, reasons: [] };
  const speed = len(want);
  const band = bandOf(want);
  const near = i.others.filter((o) => o.id !== me.id && dist(o.pos, me.pos) <= S.CONSIDER_R).sort((a, b) => cmp(a.id, b.id));
  const self: Flier = { ...me, vel: want };
  const movers = [self, ...near.filter((o) => len(o.vel) >= 0.5 && bandOf(o.vel) === band)].sort((a, b) => cmp(a.id, b.id));
  const conflict = (a: Flier, b: Flier) => closestApproach(a, b).d < S.SEP_BUFFER;

  // Conflict cluster around me, then greedy sub-layers in NodeId order (every member computes the same colouring).
  const inCluster = new Set<NodeId>([me.id]);
  const queue = [self];
  while (queue.length) {
    const a = queue.shift()!;
    for (const b of movers) if (!inCluster.has(b.id) && conflict(a, b)) { inCluster.add(b.id); queue.push(b); }
  }
  const cluster = movers.filter((m) => inCluster.has(m.id));
  const color = new Map<NodeId, number>();
  for (const a of cluster) {
    const used = new Set(cluster.filter((b) => color.has(b.id) && conflict(a, b)).map((b) => color.get(b.id)!));
    let c = 0;
    while (used.has(c) && c < S.MAX_SUBLAYER) c++;
    color.set(a.id, c);
  }
  const sublayer = color.get(me.id) ?? 0;
  const alt = layerAlt(band, sublayer);
  const reasons: string[] = [];
  const at = i.cellOf ? ` near ${i.cellOf(me.pos)}` : '';
  if (sublayer > 0) {
    const yieldTo = cluster.filter((b) => b.id !== me.id && b.id < me.id && conflict(self, b));
    const ca = yieldTo.length ? closestApproach(self, yieldTo[0]) : null;
    reasons.push(`Yielding to ${yieldTo.map((b) => b.id).join(', ') || 'traffic'}${at}: same ${band}bound layer` +
      `${ca ? `, closest pass ${Math.round(ca.d)} m in ${Math.round(ca.t)} s` : ''}. Moving to ${alt} m.`);
  }

  // Alignment: drones flying the same corridor match headings (capped so nobody drifts off course).
  let dir = unit(want);
  const mates = near.filter((o) => len(o.vel) >= 0.5 && bandOf(o.vel) === band && dist(o.pos, me.pos) <= S.ALIGN_RADIUS &&
    Math.abs(angleBetween(o.vel, want)) <= (S.ALIGN_DEG * Math.PI) / 180);
  if (mates.length) {
    const avg = unit(mates.reduce((s, o) => add(s, unit(o.vel)), V(0, 0)));
    const blended = unit(add(mul(dir, 1 - S.ALIGN_WEIGHT), mul(avg, S.ALIGN_WEIGHT)));
    const maxTurn = (S.ALIGN_MAX_DEG * Math.PI) / 180;
    const turn = angleBetween(dir, blended);
    dir = Math.abs(turn) <= maxTurn ? blended : rotate(dir, Math.sign(turn) * maxTurn);
    reasons.push(`Flying the same corridor as ${mates.map((o) => o.id).join(', ')}: matching heading.`);
  }

  // Separation: anyone inside the buffer at my height pushes me sideways (never slower, never faster).
  let push = V(0, 0);
  for (const o of near) {
    const d = dist(o.pos, me.pos);
    if (Math.abs(o.alt - me.alt) >= S.ALT_SEP || d >= S.SEP_BUFFER) continue;
    const away = d > 1e-6 ? unit(sub(me.pos, o.pos)) : (me.id > o.id ? V(dir.y, -dir.x) : V(-dir.y, dir.x));
    push = add(push, mul(away, ((S.SEP_BUFFER - d) / S.SEP_BUFFER) * speed));
    reasons.push(`Too close to ${o.id} (${Math.round(d)} m, same height): side-stepping.`);
  }
  const out = add(mul(dir, speed), push);
  const vel = len(out) > 1e-6 ? mul(unit(out), speed) : mul(dir, speed);
  return { vel, alt, band, sublayer, reasons };
}

/** Altitude after one tick, limited by the climb rate. */
export const stepAlt = (alt: number, target: number, dt: number): number => {
  const d = target - alt, m = SWARM.CLIMB_RATE * dt;
  return Math.abs(d) <= m ? target : alt + Math.sign(d) * m;
};

/**
 * Turn a steering velocity into a moveTo path. Straight at full speed: the whole leg (the engine flies it).
 * Otherwise a one-tick step: the engine moves exactly |vel| * dt and stops, so the drone flies at that speed.
 */
export function steerPath(pos: Vec2, vel: Vec2, dt: number, goal: Vec2, speed = SPEED.drone): Vec2[] {
  const toGoal = sub(goal, pos);
  if (len(vel) >= 0.98 * speed && Math.abs(angleBetween(vel, toGoal)) < (2 * Math.PI) / 180) return [{ ...goal }];
  const p = add(pos, mul(vel, dt));
  return [V(Math.max(0, Math.min(WORLD_SIZE, p.x)), Math.max(0, Math.min(WORLD_SIZE, p.y)))];
}

// ================================================================================================
// 4. Corridor formation: 2+ drones carrying to the same cell fly together. The one closest to the cell leads;
// the rest take slots behind it (a line for two, a V for three or more), in NodeId order.
// ================================================================================================
export interface FormationInput {
  me: { id: NodeId; pos: Vec2; destCell: CellId; urgency: Urgency };
  dest: Vec2;
  peers: Peer[];
  now: number;
  prevLeader?: NodeId | null;
  speed?: number;
}
export interface FormationResult {
  shape: 'solo' | 'line' | 'V';
  leader: NodeId;
  members: NodeId[];
  slot: number;                            // 0 = leader
  desired: Vec2;                           // feed into separate()
  reasons: string[];
}
const destOf = (p: Peer): CellId | null => p.swarm?.dest ?? primaryDest(p.holding);

export function formation(i: FormationInput): FormationResult {
  const S = SWARM, speed = i.speed ?? SPEED.drone, me = i.me;
  const solo = (reasons: string[] = []): FormationResult =>
    ({ shape: 'solo', leader: me.id, members: [me.id], slot: 0, desired: toward(me.pos, i.dest, speed), reasons });
  const mates = i.peers.filter((p) => p.kind === 'drone' && p.id !== me.id && fresh(p, i.now) && p.swarm?.role !== 'relay' &&
    destOf(p) === me.destCell && dist(p.pos, me.pos) <= S.FORMATION_RADIUS);
  if (!mates.length) return solo();
  const urgentPeer = (p: Peer) => (p.holding ?? []).some((h) => h.destCell === me.destCell && h.urgency === 3);
  const members = [{ id: me.id, pos: me.pos, urgent: me.urgency === 3 }, ...mates.map((p) => ({ id: p.id, pos: p.pos, urgent: urgentPeer(p) }))]
    .sort((a, b) => cmp(a.id, b.id));
  const dd = (m: { pos: Vec2 }) => dist(m.pos, i.dest);
  let leader = [...members].sort((a, b) => dd(a) - dd(b) || cmp(a.id, b.id))[0];
  const pl = members.find((m) => m.id === i.prevLeader);
  if (pl && dd(pl) <= dd(leader) + S.LEADER_HYST) leader = pl;
  const ids = members.map((m) => m.id);
  if (dd(leader) <= S.BREAK_DIST) return solo([`Formation to ${me.destCell} breaks up ${S.BREAK_DIST} m out so each drone can land.`]);
  const followers = members.filter((m) => m.id !== leader.id);
  const shape = members.length >= 3 ? 'V' : 'line';
  const h = unit(sub(i.dest, leader.pos));
  const left = V(-h.y, h.x);
  const slotPos = (k: number): Vec2 => {
    const rank = Math.ceil(k / 2);
    const [back, lat] = shape === 'line' ? [k * S.LINE_GAP, 0] : [rank * S.V_BACK, (k % 2 ? 1 : -1) * rank * S.V_SIDE];
    return add(sub(leader.pos, mul(h, back)), mul(left, lat));
  };
  const lagging = followers.some((f, k) => dist(f.pos, slotPos(k + 1)) > S.LAG_DIST);
  const leaderSpeed = speed * (lagging && !leader.urgent ? S.LEADER_EASE : 1);
  const others = ids.filter((x) => x !== me.id);
  if (leader.id === me.id) {
    return {
      shape, leader: me.id, members: ids, slot: 0, desired: mul(h, leaderSpeed),
      reasons: [`Leading ${others.join(', ')} to ${me.destCell} in a ${shape} (I'm closest).${leaderSpeed < speed ? ' Easing off so they can form up.' : ''}`],
    };
  }
  const k = followers.findIndex((f) => f.id === me.id) + 1;
  const sp = slotPos(k);
  let desired = add(mul(h, leaderSpeed), mul(sub(sp, me.pos), S.FORM_GAIN));
  const along = dot(desired, h);
  if (along < 0.5 * speed) desired = add(desired, mul(h, 0.5 * speed - along));   // never turn back to find the slot
  desired = clampLen(desired, speed);
  if (me.urgency === 3) desired = mul(unit(desired), speed);                       // urgent boxes never slow down
  const side = shape === 'line' ? `slot ${k} in line` : `slot ${k} (${k % 2 ? 'left' : 'right'} wing)`;
  return { shape, leader: leader.id, members: ids, slot: k, desired, reasons: [`Flying ${side} behind ${leader.id} to ${me.destCell}.`] };
}

// ================================================================================================
// 5. Patrol coverage for idle motorbikes and boats: go to the clinic nobody has visited for longest, skipping
// ones a neighbour has claimed, so request envelopes get picked up by mules regularly. Visit times gossip.
// ================================================================================================
export interface Site { id: string; pos: Vec2 }
export interface PatrolState { claim: { site: string; target: Vec2; t: number } | null; visits: Record<string, number> }
export const emptyPatrol = (): PatrolState => ({ claim: null, visits: {} });
export interface PatrolInput {
  me: { id: NodeId; kind: CarrierKind; pos: Vec2 };
  now: number;
  sites: Site[];                           // clinics I know (+ my home hub, so boxes get collected too)
  peers: Peer[];
  map: Pick<MapQuery, 'eta' | 'route'>;
  visitRadius?: number;
  maxEta?: number;
}
export interface PatrolResult {
  state: PatrolState;
  site: string | null;
  target: Vec2 | null;
  out: { patrolClaim?: { site: string; t: number }; visits: Record<string, number> };
  reasons: string[];
}

export function patrolStep(prev: PatrolState, i: PatrolInput): PatrolResult {
  const S = SWARM, now = i.now, me = i.me;
  const R = i.visitRadius ?? S.VISIT_RADIUS;
  const visits: Record<string, number> = { ...prev.visits };
  const peers = [...i.peers].sort((a, b) => cmp(a.id, b.id));
  for (const p of peers) {
    const pv = p.swarm?.visits ?? {};
    for (const k of sortedKeys(pv)) if (pv[k] <= now && pv[k] > (visits[k] ?? -Infinity)) visits[k] = pv[k];
  }
  const reasons: string[] = [];
  for (const s of i.sites) if (dist(me.pos, s.pos) <= R) visits[s.id] = now;
  let claim = prev.claim;
  if (claim && dist(me.pos, claim.target) <= R) {
    visits[claim.site] = now;
    reasons.push(`Visited ${claim.site}; picking the next clinic nobody has seen for longest.`);
    claim = null;
  }
  const claims = peers.flatMap((p) => (p.id !== me.id && now - p.heardAt <= S.CLAIM_TTL_SEC && p.swarm?.patrolClaim
    ? [{ by: p.id, site: p.swarm.patrolClaim.site, t: p.swarm.patrolClaim.t }] : []));
  if (claim) {
    const c = claim;
    const rival = claims.find((x) => x.site === c.site && (x.t < c.t || (x.t === c.t && x.by < me.id)));
    if (rival) { reasons.push(`${rival.by} claimed ${c.site} first; switching.`); claim = null; }
  }
  if (!claim) {
    const taken = new Map(claims.map((c) => [c.site, c.by] as const));
    const options = i.sites
      .filter((s) => !taken.has(s.id))
      .map((s) => ({ s, eta: i.map.eta(me.kind, me.pos, s.pos), last: visits[s.id] ?? -Infinity }))
      .filter((o) => Number.isFinite(o.eta) && o.eta <= (i.maxEta ?? S.PATROL_MAX_ETA))
      .sort((a, b) => a.last - b.last || a.eta - b.eta || cmp(a.s.id, b.s.id));
    const best = options[0];
    if (best) {
      const path = i.map.route(me.kind, me.pos, best.s.pos);
      const target = path.length ? { ...path[path.length - 1] } : { ...best.s.pos };   // boats stop at the bank
      claim = { site: best.s.id, target, t: now };
      const ago = Number.isFinite(best.last) ? `last visit ${minutes(now - best.last)} ago` : 'never visited';
      const skipped = [...taken.entries()].sort((a, b) => cmp(a[0], b[0])).map(([s, by]) => `${by} has ${s}`);
      reasons.push(`Patrol: ${best.s.id} is the stalest clinic I know (${ago})${skipped.length ? `; ${skipped.join(', ')}` : ''}. Heading there, ${minutes(best.eta)}.`);
    } else if (i.sites.length) {
      reasons.push('Patrol: every clinic I know is claimed or out of reach.');
    }
  }
  return {
    state: { claim, visits },
    site: claim?.site ?? null,
    target: claim ? { ...claim.target } : null,
    out: { ...(claim ? { patrolClaim: { site: claim.site, t: claim.t } } : {}), visits: { ...visits } },
    reasons,
  };
}

// ================================================================================================
// 6. Return to charge (drones): battery against the trip to the clinic and back to the nearest hub.
// ================================================================================================
export interface ChargeInput {
  me: { pos: Vec2; battery: number; carrying: { destCell: CellId; dest: Vec2; urgency: Urgency }[] };
  hubs: Hub[];
}
export interface ChargeDecision {
  action: 'continue' | 'return' | 'charge' | 'ready';
  hub: Hub | null;
  target: Vec2 | null;
  phase: 'charging' | null;
  reasons: string[];
}

export function chargeDecision(i: ChargeInput): ChargeDecision {
  const S = SWARM, me = i.me;
  const hub = nearestHub(i.hubs, me.pos);
  if (!hub) return { action: 'continue', hub: null, target: null, phase: null, reasons: [] };
  const range = me.battery * DRONE_RANGE_M, dHub = dist(me.pos, hub.pos), atHub = dHub <= MEET_OFFSET[1];
  const pct = `${Math.round(me.battery * 100)}%`;
  if (me.carrying.length) {
    const box = [...me.carrying].sort((a, b) => b.urgency - a.urgency || cmp(a.destCell, b.destCell))[0];
    const end = nearestHub(i.hubs, box.dest);
    const out = dist(me.pos, box.dest), back = end ? dist(box.dest, end.pos) : 0;
    const need = out + back + S.RESERVE_M;
    if (range >= need) {
      return { action: 'continue', hub, target: null, phase: null, reasons: [`Battery ${pct} (${km(range)}) covers ${km(out)} to ${box.destCell} and ${km(back)} back to ${end?.id ?? 'a hub'}.`] };
    }
    if (atHub) return { action: 'charge', hub, target: hub.pos, phase: 'charging', reasons: [`Battery ${pct} can't cover ${box.destCell} and back (${km(need)}): charging at ${hub.id} first.`] };
    return { action: 'return', hub, target: hub.pos, phase: null, reasons: [`Battery ${pct} (${km(range)}) can't cover ${box.destCell} and back (${km(need)}): returning to ${hub.id}, ${km(dHub)} away, to charge or pass the box on.`] };
  }
  if (atHub) {
    return me.battery < S.RESUME_AT
      ? { action: 'charge', hub, target: hub.pos, phase: 'charging', reasons: [`Charging at ${hub.id}: ${pct}.`] }
      : { action: 'ready', hub, target: null, phase: null, reasons: [] };
  }
  if (range < (dHub + S.RESERVE_M) * S.RETURN_FACTOR) {
    return { action: 'return', hub, target: hub.pos, phase: null, reasons: [`Battery ${pct} (${km(range)}) is close to the ${km(dHub)} back to ${hub.id} plus reserve: returning to charge.`] };
  }
  return { action: 'continue', hub, target: null, phase: null, reasons: [] };
}

// ================================================================================================
// Status for the renderer (NodeState.role / phase / alt) and the beacon.
// ================================================================================================
export function swarmRole(s: { relay: boolean; charging: boolean; carrying: number; wins: number; patrolling: boolean }): SwarmRole {
  if (s.relay) return 'relay';
  if (s.carrying || s.wins) return 'courier';
  if (s.charging) return 'charging';
  return s.patrolling ? 'patrol' : 'idle';
}

export function flightPhase(s: { role: SwarmRole; moving: boolean; distToGoal: number; alt: number; cruiseAlt: number }): NonNullable<NodeState['phase']> {
  if (s.role === 'relay') return 'relay';
  if (s.role === 'charging') return 'charging';
  if (!s.moving) return 'idle';
  if (s.distToGoal <= SWARM.ARRIVE_DIST) return 'landing';
  return s.alt < s.cruiseAlt - 20 ? 'takeoff' : 'cruise';
}

/** Everything the swarm puts in one beacon. */
export function swarmBeacon(p: {
  auction?: AuctionResult; role: SwarmRole; dest?: CellId | null; vel?: Vec2; alt?: number; relaySlot?: string | null;
  patrol?: PatrolResult; net?: NetObservation | null;
}): SwarmBeacon {
  return {
    bids: p.auction?.out.bids ?? [],
    seen: p.auction?.out.seen ?? {},
    role: p.role,
    ...(p.dest ? { dest: p.dest } : {}),
    ...(p.vel ? { vel: { ...p.vel } } : {}),
    ...(p.alt !== undefined ? { alt: p.alt } : {}),
    ...(p.relaySlot ? { relaySlot: p.relaySlot } : {}),
    ...(p.patrol?.out.patrolClaim ? { patrolClaim: p.patrol.out.patrolClaim } : {}),
    ...(p.patrol ? { visits: p.patrol.out.visits } : {}),
    ...(p.net ? { net: p.net } : {}),
  };
}
