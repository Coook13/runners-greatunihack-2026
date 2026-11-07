// Pure camera-path maths for the intro fly-in (src/intro/path.ts). No WebGL here.
import { describe, expect, it } from 'vitest';
import {
  CAPTIONS, EARTH_R, MAIN_SCENE_CAMERA, ORIGIN, buildIntroPath, captionAt, clipPlanes, dot, enuAt, geoToWorld,
  hazeRange, len, makeTrack, norm, orbitFromCamera, poseFromOrbit, smoothstep, sub, worldToGeo, type LayerWeights,
} from '../src/intro/path';

const N = 1200;
const us = Array.from({ length: N + 1 }, (_, i) => i / N);

describe('makeTrack (monotone cubic)', () => {
  const keys: [number, number][] = [[0, 10], [0.2, 8], [0.5, 3], [0.6, 2.9], [1, 0]];
  const tr = makeTrack(keys);
  it('passes through every key and clamps outside', () => {
    for (const [x, y] of keys) expect(tr.at(x)).toBeCloseTo(y, 10);
    expect(tr.at(-1)).toBe(10);
    expect(tr.at(2)).toBe(0);
  });
  it('stays monotone and never overshoots monotone keys', () => {
    let prev = Infinity;
    for (const u of us) {
      const v = tr.at(u);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      expect(v).toBeLessThanOrEqual(10 + 1e-12);
      expect(v).toBeGreaterThanOrEqual(-1e-12);
      prev = v;
    }
  });
  it('eases in and out (zero end slopes) and has a continuous slope', () => {
    expect(tr.slope(0)).toBeCloseTo(0, 10);
    expect(tr.slope(1)).toBeCloseTo(0, 10);
    for (const [x] of keys.slice(1, -1)) expect(tr.slope(x - 1e-7)).toBeCloseTo(tr.slope(x + 1e-7), 3);
  });
  it('does not overshoot a local extremum', () => {
    const bump = makeTrack([[0, 0], [0.5, 1], [1, 0]]);
    for (const u of us) expect(bump.at(u)).toBeLessThanOrEqual(1 + 1e-12);
  });
});

describe('geo frame', () => {
  it('puts the Hawassa tile centre at the origin with east = +x, north = -z, up = +y', () => {
    const o = geoToWorld(ORIGIN.lat, ORIGIN.lon);
    for (const c of o) expect(Math.abs(c)).toBeLessThan(1e-6);
    const { e, n, u } = enuAt(ORIGIN.lat, ORIGIN.lon);
    expect(e[0]).toBeCloseTo(1, 9);
    expect(n[2]).toBeCloseTo(-1, 9);
    expect(u[1]).toBeCloseTo(1, 9);
  });
  it('uses the main map scale: 1 unit = 100 m', () => {
    const north = geoToWorld(ORIGIN.lat + 1, ORIGIN.lon);
    expect(-north[2]).toBeCloseTo((EARTH_R * Math.PI) / 180, -1);   // about 1112 units = 111 km
  });
  it('round-trips world <-> geo', () => {
    for (const [lat, lon] of [[9.03, 38.74], [-30, 10], [45, 120], [7.05, 38.48]]) {
      const g = worldToGeo(geoToWorld(lat, lon, 12));
      expect(g.lat).toBeCloseTo(lat, 8);
      expect(g.lon).toBeCloseTo(lon, 8);
      expect(g.alt).toBeCloseTo(12, 5);
    }
  });
});

describe('end pose = main map camera', () => {
  it('reads the main camera back into orbit parameters', () => {
    const o = orbitFromCamera(MAIN_SCENE_CAMERA);
    expect(o.range).toBeCloseTo(Math.hypot(40, 250, 290), 6);
    expect(o.tilt).toBeCloseTo(Math.acos(250 / o.range), 9);
    expect(o.heading).toBeCloseTo(Math.atan2(-40, 290), 9);
  });
  it('lands exactly on the main camera at u = 1', () => {
    const f = buildIntroPath().at(1);
    for (let i = 0; i < 3; i++) {
      expect(f.position[i]).toBeCloseTo(MAIN_SCENE_CAMERA.position[i], 6);
      expect(f.target[i]).toBeCloseTo(MAIN_SCENE_CAMERA.target[i], 6);
    }
    expect(f.fov).toBe(MAIN_SCENE_CAMERA.fov);
    expect(Math.abs(f.roll)).toBeLessThan(1e-9);
    // screen-up lies in the vertical plane through the view, pointing up: same basis as lookAt with up = +y
    const view = norm(sub(f.target, f.position));
    expect(dot(f.up, view)).toBeCloseTo(0, 6);
    expect(f.up[1]).toBeGreaterThan(0);
    expect(dot(f.up, norm([view[2], 0, -view[0]]))).toBeCloseTo(0, 6);
  });
  it('lands on a custom end camera too', () => {
    const cam = { position: [-60, 320, 180] as [number, number, number], target: [20, 0, -15] as [number, number, number], fov: 45 };
    const f = buildIntroPath(cam).at(1);
    for (let i = 0; i < 3; i++) expect(f.position[i]).toBeCloseTo(cam.position[i], 6);
  });
});

describe('the flight', () => {
  const path = buildIntroPath();
  const frames = us.map((u) => path.at(u));
  it('starts in orbit, far enough to see the whole globe', () => {
    expect(frames[0].alt).toBeGreaterThan(2 * EARTH_R);
    expect(frames[0].tilt).toBe(0);
  });
  it('descends monotonically with a log-scale ease and no zoom jumps', () => {
    let maxStep = 0;
    for (let i = 1; i <= N; i++) {
      expect(frames[i].range).toBeLessThanOrEqual(frames[i - 1].range + 1e-9);
      maxStep = Math.max(maxStep, Math.log(frames[i - 1].range / frames[i].range));
    }
    expect(maxStep).toBeLessThan(0.03);        // under 3% zoom per 1/1200 of the flight
  });
  it('keeps the camera above ground and the view pointing at the target', () => {
    for (const f of frames) {
      expect(f.alt).toBeGreaterThan(100);
      const view = sub(f.target, f.position);
      expect(Math.abs(dot(norm(view), f.up))).toBeLessThan(1e-9);
      expect(len(view)).toBeGreaterThan(300);
    }
  });
  it('banks only slightly and is level at both ends', () => {
    for (const f of frames) expect(Math.abs(f.roll)).toBeLessThanOrEqual(0.04);
    expect(frames[0].roll).toBe(0);
  });
  it('cross-fades every layer smoothly (no popping)', () => {
    const keys = Object.keys(frames[0].weights) as (keyof LayerWeights)[];
    for (const k of keys) {
      let maxStep = 0;
      for (let i = 1; i <= N; i++) maxStep = Math.max(maxStep, Math.abs(frames[i].weights[k] - frames[i - 1].weights[k]));
      expect(maxStep, k).toBeLessThan(0.03);
    }
  });
  it('shows the detail tiles in order: country, then region, then district', () => {
    const firstFull = (k: keyof LayerWeights) => frames.findIndex((f) => f.weights[k] >= 0.999);
    expect(firstFull('ethiopia')).toBeGreaterThan(0);
    expect(firstFull('region')).toBeGreaterThan(firstFull('ethiopia'));
    expect(firstFull('hawassa')).toBeGreaterThan(firstFull('region'));
    const last = frames[N].weights;
    expect(last.hawassa).toBe(1);
    expect(last.marker).toBe(0);
    expect(last.beyond).toBe(1);
    expect(last.vignette).toBe(0);
  });
  it('ends with the main map fog values', () => {
    const [near, far] = hazeRange(frames[N].range, path.end.range);
    expect(near).toBeCloseTo(380, 6);
    expect(far).toBeCloseTo(1150, 6);
  });
  it('keeps clip planes sane at both ends', () => {
    const [n0, f0] = clipPlanes(frames[0].alt);
    expect(f0).toBeGreaterThan(frames[0].range);
    expect(n0).toBeLessThan(frames[0].alt);
    const [n1, f1] = clipPlanes(frames[N].alt);
    expect(n1).toBeLessThan(250);
    expect(f1).toBeGreaterThan(1000);
  });
});

describe('captions', () => {
  it('play Ethiopia, Sidama Region, Hawassa once each, in order, and clear at the ends', () => {
    const seq: string[] = [];
    for (const u of us) { const c = captionAt(u); if (c && c !== seq[seq.length - 1]) seq.push(c); }
    expect(seq).toEqual(CAPTIONS.map((c) => c.text));
    expect(seq[2]).toBe('Hawassa: Lake Hawassa and the villages around it');
    expect(captionAt(0)).toBe('');
    expect(captionAt(1)).toBe('');
  });
});

describe('easing helpers', () => {
  it('smoothstep clamps and supports falling ramps', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(10, 0, 2)).toBeCloseTo(1 - smoothstep(0, 10, 2), 12);
  });
  it('poseFromOrbit straight down looks at the ground with heading as screen-up', () => {
    const p = poseFromOrbit({ lat: ORIGIN.lat, lon: ORIGIN.lon, alt: 0, range: 500, tilt: 0, heading: 0, roll: 0 });
    expect(p.position[1]).toBeCloseTo(500, 6);
    expect(p.up[2]).toBeCloseTo(-1, 6);         // north is up on screen
  });
});
