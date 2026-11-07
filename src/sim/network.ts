// Who can talk to whom this tick. Three layers (PLAN 3.2):
//   1. cell network near towns (switched off by NETWORK DOWN),
//   2. local mesh radio between nodes in range, store-and-forward up to MAX_HOPS,
//   3. dead zones, where local radio is dead.
// A message reaches, the same tick, every node in the sender's radio-connected group within MAX_HOPS,
// or any node when both ends have cell signal. With no path it is dropped (agents re-send it later).
import { MAX_HOPS, RADIO_RANGE, RATE_LIMIT_PER_MIN } from '../contracts/config';
import type { NodeId, NodeKind, Vec2 } from '../contracts/types';
import { dist, hasCoverage } from './map';

export interface NetNode { id: NodeId; kind: NodeKind; pos: Vec2; alive: boolean }
export interface Zone { pos: Vec2; radius: number }
export interface NetState { cellUp: boolean; deadZones: Zone[] }

export const inDeadZone = (p: Vec2, zones: Zone[]): boolean => zones.some((z) => dist(p, z.pos) <= z.radius);

/** Cell signal: the network is up and the node is inside a town's coverage. The dispatch server sits in town. */
export const hasCellSignal = (n: NetNode, s: NetState): boolean =>
  n.alive && s.cellUp && (n.kind === 'dispatch' || hasCoverage(n.pos));

export interface Topology {
  links: [NodeId, NodeId][];
  neighbours: Map<NodeId, { id: NodeId; kind: NodeKind; pos: Vec2; dist: number }[]>;
  signal: Map<NodeId, boolean>;
  /** Radio hop count from `from` to every node it can reach within MAX_HOPS. */
  hopsFrom(from: NodeId): Map<NodeId, number>;
}

/** Build radio links for this tick. Two nodes link when both are alive, outside dead zones, and within both ranges. */
export function buildTopology(nodes: NetNode[], s: NetState): Topology {
  const neighbours = new Map<NodeId, { id: NodeId; kind: NodeKind; pos: Vec2; dist: number }[]>();
  const signal = new Map<NodeId, boolean>();
  const links: [NodeId, NodeId][] = [];
  const radioOn = nodes.map((n) => n.alive && RADIO_RANGE[n.kind] > 0 && !inDeadZone(n.pos, s.deadZones));
  for (const n of nodes) {
    neighbours.set(n.id, []);
    signal.set(n.id, hasCellSignal(n, s));
  }
  const range = nodes.map((n) => RADIO_RANGE[n.kind]);
  for (let i = 0; i < nodes.length; i++) {
    if (!radioOn[i]) continue;
    const a = nodes[i], ax = a.pos.x, ay = a.pos.y, ra = range[i];
    for (let j = i + 1; j < nodes.length; j++) {
      if (!radioOn[j]) continue;
      const b = nodes[j];
      const r = ra < range[j] ? ra : range[j];
      const dx = b.pos.x - ax, dy = b.pos.y - ay;
      if (dx > r || dx < -r || dy > r || dy < -r || dx * dx + dy * dy > r * r) continue;   // cheap rejects first (same test as dist > r)
      const d = dist(a.pos, b.pos);
      if (d > r) continue;
      links.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
      neighbours.get(a.id)!.push({ id: b.id, kind: b.kind, pos: { ...b.pos }, dist: d });
      neighbours.get(b.id)!.push({ id: a.id, kind: a.kind, pos: { ...a.pos }, dist: d });
    }
  }
  for (const list of neighbours.values()) list.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const cache = new Map<NodeId, Map<NodeId, number>>();
  const hopsFrom = (from: NodeId): Map<NodeId, number> => {
    const hit = cache.get(from);
    if (hit) return hit;
    const seen = new Map<NodeId, number>([[from, 0]]);
    let frontier = [from];
    for (let h = 1; h <= MAX_HOPS && frontier.length; h++) {
      const next: NodeId[] = [];
      for (const id of frontier)
        for (const nb of neighbours.get(id) ?? [])
          if (!seen.has(nb.id)) {
            seen.set(nb.id, h);
            next.push(nb.id);
          }
      frontier = next;
    }
    cache.set(from, seen);
    return seen;
  };
  return { links, neighbours, signal, hopsFrom };
}

/**
 * Who receives a message from `from` addressed to `to` ('*' = broadcast), with the hop count each one sees.
 * `radioOnly` limits it to direct radio neighbours (used for rate-limited senders).
 */
export function recipients(topo: Topology, from: NodeId, to: NodeId | '*', radioOnly = false): { id: NodeId; hops: number }[] {
  const radio = topo.hopsFrom(from);
  const viaCell = !radioOnly && topo.signal.get(from) === true;
  const hopsTo = (id: NodeId): number | null => {
    if (id === from) return null;
    const h = radio.get(id);
    if (h !== undefined && (!radioOnly || h === 1)) return h;
    if (viaCell && topo.signal.get(id)) return 1;
    return null;
  };
  if (to !== '*') {
    const h = hopsTo(to);
    return h === null ? [] : [{ id: to, hops: h }];
  }
  const out: { id: NodeId; hops: number }[] = [];
  for (const id of topo.signal.keys()) {
    const h = hopsTo(id);
    if (h !== null) out.push({ id, hops: h });
  }
  return out;
}

/**
 * Per-sender rate limit (PLAN 12, threat 9). Beacons are not counted. Past RATE_LIMIT_PER_MIN messages
 * in a sim-minute, a sender's traffic is no longer forwarded: only its direct radio neighbours hear it.
 */
export class RateLimiter {
  private w = new Map<NodeId, { minute: number; n: number }>();

  /** Returns 'ok', 'limited', or 'first-limited' (the first drop this minute, so the caller raises one alert). */
  check(sender: NodeId, t: number): 'ok' | 'limited' | 'first-limited' {
    const minute = Math.floor(t / 60);
    let s = this.w.get(sender);
    if (!s || s.minute !== minute) {
      s = { minute, n: 0 };
      this.w.set(sender, s);
    }
    s.n++;
    if (s.n <= RATE_LIMIT_PER_MIN) return 'ok';
    return s.n === RATE_LIMIT_PER_MIN + 1 ? 'first-limited' : 'limited';
  }
}
