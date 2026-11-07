// The fictional district: terrain, one river with a lake, 10 villages on dirt roads, 3 relay hubs,
// cell coverage, and the MapQuery agents use. Fixed layout (same for every seed) so the split screen,
// the renderer and every replay share one map. No real place names.
import { createNoise2D } from 'simplex-noise';
import { CELL_COVERAGE, CELL_SIZE, MEET_OFFSET, SPEED, WORLD_SIZE } from '../contracts/config';
import type { CarrierKind, CellId, Hub, MapQuery, NodeId, Vec2 } from '../contracts/types';
import { hashString, mulberry32 } from './rng';

// ---------- small geometry helpers ----------
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Closest point on segment ab to p, with its parameter t in [0,1]. */
function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { q: { x: a.x + dx * t, y: a.y + dy * t }, t };
}

export const pathLength = (path: Vec2[]): number => {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += dist(path[i - 1], path[i]);
  return L;
};

// ---------- a routable network of straight edges (roads, or water) ----------
// Junction-to-junction shortest paths are precomputed once (Floyd-Warshall on ~30 points),
// so route() and eta() stay cheap even when agents call them every tick.
export class NetGraph {
  readonly D: number[][];
  private readonly nxt: number[][];

  constructor(readonly pts: Vec2[], readonly edges: [number, number][]) {
    const n = pts.length;
    this.D = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
    this.nxt = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? j : -1)));
    for (const [a, b] of edges) {
      const d = dist(pts[a], pts[b]);
      this.D[a][b] = this.D[b][a] = d;
      this.nxt[a][b] = b;
      this.nxt[b][a] = a;
    }
    for (let k = 0; k < n; k++)
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          if (this.D[i][k] + this.D[k][j] < this.D[i][j]) {
            this.D[i][j] = this.D[i][k] + this.D[k][j];
            this.nxt[i][j] = this.nxt[i][k];
          }
  }

  /** Nearest point on any edge. */
  snap(p: Vec2): { edge: number; q: Vec2; d: number } {
    let best = { edge: 0, q: this.pts[0], d: Infinity };
    this.edges.forEach(([a, b], e) => {
      const { q } = projectOnSegment(p, this.pts[a], this.pts[b]);
      const d = dist(p, q);
      if (d < best.d) best = { edge: e, q, d };
    });
    return best;
  }

  private junctionPath(i: number, j: number): Vec2[] {
    const out = [this.pts[i]];
    while (i !== j) {
      i = this.nxt[i][j];
      if (i < 0) break;
      out.push(this.pts[i]);
    }
    return out;
  }

  /** Path from -> network -> to. `offNetEnd` = also walk the last leg off the network to `to`. */
  route(from: Vec2, to: Vec2, offNetEnd: boolean): Vec2[] {
    const sa = this.snap(from), sb = this.snap(to);
    const tail = offNetEnd ? [to] : [];
    let path: Vec2[];
    if (sa.edge === sb.edge) {
      path = [from, sa.q, sb.q, ...tail];
    } else {
      let best = Infinity;
      path = [];
      for (const i of this.edges[sa.edge])
        for (const j of this.edges[sb.edge]) {
          const c = dist(sa.q, this.pts[i]) + this.D[i][j] + dist(this.pts[j], sb.q);
          if (c < best) {
            best = c;
            path = [from, sa.q, ...this.junctionPath(i, j), sb.q, ...tail];
          }
        }
    }
    // Drop zero-length steps.
    return path.filter((p, k) => k === 0 || dist(p, path[k - 1]) > 1);
  }
}

// ---------- fixed layout ----------
export interface Village { id: string; name: string; pos: Vec2; clinicId: NodeId; riverside: boolean }
export interface Site { id: NodeId; pos: Vec2 }

export const TOWN: Vec2 = { x: 4500, y: 20000 };                 // district town, west side, has the stores
export const STORES: Site[] = [
  { id: 'store-A', pos: { x: 4500, y: 20000 } },                   // district store
  { id: 'store-B', pos: { x: 5500, y: 11500 } },                   // sub-store south-west
  { id: 'store-C', pos: { x: 5000, y: 29000 } },                   // sub-store north-west
];
export const HUBS: Hub[] = [
  // About 5 km east of the stores: past store radio range (4 km), but close enough that a van's round trip
  // is short. Drones (25 m/s) then fly the long legs east instead of the slow vans (9 m/s).
  { id: 'hub-1', pos: { x: 10500, y: 10500 } },                    // south
  { id: 'hub-2', pos: { x: 10000, y: 20500 } },                    // middle
  { id: 'hub-3', pos: { x: 10000, y: 30500 } },                    // north
];
export const DISPATCH_POS: Vec2 = { x: 4000, y: 21000 };          // central mode only: server in the town

// River runs north to south through the middle and widens into a lake in the south-east.
export const RIVER: Vec2[] = [
  { x: 21000, y: 40000 }, { x: 22000, y: 36500 }, { x: 21300, y: 33000 }, { x: 22000, y: 29500 },
  { x: 23200, y: 26000 }, { x: 22500, y: 22500 }, { x: 22800, y: 19000 }, { x: 24200, y: 15500 },
  { x: 25500, y: 12000 }, { x: 26500, y: 9500 },                   // lake centre
  { x: 27500, y: 6000 }, { x: 28500, y: 0 },
];
export const LAKE = { center: { x: 26500, y: 9500 }, radius: 2400 };
export const LAKE_POLY: Vec2[] = Array.from({ length: 16 }, (_, k) => {
  const a = (k / 16) * Math.PI * 2;
  const r = LAKE.radius * (1 + 0.12 * Math.sin(3 * a));          // a slightly irregular shore
  return { x: LAKE.center.x + r * Math.cos(a), y: LAKE.center.y + r * Math.sin(a) };
});

export const VILLAGES: Village[] = [
  { id: 'v1', name: 'Ambero', pos: { x: 19800, y: 34200 }, clinicId: 'clinic-1', riverside: true },
  { id: 'v2', name: 'Kessa', pos: { x: 26500, y: 36500 }, clinicId: 'clinic-2', riverside: false },
  { id: 'v3', name: 'Lunde', pos: { x: 23500, y: 30000 }, clinicId: 'clinic-3', riverside: true },   // market village
  { id: 'v4', name: 'Taravo', pos: { x: 32000, y: 31500 }, clinicId: 'clinic-4', riverside: false },
  { id: 'v5', name: 'Mirow', pos: { x: 20500, y: 24000 }, clinicId: 'clinic-5', riverside: true },
  { id: 'v6', name: 'Odeni', pos: { x: 25000, y: 20500 }, clinicId: 'clinic-6', riverside: true },
  { id: 'v7', name: 'Selbu', pos: { x: 34000, y: 21000 }, clinicId: 'clinic-7', riverside: false },
  { id: 'v8', name: 'Pirra', pos: { x: 20500, y: 13500 }, clinicId: 'clinic-8', riverside: false },
  { id: 'v9', name: 'Vanto', pos: { x: 28800, y: 12800 }, clinicId: 'clinic-9', riverside: true },  // lakeside
  { id: 'v10', name: 'Ushen', pos: { x: 33500, y: 6000 }, clinicId: 'clinic-10', riverside: false },
];

// Road junctions: stores, hubs, villages. Edges are dirt roads (straight segments between junctions).
const ROAD_NODES: { id: string; pos: Vec2 }[] = [
  ...STORES.map((s) => ({ id: s.id, pos: s.pos })),
  ...HUBS.map((h) => ({ id: h.id, pos: h.pos })),
  ...VILLAGES.map((v) => ({ id: v.id, pos: v.pos })),
];
const ROAD_LIST: [string, string][] = [
  ['store-B', 'store-A'], ['store-A', 'store-C'],
  ['store-B', 'hub-1'], ['store-A', 'hub-2'], ['store-C', 'hub-3'],
  ['hub-1', 'hub-2'], ['hub-2', 'hub-3'],
  ['hub-3', 'v1'], ['v1', 'v3'], ['v1', 'v2'], ['v3', 'v2'], ['v3', 'v4'], ['v2', 'v4'],
  ['hub-2', 'v5'], ['v5', 'v3'], ['v5', 'v6'], ['v6', 'v7'], ['v4', 'v7'],
  ['hub-1', 'v8'], ['v8', 'v5'], ['v8', 'v9'], ['v9', 'v6'], ['v9', 'v10'], ['v7', 'v10'],
];

// ---------- terrain ----------
/** Ground height in metres. Hills rise to the east; the river valley and lake are carved out. */
export function makeHeight(): (x: number, y: number) => number {
  const noise = createNoise2D(mulberry32(hashString('runners-terrain')));
  const river = RIVER;
  return (x, y) => {
    const p = { x, y };
    let h = 40 + 140 * (x / WORLD_SIZE);
    h += 90 * noise(x / 9000, y / 9000) + 30 * noise(x / 2500, y / 2500);
    // Carve the valley: flatten towards water level near the river and inside the lake.
    let dRiver = Infinity;
    for (let i = 1; i < river.length; i++) dRiver = Math.min(dRiver, dist(p, projectOnSegment(p, river[i - 1], river[i]).q));
    const dLake = Math.max(0, dist(p, LAKE.center) - LAKE.radius);
    const d = Math.min(dRiver, dLake);
    const k = Math.min(1, d / 2500);
    h = 2 + (Math.max(5, h) - 2) * k * k * (3 - 2 * k);           // smoothstep from water level
    return Math.max(0, h);
  };
}

// ---------- cells ----------
const CELLS = Math.ceil(WORLD_SIZE / CELL_SIZE);
export function cellOf(p: Vec2): CellId {
  const c = Math.max(0, Math.min(CELLS - 1, Math.floor(p.x / CELL_SIZE)));
  const r = Math.max(0, Math.min(CELLS - 1, Math.floor(p.y / CELL_SIZE)));
  return `C${c}-${r}`;
}
export function cellCenter(id: CellId): Vec2 {
  const m = /^C(\d+)-(\d+)$/.exec(id);
  if (!m) return { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  return { x: (Number(m[1]) + 0.5) * CELL_SIZE, y: (Number(m[2]) + 0.5) * CELL_SIZE };
}

/** Is p inside a town's cell coverage (ignoring outages)? */
export const hasCoverage = (p: Vec2): boolean => CELL_COVERAGE.some((c) => dist(p, c.pos) <= c.radius);

// ---------- world object ----------
export interface World {
  villages: Village[];
  stores: Site[];
  hubs: Hub[];
  river: Vec2[];
  lake: Vec2[];
  roads: NetGraph;            // vans and motorbikes
  water: NetGraph;            // boats
  roadSegments: [Vec2, Vec2][];
  height: (x: number, y: number) => number;
  map: MapQuery;
}

function buildWater(): NetGraph {
  const pts = [...RIVER];
  const edges: [number, number][] = [];
  for (let i = 1; i < RIVER.length; i++) edges.push([i - 1, i]);
  // A ring around the lake so boats can reach any lakeside point.
  const centre = RIVER.findIndex((p) => p.x === LAKE.center.x && p.y === LAKE.center.y);
  const ring0 = pts.length;
  const ringN = 8;
  for (let k = 0; k < ringN; k++) {
    const a = (k / ringN) * Math.PI * 2;
    pts.push({ x: LAKE.center.x + 0.85 * LAKE.radius * Math.cos(a), y: LAKE.center.y + 0.85 * LAKE.radius * Math.sin(a) });
    edges.push([ring0 + k, ring0 + ((k + 1) % ringN)], [centre, ring0 + k]);
  }
  return new NetGraph(pts, edges);
}

function buildRoads(): NetGraph {
  const idx = new Map(ROAD_NODES.map((n, i) => [n.id, i]));
  return new NetGraph(ROAD_NODES.map((n) => n.pos), ROAD_LIST.map(([a, b]) => [idx.get(a)!, idx.get(b)!]));
}

let cached: World | null = null;

/** The one district map. Built once and shared (it never changes during a run). */
export function createWorld(): World {
  if (cached) return cached;
  const roads = buildRoads();
  const water = buildWater();
  // Two points this close can be joined straight, off-network (a meeting point is at most MEET_OFFSET[1] from a road).
  const directM = 2 * MEET_OFFSET[1];

  const route = (kind: CarrierKind, from: Vec2, to: Vec2): Vec2[] => {
    if (kind === 'drone' || dist(from, to) <= directM) return [from, to];
    if (kind === 'boat') return water.route(from, to, false);      // boats stop at the bank nearest `to`
    return roads.route(from, to, true);
  };
  const map: MapQuery = {
    cellOf,
    cellCenter,
    route,
    eta: (kind, from, to) => pathLength(route(kind, from, to)) / SPEED[kind],
    passable: (kind, p) =>
      kind === 'drone' ? true
        : kind === 'boat' ? water.snap(p).d <= MEET_OFFSET[0] || dist(p, LAKE.center) <= LAKE.radius
          : roads.snap(p).d <= MEET_OFFSET[1],
    hubs: () => HUBS.map((h) => ({ id: h.id, pos: { ...h.pos } })),
  };
  cached = {
    villages: VILLAGES,
    stores: STORES,
    hubs: HUBS,
    river: RIVER,
    lake: LAKE_POLY,
    roads,
    water,
    roadSegments: roads.edges.map(([a, b]) => [roads.pts[a], roads.pts[b]]),
    height: makeHeight(),
    map,
  };
  return cached;
}
