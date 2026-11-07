// Pure smoothing maths for the carrier models (no WebGL here).
import { describe, expect, it } from 'vitest';
import { angleDiff, createMotionSmoother, scaleForDistance, springStep } from '../src/render/models/motion';

/** Drive a smoother: sim ticks every `tick` sim seconds, `rate` sim seconds per wall second, sampled at 60 fps. */
function run(pos: (t: number) => [number, number], opts: { tick?: number; rate?: number; wallSec?: number; jitter?: number } = {}) {
  const tick = opts.tick ?? 0.5, rate = opts.rate ?? 1, wallSec = opts.wallSec ?? 12;
  const sm = createMotionSmoother();
  const out: { x: number; y: number; heading: number; speed: number; turn: number; wall: number }[] = [];
  let nextTick = 0, seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let f = 0; f <= wallSec * 60; f++) {
    const wall = f / 60;
    while (nextTick / rate <= wall) {
      const [x, y] = pos(nextTick);
      const late = opts.jitter ? rnd() * opts.jitter * (tick / rate) : 0;
      sm.push(nextTick, wall + late, x, y);
      nextTick += tick;
    }
    const s = sm.sample(wall);
    out.push({ x: s.x, y: s.y, heading: s.heading, speed: s.speed, turn: s.turnRate, wall });
  }
  return out;
}

describe('createMotionSmoother', () => {
  it('turns a 2 Hz straight line into steady 60 fps motion at the right speed', () => {
    const v = 9;
    const out = run((t) => [v * t, 0]).slice(180);       // skip the first 3 s warm-up
    for (let i = 1; i < out.length; i++) {
      const step = out[i].x - out[i - 1].x;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan((v / 60) * 1.15);
      expect(Math.abs(out[i].y)).toBeLessThan(1e-6);
    }
    const mid = out[out.length >> 1];
    expect(mid.speed).toBeCloseTo(v, 0);
    expect(Math.abs(mid.heading)).toBeLessThan(1e-3);
  });

  it('stops without overshooting or flipping heading', () => {
    const out = run((t) => [Math.min(t, 5) * 12, 0], { wallSec: 10 });
    let maxX = -Infinity;
    for (let i = 1; i < out.length; i++) {
      expect(out[i].x).toBeGreaterThanOrEqual(out[i - 1].x - 1e-6);   // never backs up
      maxX = Math.max(maxX, out[i].x);
      expect(Math.abs(out[i].heading)).toBeLessThan(0.05);
    }
    expect(maxX).toBeLessThanOrEqual(60 + 1e-6);
    expect(out[out.length - 1].speed).toBeLessThan(0.05);
    expect(out[out.length - 1].x).toBeCloseTo(60, 1);
  });

  it('rounds a 90 degree turn smoothly with a left (positive) turn rate', () => {
    const out = run((t) => (t < 4 ? [t * 10, 0] : [40, (t - 4) * 10]), { wallSec: 9 });
    let prev = out[0].heading, sawPositiveTurn = false;
    for (const o of out.slice(1)) {
      expect(angleDiff(prev, o.heading)).toBeGreaterThanOrEqual(-0.02);  // swings left; under 1 degree of wobble
      expect(Math.abs(angleDiff(prev, o.heading))).toBeLessThan(0.25);   // no snaps
      if (o.turn > 0.05) sawPositiveTurn = true;
      prev = o.heading;
    }
    expect(sawPositiveTurn).toBe(true);
    expect(out[out.length - 1].heading).toBeCloseTo(Math.PI / 2, 1);
  });

  it('keeps sim-time speed at 60x sim speed and stays continuous', () => {
    const v = 25;
    const out = run((t) => [v * t, 0], { rate: 60, wallSec: 6 }).slice(120);
    const mid = out[out.length >> 1];
    expect(mid.speed).toBeCloseTo(v, 0);                  // speed is per SIM second, not per wall second
    for (let i = 1; i < out.length; i++) expect(out[i].x - out[i - 1].x).toBeLessThan((v * 60 / 60) * 1.25);
  });

  it('tolerates jittery arrival times without jerks', () => {
    const v = 12;
    const out = run((t) => [v * t, 3 * Math.sin(t / 4)], { jitter: 0.6, wallSec: 15 }).slice(240);
    const steps = out.slice(1).map((o, i) => Math.hypot(o.x - out[i].x, o.y - out[i].y));
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    for (const s of steps) expect(s).toBeLessThan(mean * 2.2);
  });

  it('snaps on a teleport and on a sim reset', () => {
    const sm = createMotionSmoother({ teleportDist: 1000 });
    for (let i = 0; i < 6; i++) { sm.push(i * 0.5, i * 0.5, i * 5, 0); sm.sample(i * 0.5); }
    sm.push(3, 3, 9000, 9000);
    let s = sm.sample(3.02);
    expect(s.x).toBeCloseTo(9000);
    expect(s.y).toBeCloseTo(9000);
    sm.push(0, 3.1, 10, 10);                               // time went backwards
    s = sm.sample(3.12);
    expect(s.x).toBeCloseTo(10);
  });

  it('holds the sim heading when parked and wraps across +-PI cleanly', () => {
    const sm = createMotionSmoother();
    for (let i = 0; i < 10; i++) { sm.push(i * 0.5, i * 0.5, 0, 0, 0, 2.5); sm.sample(i * 0.5); }
    expect(sm.sample(5).heading).toBeCloseTo(2.5, 1);
    const out = run((t) => [-10 * t, 0.001 * Math.sin(t * 7)]).slice(200);    // due west: heading near +-PI
    for (let i = 1; i < out.length; i++) expect(Math.abs(angleDiff(out[i - 1].heading, out[i].heading))).toBeLessThan(0.02);
  });

  it('smooths the altitude channel monotonically on a climb', () => {
    const sm = createMotionSmoother();
    let prevZ = -1;
    for (let f = 0; f < 600; f++) {
      const wall = f / 60;
      if (f % 30 === 0) { const t = wall; sm.push(t, wall, 0, 0, Math.min(120, t * 15)); }
      const z = sm.sample(wall).z;
      expect(z).toBeGreaterThanOrEqual(prevZ - 1e-6);
      prevZ = z;
    }
    expect(prevZ).toBeGreaterThan(100);
  });
});

describe('springStep and scaleForDistance', () => {
  it('critically damped spring settles without overshoot', () => {
    let x = 0, v = 0, max = 0;
    for (let i = 0; i < 300; i++) { [x, v] = springStep(x, v, 1, 8, 1 / 60); max = Math.max(max, x); }
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    expect(x).toBeCloseTo(1, 4);
  });

  it('is true size up close and holds a minimum on-screen size far away', () => {
    expect(scaleForDistance(10, 'van')).toBeCloseTo(1, 2);
    const far = 40000, k = scaleForDistance(far, 'van', { viewportPx: 900, fovDeg: 42 });
    const px = ((5.4 * k) / (2 * far * Math.tan((21 * Math.PI) / 180))) * 900;
    expect(px).toBeGreaterThanOrEqual(28 - 1e-6);
    let prev = 0;
    for (const d of [5, 50, 500, 5000, 50000]) { const s = scaleForDistance(d, 'drone'); expect(s).toBeGreaterThanOrEqual(prev); prev = s; }
    // scene units: 1 unit = 100 m gives the same answer as metres at 100x the distance
    expect(scaleForDistance(300, 'boat', { unitsPerMetre: 0.01 })).toBeCloseTo(scaleForDistance(30000, 'boat'), 6);
  });
});
