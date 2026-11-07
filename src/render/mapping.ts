// Pure helpers for the renderer: world <-> scene mapping, interpolation, seeded noise terrain,
// river/lake geometry and the road graph. No three.js and no DOM here, so it is unit-tested in node.
import { createNoise2D } from 'simplex-noise';
import { CELL_SIZE, WORLD_SIZE } from '../contracts/config';
import type { Vec2 } from '../contracts/types';

// ---------- world <-> scene ----------
// The scene is SCENE_SIZE units across, centred on the origin. World y (north) maps to scene -z,
// so north is "away from" the default camera.
export const SCENE_SIZE = 400;
export const SCALE = SCENE_SIZE / WORLD_SIZE;          // scene units per metre (1 unit = 100 m)

export function worldToScene(p: Vec2): { x: number; z: number } {
  return { x: (p.x - WORLD_SIZE / 2) * SCALE, z: -(p.y - WORLD_SIZE / 2) * SCALE };
}

export function sceneToWorld(x: number, z: number): Vec2 {
  return { x: x / SCALE + WORLD_SIZE / 2, y: -z / SCALE + WORLD_SIZE / 2 };
}

export function clampToWorld(p: Vec2): Vec2 {
  return { x: Math.min(WORLD_SIZE, Math.max(0, p.x)), y: Math.min(WORLD_SIZE, Math.max(0, p.y)) };
}

// ---------- interpolation ----------
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerpVec2 = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

/** Shortest-way angle interpolation (radians), so a heading of 350 deg -> 10 deg turns 20 deg, not 340. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Frame-rate independent smoothing factor: how far to move toward a target this frame. */
export const damp = (rate: number, dtSec: number): number => 1 - Math.exp(-rate * dtSec);

/**
 * Tracks when snapshots arrive so the renderer can blend between them at 60 fps.
 * interval is a smoothed estimate of the gap between update() calls.
 */
export class UpdateClock {
  lastAt = -1;
  interval = 250;                                       // ms, first guess
  mark(nowMs: number): void {
    if (this.lastAt >= 0) {
      const gap = Math.min(2000, Math.max(8, nowMs - this.lastAt));
      this.interval = lerp(this.interval, gap, 0.3);
    }
    this.lastAt = nowMs;
  }
  /** 0 right after an update, 1 once the next update is due. Never extrapolates past 1. */
  alpha(nowMs: number): number {
    if (this.lastAt < 0) return 1;
    return clamp01((nowMs - this.lastAt) / this.interval);
  }
}

// ---------- seeded randomness ----------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------- river, lake ----------
export interface WaterShape {
  river: Vec2[];                                        // polyline, world metres
  riverHalfWidth: number;                               // metres
  lake: { pos: Vec2; radius: number };
}

// Fictional geography (world metres). The lead can override it with the sim's own shapes.
export const DEFAULT_WATER: WaterShape = {
  river: smoothPolyline([
    { x: 15500, y: 40500 }, { x: 17200, y: 35500 }, { x: 15600, y: 30500 }, { x: 18200, y: 25500 },
    { x: 20600, y: 19400 }, { x: 21500, y: 17000 }, { x: 22600, y: 14400 }, { x: 25600, y: 10200 },
    { x: 24300, y: 5200 }, { x: 27000, y: -500 },
  ], 8),
  riverHalfWidth: 260,
  lake: { pos: { x: 21500, y: 17000 }, radius: 2300 },
};

/** Catmull-Rom smoothing: `steps` points per segment. */
export function smoothPolyline(pts: Vec2[], steps: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function distToPolyline(p: Vec2, line: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) best = Math.min(best, distToSegment(p, line[i], line[i + 1]));
  return best;
}

/** Distance from p to the nearest water edge; negative means p is in the water. */
export function waterDistance(p: Vec2, w: WaterShape): number {
  const river = distToPolyline(p, w.river) - w.riverHalfWidth;
  const lake = Math.hypot(p.x - w.lake.pos.x, p.y - w.lake.pos.y) - w.lake.radius;
  return Math.min(river, lake);
}

// ---------- terrain height ----------
export const WATER_LEVEL = 0.6;                         // scene units
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export interface HeightField {
  water: WaterShape;
  /** Terrain height in scene units at a world position (vertically exaggerated for readability). */
  heightAt(p: Vec2): number;
  /** 0..1 noise for colour variation. */
  tint(p: Vec2): number;
}

export function makeHeightField(seed: number, water: WaterShape = DEFAULT_WATER): HeightField {
  const noise = createNoise2D(mulberry32(seed));
  const fbm = (x: number, y: number): number => {
    let sum = 0, amp = 1, f = 1 / 9000, norm = 0;
    for (let o = 0; o < 4; o++) {
      sum += noise(x * f, y * f) * amp;
      norm += amp; amp *= 0.5; f *= 2.1;
    }
    return sum / norm;                                  // about -1..1
  };
  const heightAt = (p: Vec2): number => {
    // Rolling land, flatter in the west (district town) and hillier toward the east.
    const east = 0.35 + 0.65 * smooth(3000, 32000, p.x);
    const n = fbm(p.x, p.y) * 0.5 + 0.5;
    const ridge = 1 - Math.abs(noise(p.x / 14000 + 7.3, p.y / 14000 - 2.1));
    const base = 2.2 + east * (9 * Math.pow(n, 1.5) + 7 * ridge * ridge * smooth(15000, 38000, p.x));
    // Carve the river and the lake: below water inside, gentle banks in a valley around it.
    const d = waterDistance(p, water);
    if (d < 0) return WATER_LEVEL - 0.35 - Math.min(1.2, -d / 600);
    return lerp(WATER_LEVEL + 0.25, base, smooth(0, 2600, d));
  };
  return { water, heightAt, tint: (p) => noise(p.x / 2500 + 31, p.y / 2500 - 17) * 0.5 + 0.5 };
}

// ---------- road graph ----------
/**
 * Dirt roads between settlements: a minimum spanning tree (every place reachable) plus a few
 * short extra links so the network has loops, like real rural roads. Returns index pairs.
 */
export function roadEdges(points: Vec2[], extraMaxDist = 9000): [number, number][] {
  const n = points.length;
  if (n < 2) return [];
  const d = (i: number, j: number) => Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const from = new Array<number>(n).fill(-1);
  const edges: [number, number][] = [];
  best[0] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
    inTree[u] = true;
    if (from[u] >= 0) edges.push([from[u], u]);
    for (let v = 0; v < n; v++) if (!inTree[v] && d(u, v) < best[v]) { best[v] = d(u, v); from[v] = u; }
  }
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const have = new Set(edges.map(([a, b]) => key(a, b)));
  for (let i = 0; i < n; i++) {
    // second-nearest neighbour gives a loop when it is close enough
    const order = [...Array(n).keys()].filter((j) => j !== i).sort((a, b) => d(i, a) - d(i, b));
    const j = order[1];
    if (j !== undefined && d(i, j) < extraMaxDist && !have.has(key(i, j))) { have.add(key(i, j)); edges.push([i, j]); }
  }
  return edges;
}

/** A gently curving road between two points (deterministic wobble), sampled every `step` metres. */
export function roadPath(a: Vec2, b: Vec2, seed: number, step = 250): Vec2[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.ceil(len / step));
  const nx = -(b.y - a.y) / (len || 1), ny = (b.x - a.x) / (len || 1);
  const rng = mulberry32(seed);
  const bend1 = (rng() - 0.5) * 0.18 * len, bend2 = (rng() - 0.5) * 0.08 * len;
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = Math.sin(t * Math.PI) * bend1 + Math.sin(t * Math.PI * 2) * bend2;
    out.push({ x: lerp(a.x, b.x, t) + nx * off, y: lerp(a.y, b.y, t) + ny * off });
  }
  return out;
}

// ---------- cells ----------
export const CELLS = Math.round(WORLD_SIZE / CELL_SIZE);
export function cellIdOf(p: Vec2): string {
  const c = Math.min(CELLS - 1, Math.max(0, Math.floor(p.x / CELL_SIZE)));
  const r = Math.min(CELLS - 1, Math.max(0, Math.floor(p.y / CELL_SIZE)));
  return `C${c}-${r}`;
}

// ---------- fictional names ----------
export const VILLAGE_NAMES = [
  'Kesu', 'Maranda', 'Tolobi', 'Ombasi', 'Lirenga', 'Nyakiri', 'Sabé', 'Dunafo', 'Watoro', 'Pemuli',
  'Itamba', 'Korongo', 'Behula', 'Sinjeri',
];
export const HUB_NAMES = ['Hub Ndaro', 'Hub Felu', 'Hub Kamasi', 'Hub Otenga', 'Hub Rivo'];
export const TOWN_NAME = 'Amari (district town)';
export const MARKET_NAME = 'Tembari Market';
export const RIVER_NAME = 'Lenai River';
export const LAKE_NAME = 'Lake Simba-Nui';
