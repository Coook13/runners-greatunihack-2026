// Real geography around Hawassa, Ethiopia, from the bundled offline file hawassa.json
// (OpenStreetMap roads, water and places; Copernicus DEM elevation). Pure data and maths: no DOM,
// no three.js, so the sim, the renderer and node tests all share it.
//
// Frame: metres east (x) and north (y) of the bbox's south-west corner, the same frame as the sim's Vec2.
// Everything built here is immutable once made, so the lazily built graphs are safe to share.
import raw from './hawassa.json';
import type { Vec2 } from '../contracts/types';

// ---------- data types ----------
export type RoadClass = 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'minor' | 'track';
export type PlaceKind = 'city' | 'village' | 'hamlet';
export type XY = [number, number];

export interface GeoRoad { cls: RoadClass; pts: XY[] }
export interface GeoWater { name: string; pts: XY[] }
export interface GeoRiver { name: string; cls: string; pts: XY[] }
export interface GeoPlace { name: string; kind: PlaceKind; pos: XY }
export interface GeoHealth { name: string; kind: string; pos: XY }
export interface GeoData {
  name: string;
  bbox: { south: number; west: number; north: number; east: number };
  size: number;                                          // metres across (square)
  metresPerDeg: { x: number; y: number };
  attribution: string;
  elevation: { grid: number; metres: number[] };         // grid x grid, row-major from the SW corner, rows go north
  roads: GeoRoad[];
  water: GeoWater[];                                     // water[0] is Lake Hawassa (closed ring)
  rivers: GeoRiver[];
  places: GeoPlace[];
  health: GeoHealth[];
}

export const GEO: GeoData = raw as unknown as GeoData;
export const GEO_SIZE = GEO.size;
export const ROAD_CLASSES: readonly RoadClass[] = ['trunk', 'primary', 'secondary', 'tertiary', 'minor', 'track'];

/** Credit line for anything drawn from this data (and the satellite imagery bundled next to it). */
export const ATTRIBUTION =
  'Imagery: Sentinel-2 cloudless 2020 by EOX (contains modified Copernicus Sentinel data), CC BY-NC-SA 4.0; ' +
  'Map data © OpenStreetMap contributors; elevation Copernicus DEM';

const v2 = (p: XY): Vec2 => ({ x: p[0], y: p[1] });
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Closest point on segment ab to p, with its parameter t in [0,1]. */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; t: number } {
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

// ---------- elevation ----------
const EG = GEO.elevation.grid;
const EM = GEO.elevation.metres;
const ESTEP = GEO_SIZE / (EG - 1);                       // grid samples sit on the corners: 0, step, ..., size
const elev = (col: number, row: number): number =>
  EM[Math.max(0, Math.min(EG - 1, row)) * EG + Math.max(0, Math.min(EG - 1, col))];

/** Ground height in metres above sea level (bilinear on the DEM grid; clamped at the edges). */
export function heightAt(x: number, y: number): number {
  const gx = Math.max(0, Math.min(EG - 1, x / ESTEP)), gy = Math.max(0, Math.min(EG - 1, y / ESTEP));
  const c = Math.min(EG - 2, Math.floor(gx)), r = Math.min(EG - 2, Math.floor(gy));
  const fx = gx - c, fy = gy - r;
  const a = elev(c, r) + (elev(c + 1, r) - elev(c, r)) * fx;
  const b = elev(c, r + 1) + (elev(c + 1, r + 1) - elev(c, r + 1)) * fx;
  return a + (b - a) * fy;
}

/** Smoother height for drawing (Catmull-Rom bicubic on the same grid), so the coarse DEM shows no creases. */
export function heightAtSmooth(x: number, y: number): number {
  const gx = Math.max(0, Math.min(EG - 1, x / ESTEP)), gy = Math.max(0, Math.min(EG - 1, y / ESTEP));
  const c = Math.min(EG - 2, Math.floor(gx)), r = Math.min(EG - 2, Math.floor(gy));
  const fx = gx - c, fy = gy - r;
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const row = (rr: number) => cr(elev(c - 1, rr), elev(c, rr), elev(c + 1, rr), elev(c + 2, rr), fx);
  return cr(row(r - 1), row(r), row(r + 1), row(r + 2), fy);
}

export const ELEVATION_RANGE: [number, number] = [Math.min(...EM), Math.max(...EM)];

// ---------- Lake Hawassa ----------
function ring(pts: XY[]): Vec2[] {
  const out = pts.map(v2);
  if (out.length > 1 && dist(out[0], out[out.length - 1]) < 0.5) out.pop();
  return out;
}

export const LAKE_NAME = GEO.water[0].name || 'Lake Hawassa';
/** Lake Hawassa's shoreline, an open ring (last point joins the first). */
export const LAKE: Vec2[] = ring(GEO.water[0].pts);
const LAKE_BOX = bboxOf(LAKE);

function bboxOf(pts: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}

/** Even-odd point in polygon. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const inLake = (p: Vec2): boolean =>
  p.x >= LAKE_BOX.x0 && p.x <= LAKE_BOX.x1 && p.y >= LAKE_BOX.y0 && p.y <= LAKE_BOX.y1 && pointInPolygon(p, LAKE);

/** Nearest point on the shoreline, and how far it is. */
export function nearestShore(p: Vec2): { q: Vec2; d: number; seg: number } {
  let best = { q: LAKE[0], d: Infinity, seg: 0 };
  for (let i = 0; i < LAKE.length; i++) {
    const { q } = projectOnSegment(p, LAKE[i], LAKE[(i + 1) % LAKE.length]);
    const d = dist(p, q);
    if (d < best.d) best = { q, d, seg: i };
  }
  return best;
}

/** Signed distance to the shore: negative inside the lake. */
export const lakeDistance = (p: Vec2): number => (inLake(p) ? -1 : 1) * nearestShore(p).d;

export const LAKE_CENTROID: Vec2 = (() => {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < LAKE.length; i++) {
    const p = LAKE[i], q = LAKE[(i + 1) % LAKE.length];
    const k = p.x * q.y - q.x * p.y;
    a += k; cx += (p.x + q.x) * k; cy += (p.y + q.y) * k;
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
})();
export const LAKE_AREA_M2: number = (() => {
  let a = 0;
  for (let i = 0; i < LAKE.length; i++) { const p = LAKE[i], q = LAKE[(i + 1) % LAKE.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a / 2);
})();

/** Do segments ab and cd properly cross (touching at an end does not count)? */
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Is the straight line a-b open water all the way (both ends in the lake, no shore crossed)? */
export function segmentInLake(a: Vec2, b: Vec2): boolean {
  if (!inLake(a) || !inLake(b)) return false;
  for (let i = 0; i < LAKE.length; i++) if (segmentsCross(a, b, LAKE[i], LAKE[(i + 1) % LAKE.length])) return false;
  return inLake({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

const LANDING_INSET = 60;                                // boats stop this far out from the shoreline

/** Where a boat would land for a point: the point itself if it is open water, else just off the nearest shore. */
export function lakeLanding(p: Vec2, inset = LANDING_INSET): Vec2 {
  const s = nearestShore(p);
  if (inLake(p) && s.d >= inset * 0.5) return { x: p.x, y: p.y };
  // step from the shore point into the lake, along the shore normal (towards the centroid if that fails)
  const a = LAKE[s.seg], b = LAKE[(s.seg + 1) % LAKE.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const n1 = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  for (const k of [1, -1]) {
    for (const f of [1, 0.6, 0.3]) {
      const q = { x: s.q.x + n1.x * k * inset * f, y: s.q.y + n1.y * k * inset * f };
      if (inLake(q)) return q;
    }
  }
  const dx = LAKE_CENTROID.x - s.q.x, dy = LAKE_CENTROID.y - s.q.y, dl = Math.hypot(dx, dy) || 1;
  for (let f = 1; f <= 40; f++) {
    const q = { x: s.q.x + (dx / dl) * inset * f * 0.5, y: s.q.y + (dy / dl) * inset * f * 0.5 };
    if (inLake(q)) return q;
  }
  return { ...LAKE_CENTROID };
}

/** Douglas-Peucker on an open ring (keeps the shape within `tol` metres). */
function simplifyRing(pts: Vec2[], tol: number): Vec2[] {
  const closed = [...pts, pts[0]];
  const keep = new Uint8Array(closed.length);
  const rec = (i: number, j: number) => {
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = dist(closed[k], projectOnSegment(closed[k], closed[i], closed[j]).q);
      if (d > bd) { bd = d; best = k; }
    }
    if (best >= 0) { keep[best] = 1; rec(i, best); rec(best, j); }
  };
  const far = pts.reduce((bi, p, i) => (dist(p, pts[0]) > dist(pts[bi], pts[0]) ? i : bi), 0);
  keep[0] = keep[far] = 1;
  rec(0, far);
  rec(far, closed.length - 1);
  return pts.filter((_, i) => keep[i]);
}

// ---------- boats: a visibility graph inside the lake ----------
/**
 * Boats only ever move on Lake Hawassa. A straight line is used when it stays on open water; otherwise
 * the boat follows a visibility graph between waypoints set just inside the shoreline.
 */
export class LakeGraph {
  readonly nodes: Vec2[];
  readonly edges: [number, number][];
  private readonly adj: { j: number; w: number }[][];
  private readonly memo = new Map<string, Vec2[]>();

  constructor(inset = 150) {
    const simple = simplifyRing(LAKE, 120);
    const nodes: Vec2[] = [];
    for (let i = 0; i < simple.length; i++) {
      const prev = simple[(i - 1 + simple.length) % simple.length], p = simple[i], next = simple[(i + 1) % simple.length];
      // inward = average of the two edge normals, sign chosen so it points into the lake
      const n = (a: Vec2, b: Vec2) => { const l = dist(a, b) || 1; return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }; };
      const na = n(prev, p), nb = n(p, next);
      let nx = na.x + nb.x, ny = na.y + nb.y;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      let q: Vec2 | null = null;
      for (const k of [1, -1]) for (const f of [1, 0.5]) {
        const c = { x: p.x + nx * k * inset * f, y: p.y + ny * k * inset * f };
        if (!q && inLake(c) && nearestShore(c).d >= inset * f * 0.4) q = c;
      }
      if (q) nodes.push(q);
    }
    this.nodes = nodes;
    this.edges = [];
    this.adj = nodes.map(() => []);
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        if (segmentInLake(nodes[i], nodes[j])) {
          const w = dist(nodes[i], nodes[j]);
          this.edges.push([i, j]);
          this.adj[i].push({ j, w });
          this.adj[j].push({ j: i, w });
        }
  }

  /** In-lake path from a to b (both moved to their landing point first). */
  route(from: Vec2, to: Vec2): Vec2[] {
    const f = lakeLanding(from), t = lakeLanding(to);
    const key = `${Math.round(f.x)},${Math.round(f.y)}>${Math.round(t.x)},${Math.round(t.y)}`;
    const hit = this.memo.get(key);
    if (hit) return [from, ...hit.map((p) => ({ ...p }))];
    let mid: Vec2[];
    if (segmentInLake(f, t) || dist(f, t) < 1) mid = [f, t];
    else {
      // Dijkstra over waypoints + the two ends (n is small, about 40)
      const n = this.nodes.length;
      const S = n, T = n + 1;
      const pos = (i: number) => (i === S ? f : i === T ? t : this.nodes[i]);
      const fromS = this.nodes.map((p, i) => ({ j: i, w: dist(f, p), ok: segmentInLake(f, p) })).filter((e) => e.ok);
      const toT = new Map<number, number>();
      this.nodes.forEach((p, i) => { if (segmentInLake(p, t)) toT.set(i, dist(p, t)); });
      const D = new Float64Array(n + 2).fill(Infinity);
      const prev = new Int32Array(n + 2).fill(-1);
      const done = new Uint8Array(n + 2);
      D[S] = 0;
      for (;;) {
        let u = -1;
        for (let i = 0; i < n + 2; i++) if (!done[i] && D[i] < Infinity && (u < 0 || D[i] < D[u])) u = i;
        if (u < 0 || u === T) break;
        done[u] = 1;
        const out = u === S ? fromS : this.adj[u];
        for (const e of out) if (D[u] + e.w < D[e.j]) { D[e.j] = D[u] + e.w; prev[e.j] = u; }
        if (u !== S && toT.has(u)) { const w = toT.get(u)!; if (D[u] + w < D[T]) { D[T] = D[u] + w; prev[T] = u; } }
      }
      if (D[T] === Infinity) mid = [f, t];               // cannot happen on a connected lake; fall back to straight
      else {
        const chain: Vec2[] = [];
        for (let i = T; i >= 0; i = prev[i]) chain.push(pos(i));
        mid = chain.reverse();
      }
    }
    mid = mid.filter((p, k) => k === 0 || dist(p, mid[k - 1]) > 1);
    if (this.memo.size > 4000) this.memo.clear();
    this.memo.set(key, mid);
    return [from, ...mid.map((p) => ({ ...p }))].filter((p, k, a) => k === 0 || dist(p, a[k - 1]) > 1);
  }
}

let lakeGraphCached: LakeGraph | null = null;
export const lakeGraph = (): LakeGraph => (lakeGraphCached ??= new LakeGraph());

/** Boat path on Lake Hawassa (never touches land except the starting point if it was ashore). */
export const lakeRoute = (from: Vec2, to: Vec2): Vec2[] => lakeGraph().route(from, to);

// ---------- roads: a routable graph ----------
/**
 * Relative speed by road class, used to choose routes (cost = length / factor): carriers prefer the
 * trunk and primary roads and avoid tracks unless they are much shorter.
 */
export const SPEED_FACTOR: Record<RoadClass, number> = {
  trunk: 1.3, primary: 1.2, secondary: 1.0, tertiary: 0.9, minor: 0.75, track: 0.5,
};
export const OFFROAD_FACTOR = 0.4;                       // walking a bike or van off the road network
export const SNAP_M = 15;                                // road ends this close to another road join it

export interface RoadSeg { a: number; b: number; cls: RoadClass; len: number; cost: number }
export interface RoadSnap { seg: number; t: number; q: Vec2; d: number }
export interface RoadPath { path: Vec2[]; length: number; cost: number }

interface Tree { cost: Float64Array; len: Float64Array; prev: Int32Array }

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return [topK, topV];
  }
}

/**
 * The road network: OSM ways split into straight segments. Way ends within SNAP_M of another way's
 * vertex or segment are joined to it (T-junctions survive the simplification of the source data).
 * Only the largest connected network is kept, so every snapped point can reach every other.
 */
export class RoadGraph {
  readonly nodes: Vec2[];
  readonly segs: RoadSeg[];
  private readonly adjStart: Int32Array;
  private readonly adjNode: Int32Array;
  private readonly adjSeg: Int32Array;
  private readonly grid = new Map<number, number[]>();
  private readonly cell = 400;
  private readonly trees = new Map<number, Tree>();
  private readonly maxTrees = 160;

  constructor(roads: GeoRoad[] = GEO.roads) {
    // 1. raw vertices and segments
    const P: Vec2[] = [];
    const rawSegs: { a: number; b: number; cls: RoadClass }[] = [];
    const ends: number[] = [];
    for (const r of roads) {
      if (r.pts.length < 2) continue;
      const base = P.length;
      r.pts.forEach((p) => P.push(v2(p)));
      const inside = (q: Vec2) => q.x >= 0 && q.y >= 0 && q.x <= GEO_SIZE && q.y <= GEO_SIZE;
      for (let i = 1; i < r.pts.length; i++)
        if (inside(P[base + i - 1]) && inside(P[base + i])) rawSegs.push({ a: base + i - 1, b: base + i, cls: r.cls });
      ends.push(base, base + r.pts.length - 1);
    }
    // 2. union vertices closer than SNAP_M (grid hash)
    const par = P.map((_, i) => i);
    const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const unite = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) par[Math.max(a, b)] = Math.min(a, b); };
    const vg = new Map<string, number[]>();
    const vk = (x: number, y: number) => `${Math.floor(x / SNAP_M)},${Math.floor(y / SNAP_M)}`;
    P.forEach((p, i) => { const k = vk(p.x, p.y); const l = vg.get(k); if (l) l.push(i); else vg.set(k, [i]); });
    P.forEach((p, i) => {
      const cx = Math.floor(p.x / SNAP_M), cy = Math.floor(p.y / SNAP_M);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        for (const j of vg.get(`${cx + dx},${cy + dy}`) ?? []) if (j > i && dist(P[i], P[j]) <= SNAP_M) unite(i, j);
    });
    // 3. way ends that sit on another segment: split that segment there
    const sg = new Map<string, number[]>();
    const SC = 500;
    rawSegs.forEach((s, e) => {
      const A = P[s.a], B = P[s.b];
      for (let x = Math.floor((Math.min(A.x, B.x) - SNAP_M) / SC); x <= Math.floor((Math.max(A.x, B.x) + SNAP_M) / SC); x++)
        for (let y = Math.floor((Math.min(A.y, B.y) - SNAP_M) / SC); y <= Math.floor((Math.max(A.y, B.y) + SNAP_M) / SC); y++) {
          const k = `${x},${y}`; const l = sg.get(k); if (l) l.push(e); else sg.set(k, [e]);
        }
    });
    const splits = new Map<number, { t: number; v: number }[]>();
    for (const ei of ends) {
      const p = P[ei];
      let best: { e: number; t: number; d: number } | null = null;
      for (const e of sg.get(`${Math.floor(p.x / SC)},${Math.floor(p.y / SC)}`) ?? []) {
        const s = rawSegs[e];
        if (find(s.a) === find(ei) || find(s.b) === find(ei)) continue;
        const { q, t } = projectOnSegment(p, P[s.a], P[s.b]);
        const d = dist(p, q);
        if (d <= SNAP_M && (!best || d < best.d)) best = { e, t, d };
      }
      if (!best) continue;
      const l = splits.get(best.e);
      if (l) l.push({ t: best.t, v: ei }); else splits.set(best.e, [{ t: best.t, v: ei }]);
    }
    // 4. final segment list on representative vertices
    const segs0: { a: number; b: number; cls: RoadClass }[] = [];
    rawSegs.forEach((s, e) => {
      const chain = [s.a, ...(splits.get(e) ?? []).sort((x, y) => x.t - y.t).map((x) => x.v), s.b].map(find);
      for (let i = 1; i < chain.length; i++) if (chain[i] !== chain[i - 1]) segs0.push({ a: chain[i - 1], b: chain[i], cls: s.cls });
    });
    // 5. keep the largest connected network
    const cp = P.map((_, i) => i);
    const cf = (i: number): number => { while (cp[i] !== i) { cp[i] = cp[cp[i]]; i = cp[i]; } return i; };
    for (const s of segs0) { const a = cf(s.a), b = cf(s.b); if (a !== b) cp[Math.max(a, b)] = Math.min(a, b); }
    const size = new Map<number, number>();
    for (const s of segs0) size.set(cf(s.a), (size.get(cf(s.a)) ?? 0) + 1);
    let main = -1, mainN = -1;
    for (const [r, n] of size) if (n > mainN || (n === mainN && r < main)) { main = r; mainN = n; }
    const remap = new Map<number, number>();
    const nodes: Vec2[] = [];
    const idOf = (i: number) => { let k = remap.get(i); if (k === undefined) { k = nodes.length; remap.set(i, k); nodes.push(P[i]); } return k; };
    const seen = new Set<string>();
    const segs: RoadSeg[] = [];
    for (const s of segs0) {
      if (cf(s.a) !== main) continue;
      const a = idOf(s.a), b = idOf(s.b);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const len = dist(nodes[a], nodes[b]);
      segs.push({ a, b, cls: s.cls, len, cost: len / SPEED_FACTOR[s.cls] });
    }
    this.nodes = nodes;
    this.segs = segs;
    // CSR adjacency
    const deg = new Int32Array(nodes.length);
    for (const s of segs) { deg[s.a]++; deg[s.b]++; }
    this.adjStart = new Int32Array(nodes.length + 1);
    for (let i = 0; i < nodes.length; i++) this.adjStart[i + 1] = this.adjStart[i] + deg[i];
    this.adjNode = new Int32Array(this.adjStart[nodes.length]);
    this.adjSeg = new Int32Array(this.adjStart[nodes.length]);
    const fill = this.adjStart.slice(0, nodes.length);
    segs.forEach((s, e) => {
      this.adjNode[fill[s.a]] = s.b; this.adjSeg[fill[s.a]++] = e;
      this.adjNode[fill[s.b]] = s.a; this.adjSeg[fill[s.b]++] = e;
    });
    // spatial index of segments
    segs.forEach((s, e) => {
      const A = nodes[s.a], B = nodes[s.b];
      for (let x = Math.floor(Math.min(A.x, B.x) / this.cell); x <= Math.floor(Math.max(A.x, B.x) / this.cell); x++)
        for (let y = Math.floor(Math.min(A.y, B.y) / this.cell); y <= Math.floor(Math.max(A.y, B.y) / this.cell); y++) {
          const k = this.key(x, y); const l = this.grid.get(k); if (l) l.push(e); else this.grid.set(k, [e]);
        }
    });
  }

  private key(x: number, y: number): number { return (x + 1000) * 4096 + (y + 1000); }

  /** Nearest point on the road network. */
  snap(p: Vec2): RoadSnap {
    const cx = Math.floor(p.x / this.cell), cy = Math.floor(p.y / this.cell);
    let best: RoadSnap = { seg: -1, t: 0, q: p, d: Infinity };
    for (let r = 0; r < 200; r++) {
      // ring r of grid cells; stop once the ring is further than the best hit
      if (best.seg >= 0 && (r - 1) * this.cell > best.d) break;
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
          for (const e of this.grid.get(this.key(x, y)) ?? []) {
            const s = this.segs[e];
            const { q, t } = projectOnSegment(p, this.nodes[s.a], this.nodes[s.b]);
            const d = dist(p, q);
            if (d < best.d || (d === best.d && e < best.seg)) best = { seg: e, t, q, d };
          }
        }
    }
    return best;
  }

  /** Shortest-cost tree from one node (cached; results never depend on what is cached). */
  private tree(src: number): Tree {
    const hit = this.trees.get(src);
    if (hit) { this.trees.delete(src); this.trees.set(src, hit); return hit; }
    const n = this.nodes.length;
    const cost = new Float64Array(n).fill(Infinity), len = new Float64Array(n), prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const h = new MinHeap();
    cost[src] = 0;
    h.push(0, src);
    while (h.size) {
      const [c, u] = h.pop();
      if (done[u]) continue;
      done[u] = 1;
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        const v = this.adjNode[k], s = this.segs[this.adjSeg[k]];
        const nc = c + s.cost;
        if (!done[v] && (nc < cost[v] || (nc === cost[v] && u < prev[v]))) { cost[v] = nc; len[v] = len[u] + s.len; prev[v] = u; h.push(nc, v); }
      }
    }
    const t = { cost, len, prev };
    this.trees.set(src, t);
    if (this.trees.size > this.maxTrees) this.trees.delete(this.trees.keys().next().value!);
    return t;
  }

  /**
   * Best way from one snapped point to another over the network. Always searched from the `to` side,
   * so the answer is the same whatever happens to be cached.
   */
  private best(sf: RoadSnap, st: RoadSnap): { a: number; b: number; cost: number; len: number; direct: boolean } {
    const A = this.segs[sf.seg], B = this.segs[st.seg];
    let out = { a: -1, b: -1, cost: Infinity, len: Infinity, direct: false };
    if (sf.seg === st.seg) {
      const dt = Math.abs(sf.t - st.t);
      out = { a: -1, b: -1, cost: dt * A.cost, len: dt * A.len, direct: true };
    }
    const ends: [number, number, number][] = [[A.a, sf.t * A.cost, sf.t * A.len], [A.b, (1 - sf.t) * A.cost, (1 - sf.t) * A.len]];
    const tails: [number, number, number][] = [[B.a, st.t * B.cost, st.t * B.len], [B.b, (1 - st.t) * B.cost, (1 - st.t) * B.len]];
    for (const [b, cb, lb] of tails) {
      const tr = this.tree(b);
      for (const [a, ca, la] of ends) {
        const c = ca + tr.cost[a] + cb;
        if (c < out.cost - 1e-9) out = { a, b, cost: c, len: la + tr.len[a] + lb, direct: false };
      }
    }
    return out;
  }

  /** Cost and length of the best road route between two points, including the off-road ends. */
  measure(from: Vec2, to: Vec2, offRoadEnds = true): { length: number; cost: number } {
    const sf = this.snap(from), st = this.snap(to);
    const b = this.best(sf, st);
    const off = offRoadEnds ? sf.d + st.d : sf.d;
    return { length: b.len + off, cost: b.cost + off / OFFROAD_FACTOR };
  }

  /** The road route itself: [from, onto the road, ...junctions, off the road, to?]. */
  shortestPath(from: Vec2, to: Vec2, offRoadEnd = true): RoadPath {
    const sf = this.snap(from), st = this.snap(to);
    const b = this.best(sf, st);
    const path: Vec2[] = [from, sf.q];
    if (!b.direct) {
      let i = b.a;
      const tr = this.tree(b.b);
      for (let guard = 0; i >= 0 && guard < this.nodes.length; guard++) {
        path.push(this.nodes[i]);
        if (i === b.b) break;
        i = tr.prev[i];
      }
    }
    path.push(st.q);
    if (offRoadEnd) path.push(to);
    const clean = path.filter((p, k) => k === 0 || dist(p, path[k - 1]) > 1).map((p) => ({ x: p.x, y: p.y }));
    const off = offRoadEnd ? sf.d + st.d : sf.d;
    return { path: clean, length: b.len + off, cost: b.cost + off / OFFROAD_FACTOR };
  }

  /** The class of road under a point (null if it is more than `maxD` metres from any road). */
  classAt(p: Vec2, maxD = 60): RoadClass | null {
    const s = this.snap(p);
    return s.d <= maxD ? this.segs[s.seg].cls : null;
  }
}

let roadGraphCached: RoadGraph | null = null;
/** The Hawassa road graph, built once on first use (about 9k nodes). */
export const roadGraph = (): RoadGraph => (roadGraphCached ??= new RoadGraph());

/** Shortest road route between two points, snapping both ends to the nearest road. */
export const shortestPath = (from: Vec2, to: Vec2): RoadPath => roadGraph().shortestPath(from, to);

// ---------- named places ----------
export interface Place { name: string; kind: PlaceKind; pos: Vec2 }
/** Every named place in the data (unnamed ones dropped). */
export const PLACES: Place[] = GEO.places.filter((p) => p.name.trim()).map((p) => ({ name: p.name, kind: p.kind, pos: v2(p.pos) }));

export function placeByName(name: string): Place | undefined {
  const n = name.toLowerCase();
  return PLACES.find((p) => p.name.toLowerCase() === n);
}

export function nearestPlace(p: Vec2, maxD = Infinity, kinds?: PlaceKind[]): Place | null {
  let best: Place | null = null, bd = maxD;
  for (const q of PLACES) {
    if (kinds && !kinds.includes(q.kind)) continue;
    const d = dist(p, q.pos);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

/** Rivers and streams as polylines (for drawing). */
export const RIVERS: { name: string; cls: string; pts: Vec2[] }[] = GEO.rivers.map((r) => ({ name: r.name, cls: r.cls, pts: r.pts.map(v2) }));
/** Other water bodies besides Lake Hawassa (small lakes, ponds), as open rings. */
export const OTHER_WATER: { name: string; pts: Vec2[] }[] = GEO.water.slice(1).map((w) => ({ name: w.name, pts: ring(w.pts) }));
/** Roads straight from the data, by class (for drawing; includes pieces not on the main network). */
export const ROADS: { cls: RoadClass; pts: Vec2[] }[] = GEO.roads.map((r) => ({ cls: r.cls, pts: r.pts.map(v2) }));
