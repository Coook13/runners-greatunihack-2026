// Real Hawassa map: the geo loader and the world-hawassa drop-in for world.ts.
import { describe, expect, it } from 'vitest';
import { MEET_OFFSET } from '../src/contracts/config';
import type { Vec2 } from '../src/contracts/types';
import * as geo from '../src/geo';
import * as oldWorld from '../src/sim/world';
import * as hw from '../src/sim/world-hawassa';

const w = hw.createWorld();
const onRoad = (p: Vec2, tol = 1) => geo.roadGraph().snap(p).d <= tol;

describe('world-hawassa is a drop-in for world.ts', () => {
  it('exports the same names', () => {
    expect(Object.keys(hw).sort()).toEqual(Object.keys(oldWorld).sort());
    for (const k of Object.keys(oldWorld)) expect(typeof (hw as Record<string, unknown>)[k]).toBe(typeof (oldWorld as Record<string, unknown>)[k]);
  });

  it('has 3 stores, 3 hubs and 10 clinics at named real places', () => {
    expect(w.stores.map((s) => s.id)).toEqual(['store-A', 'store-B', 'store-C']);
    expect(w.hubs.map((h) => h.id)).toEqual(['hub-1', 'hub-2', 'hub-3']);
    expect(w.villages).toHaveLength(10);
    for (const v of w.villages) expect(geo.placeByName(v.name)).toBeDefined();
    expect(w.villages.some((v) => v.name === 'Dore') && w.villages.some((v) => v.name === 'Dembara')).toBe(true);
    // west of the lake
    for (const n of ['Dore', 'Dembara']) expect(w.villages.find((v) => v.name === n)!.pos.x).toBeLessThan(10000);
    for (const s of [...w.stores, ...w.hubs]) expect(onRoad(s.pos)).toBe(true);
  });

  it('cell coverage follows the real towers: the towns are covered, three remote clinics are dark', () => {
    expect(hw.hasCoverage(geo.placeByName('Hawassa')!.pos)).toBe(true);
    expect(hw.hasCoverage(geo.placeByName('Shashamane')!.pos)).toBe(true);
    // Harabet Shumba, Dembara and Morocho are genuinely remote: only the mesh reaches them (config.ts CELL_COVERAGE).
    for (const n of ['Harabet Shumba', 'Dembara', 'Morocho']) expect(hw.hasCoverage(geo.placeByName(n)!.pos)).toBe(false);
    expect(w.villages.filter((v) => hw.hasCoverage(v.pos))).toHaveLength(7);
  });
});

describe('routes', () => {
  const ends: Vec2[] = [...w.villages.map((v) => v.pos), ...w.stores.map((s) => s.pos)];

  it('every clinic and store is reachable from the district store by van and motorbike, on roads', () => {
    const from = w.stores[0].pos;
    for (const to of ends) {
      for (const kind of ['van', 'motorbike'] as const) {
        const path = w.map.route(kind, from, to);
        expect(path[0]).toEqual(from);
        expect(hw.dist(path[path.length - 1], to)).toBeLessThan(1);
        expect(Number.isFinite(w.map.eta(kind, from, to))).toBe(true);
        // every vertex except the off-road ends lies on a road segment
        for (const p of path.slice(1, -1)) expect(onRoad(p)).toBe(true);
        // and the off-road ends are short
        expect(geo.roadGraph().snap(to).d).toBeLessThan(MEET_OFFSET[1]);
      }
    }
  });

  it('drones fly straight and beat vans', () => {
    const a = w.hubs[1].pos, b = w.villages[4].pos;
    expect(w.map.route('drone', a, b)).toEqual([a, b]);
    expect(w.map.eta('drone', a, b)).toBeLessThan(w.map.eta('van', a, b));
  });

  it('boats stay on Lake Hawassa and can reach the west-shore landings from the Hawassa hub', () => {
    const hub = w.hubs.find((h) => h.id === 'hub-2')!;
    expect(geo.nearestShore(hub.pos).d).toBeLessThan(300);
    const start = w.water.snap(hub.pos).q;
    expect(geo.inLake(start)).toBe(true);
    for (const v of w.villages) {
      const landing = w.water.snap(v.pos).q;
      expect(geo.inLake(landing)).toBe(true);
      const path = w.map.route('boat', start, v.pos);
      for (const p of path) expect(geo.inLake(p)).toBe(true);
      for (let i = 1; i < path.length; i++) {
        // sample each leg: open water all the way
        for (let k = 1; k < 10; k++) {
          const t = k / 10;
          expect(geo.inLake({ x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t })).toBe(true);
        }
      }
      // boat + road: the landing is in reach of a road (or of a road leg from the landing)
      const fromLanding = w.map.route('motorbike', landing, v.pos);
      expect(hw.dist(fromLanding[fromLanding.length - 1], v.pos)).toBeLessThan(1);
    }
    expect(w.map.passable('boat', geo.LAKE_CENTROID)).toBe(true);
    expect(w.map.passable('boat', w.stores[0].pos)).toBe(false);
  });

  it('is deterministic', () => {
    const a = w.map.route('van', w.stores[2].pos, w.villages[5].pos);
    const b = hw.createWorld().map.route('van', w.stores[2].pos, w.villages[5].pos);
    expect(b).toEqual(a);
  });
});

describe('geo', () => {
  it('heightAt stays within 1600-2800 m everywhere', () => {
    for (let x = 0; x <= 40000; x += 500)
      for (let y = 0; y <= 40000; y += 500) {
        const h = geo.heightAt(x, y);
        expect(h).toBeGreaterThan(1600);
        expect(h).toBeLessThan(2800);
      }
    expect(geo.heightAt(geo.LAKE_CENTROID.x, geo.LAKE_CENTROID.y)).toBeLessThan(1700);
  });

  it('knows Lake Hawassa and the named places', () => {
    expect(geo.inLake(geo.LAKE_CENTROID)).toBe(true);
    expect(geo.inLake(geo.placeByName('Hawassa')!.pos)).toBe(false);
    expect(geo.placeByName('Shashamane')!.kind).toBe('city');
    expect(geo.PLACES.every((p) => p.name.trim().length > 0)).toBe(true);
  });

  it('shortestPath snaps both ends and prefers fast roads', () => {
    const r = geo.shortestPath(geo.placeByName('Hawassa')!.pos, geo.placeByName('Shashamane')!.pos);
    expect(r.length).toBeGreaterThan(20000);
    expect(r.length).toBeLessThan(40000);
    const trunkish = r.path.slice(1, -1).filter((p) => ['trunk', 'primary'].includes(geo.roadGraph().classAt(p, 2) ?? '')).length;
    expect(trunkish / Math.max(1, r.path.length - 2)).toBeGreaterThan(0.5);
  });
});
