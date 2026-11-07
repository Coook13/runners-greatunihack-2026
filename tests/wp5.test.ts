// WP5: pure renderer helpers only (WebGL is not available in node).
import { describe, expect, it } from 'vitest';
import { CELL_COVERAGE, WORLD_SIZE } from '../src/contracts/config';
import {
  DEFAULT_WATER, SCENE_SIZE, UpdateClock, WATER_LEVEL, cellIdOf, distToPolyline, lerpAngle, lerpVec2,
  makeHeightField, mulberry32, roadEdges, roadPath, sceneToWorld, waterDistance, worldToScene,
} from '../src/render/mapping';

describe('world <-> scene mapping', () => {
  it('maps corners and centre, north is -z, and round-trips', () => {
    expect(worldToScene({ x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 })).toEqual({ x: 0, z: -0 });
    const sw = worldToScene({ x: 0, y: 0 });
    expect(sw.x).toBeCloseTo(-SCENE_SIZE / 2);
    expect(sw.z).toBeCloseTo(SCENE_SIZE / 2);
    const ne = worldToScene({ x: WORLD_SIZE, y: WORLD_SIZE });
    expect(ne.z).toBeLessThan(0);
    for (const p of [{ x: 123, y: 39000 }, { x: 20000, y: 7 }]) {
      const s = worldToScene(p);
      const back = sceneToWorld(s.x, s.z);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('cell ids follow the C{col}-{row} contract', () => {
    expect(cellIdOf({ x: 14500, y: 6100 })).toBe('C7-3');
    expect(cellIdOf({ x: WORLD_SIZE, y: WORLD_SIZE })).toBe('C19-19');
  });
});

describe('interpolation', () => {
  it('lerps positions and turns the short way round', () => {
    expect(lerpVec2({ x: 0, y: 0 }, { x: 10, y: -4 }, 0.5)).toEqual({ x: 5, y: -2 });
    const a = lerpAngle((350 * Math.PI) / 180, (10 * Math.PI) / 180, 0.5);
    expect(Math.cos(a)).toBeCloseTo(1, 6);              // halfway is 0 deg, not 180
  });

  it('UpdateClock blends 0 -> 1 between updates and never extrapolates', () => {
    const c = new UpdateClock();
    expect(c.alpha(0)).toBe(1);                         // nothing yet: draw the target
    c.mark(0); c.mark(100); c.mark(200); c.mark(300); c.mark(400); c.mark(500); c.mark(600); c.mark(700);
    expect(c.interval).toBeGreaterThan(95);
    expect(c.interval).toBeLessThan(140);
    expect(c.alpha(700)).toBe(0);
    expect(c.alpha(700 + c.interval / 2)).toBeCloseTo(0.5, 5);
    expect(c.alpha(5000)).toBe(1);
  });
});

describe('terrain and water', () => {
  const f = makeHeightField(7);
  it('is deterministic for a seed and different across seeds', () => {
    const p = { x: 31000, y: 12000 };
    expect(makeHeightField(7).heightAt(p)).toBe(f.heightAt(p));
    expect(makeHeightField(8).heightAt(p)).not.toBe(f.heightAt(p));
  });

  it('river and lake sit below water level, land above it', () => {
    expect(f.heightAt(DEFAULT_WATER.lake.pos)).toBeLessThan(WATER_LEVEL);
    const mid = DEFAULT_WATER.river[20];
    expect(f.heightAt(mid)).toBeLessThan(WATER_LEVEL);
    for (const c of CELL_COVERAGE) {
      expect(waterDistance(c.pos, DEFAULT_WATER)).toBeGreaterThan(0);
      expect(f.heightAt(c.pos)).toBeGreaterThan(WATER_LEVEL);
    }
  });

  it('heights stay in a sane range across the district', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 500; i++) {
      const h = f.heightAt({ x: rng() * WORLD_SIZE, y: rng() * WORLD_SIZE });
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(-2);
      expect(h).toBeLessThan(30);
    }
  });
});

describe('road graph', () => {
  it('connects every place (spanning tree plus loops)', () => {
    const rng = mulberry32(3);
    const pts = Array.from({ length: 16 }, () => ({ x: rng() * WORLD_SIZE, y: rng() * WORLD_SIZE }));
    const edges = roadEdges(pts);
    expect(edges.length).toBeGreaterThanOrEqual(pts.length - 1);
    const seen = new Set([0]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [a, b] of edges) if (seen.has(a) !== seen.has(b)) { seen.add(a); seen.add(b); changed = true; }
    }
    expect(seen.size).toBe(pts.length);
  });

  it('road paths start and end on the places and stay near the straight line', () => {
    const a = { x: 1000, y: 1000 }, b = { x: 9000, y: 5000 };
    const p = roadPath(a, b, 5);
    expect(p[0]).toEqual(a);
    expect(p[p.length - 1].x).toBeCloseTo(b.x, 6);
    expect(p[p.length - 1].y).toBeCloseTo(b.y, 6);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (const q of p) expect(distToPolyline(q, [a, b])).toBeLessThan(len * 0.15);
  });
});
