import { describe, expect, it } from 'vitest';
import {
  apronY, clampToRect, densifyXY, distToDistrict, feather, fitDistance, imagePlane, smoothstep, viewCurves, worldToUV, zoomBlend,
} from '../src/render/country';

const UPM = 0.01;                                      // scene units per metre (SCENE_SIZE 400 / WORLD_SIZE 40000)
const toScene = (x: number, y: number) => ({ x: (x - 20000) * UPM, y: 0, z: -(y - 20000) * UPM });
const DS = 400;                                        // district side, scene units

describe('country layer maths', () => {
  it('smoothstep clamps and eases', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
  });

  it('LOD blend is 0 at district zoom, 1 at country zoom, monotonic', () => {
    expect(zoomBlend(620, DS)).toBe(0);                 // default district framing
    expect(zoomBlend(19000, DS)).toBe(1);               // whole country
    let prev = -1;
    for (let d = 100; d < 30000; d *= 1.2) { const b = zoomBlend(d, DS); expect(b).toBeGreaterThanOrEqual(prev); prev = b; }
  });

  it('fog: district stays clear, haze before the horizon, country zoom pushes fog past everything', () => {
    const span = 21600;
    const district = viewCurves(620, DS, span);
    expect(district.fogNear).toBeGreaterThan(620 + DS / 2); // the whole district is in front of the haze
    expect(district.fogFar).toBeLessThan(10000);        // the haze is thick well before the country plane edge
    const country = viewCurves(19000, DS, span);
    expect(country.fogNear).toBeGreaterThan(19000 + span); // no haze anywhere on the country
    // monotonic in distance
    let p = viewCurves(1, DS, span);
    for (let d = 2; d < 30000; d *= 1.3) {
      const v = viewCurves(d, DS, span);
      expect(v.fogNear).toBeGreaterThanOrEqual(p.fogNear);
      expect(v.fogFar).toBeGreaterThan(v.fogNear);
      p = v;
    }
  });

  it('far plane always reaches the far corner of the country image; near plane keeps close-ups', () => {
    const span = 21600;
    for (const d of [1, 50, 620, 3000, 19000]) {
      const v = viewCurves(d, DS, span);
      expect(v.far).toBeGreaterThan(d + span);
      expect(v.near).toBeLessThan(d * 0.05 + 0.03);     // nothing on the ground is that close to the camera
    }
    expect(viewCurves(1, DS, span).near).toBeCloseTo(0.02);
    expect(viewCurves(620, DS, span).near).toBeCloseTo(6.2);
  });

  it('fitDistance fits the tighter of width and height', () => {
    const t = Math.tan((42 * Math.PI) / 360);
    expect(fitDistance(100, 50, 42, 1)).toBeCloseTo(100 / t);
    expect(fitDistance(100, 50, 42, 4)).toBeCloseTo(50 / t);
  });

  it('image planes land where the image corners are, north = -z', () => {
    const img = { x0: -90592, x1: 130364, y0: -90671, y1: 130477 };   // region-sat.jpg bounds
    const p = imagePlane(img, toScene);
    expect(p.w).toBeCloseTo((img.x1 - img.x0) * UPM);
    expect(p.h).toBeCloseTo((img.y1 - img.y0) * UPM);
    expect(p.cx).toBeCloseTo(((img.x0 + img.x1) / 2 - 20000) * UPM);
    expect(p.cz).toBeCloseTo(-((img.y0 + img.y1) / 2 - 20000) * UPM);
    // UV: west/south corner (0, 0), east/north (1, 1)
    expect(worldToUV(img, img.x0, img.y0)).toEqual([0, 0]);
    expect(worldToUV(img, img.x1, img.y1)).toEqual([1, 1]);
  });

  it('feather is 1 in the middle and 0 on every edge', () => {
    expect(feather(0.5, 0.5, 0.1)).toBe(1);
    expect(feather(0, 0.5, 0.1)).toBe(0);
    expect(feather(0.5, 1, 0.1)).toBe(0);
    expect(feather(0.05, 0.5, 0.1)).toBeCloseTo(0.5);
  });

  it('apron eases from the district edge to the plane', () => {
    expect(distToDistrict(100, 100, 40000)).toBe(0);
    expect(distToDistrict(-300, 40400, 40000)).toBeCloseTo(500);
    expect(apronY(0, 6000, 12, 5)).toBe(12);
    expect(apronY(6000, 6000, 12, 5)).toBe(5);
    expect(apronY(9000, 6000, 12, 5)).toBe(5);
    const mid = apronY(3000, 6000, 12, 5);
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(12);
  });

  it('pan clamp and densify', () => {
    expect(clampToRect(50, -50, { minX: -10, maxX: 10, minZ: -20, maxZ: 20 })).toEqual([10, -20]);
    const d = densifyXY([[0, 0], [1000, 0]], 300);
    expect(d.length).toBe(5);
    expect(d[d.length - 1]).toEqual([1000, 0]);
  });
});
