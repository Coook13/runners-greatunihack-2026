// Pure motion maths for the carrier models: no three.js, no DOM, unit-tested in node.
// createMotionSmoother turns 2-4 Hz sim positions into smooth 60 fps motion, scaleForDistance keeps
// models readable from far away, and a few spring/angle helpers are shared by every model.

export const TAU = Math.PI * 2;

/** Signed shortest angle from a to b, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Frame-rate independent smoothing factor (exponential approach). */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** One step of a critically damped spring. Returns [position, velocity]. Stable for any dt. */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const e = Math.exp(-omega * dt);
  const d = x - target;
  const tmp = (v + omega * d) * dt;
  return [target + (d + tmp) * e, (v - omega * tmp) * e];
}

// ---------- motion smoother ----------
export interface MotionSmootherOptions {
  delayTicks?: number;      // play this many sample intervals behind the newest sample (default 1.5)
  teleportDist?: number;    // a jump bigger than this (world units) snaps instead of gliding (default 3000)
  maxSamples?: number;      // samples kept (default 8)
  posOmega?: number;        // how fast a curve reshape (late sample) fades out, 1/s wall time, 0 = off (default 10)
  headingRate?: number;     // heading smoothing, 1/s wall time (default 8)
  minSpeed?: number;        // below this speed (units per sim second) the heading holds (default 0.4)
}

export interface MotionState {
  x: number; y: number; z: number;  // smoothed position (z = altitude channel, optional)
  heading: number;                   // radians, 0 = +x (east), counter-clockwise
  speed: number;                     // units per SIM second (real m/s when fed world metres)
  turnRate: number;                  // rad per sim second, + = turning left (counter-clockwise)
  accel: number;                     // along-track acceleration, units per sim second^2
  vz: number;                        // altitude rate, units per sim second
  simT: number;                      // sim time being shown
  moving: boolean;
}

export interface MotionSmoother {
  /** Feed one sim sample. simT = sim seconds, wallT = wall seconds when it arrived. */
  push(simT: number, wallT: number, x: number, y: number, z?: number, heading?: number): void;
  /** Smoothed state at a wall time (call once per frame). Returns a reused object. */
  sample(wallT: number): Readonly<MotionState>;
  /** Jump straight to a position (spawn, reset). */
  snap(x: number, y: number, z?: number, heading?: number): void;
  readonly state: Readonly<MotionState>;
}

interface Sample { t: number; x: number; y: number; z: number; h: number | undefined }

/** Tangent at a knot from its two neighbouring secants: Catmull-Rom average, limited so the
 *  curve never overshoots a stop or doubles back (a 2D version of the Fritsch-Carlson rule). */
function knotTangent(prev: Sample | null, cur: Sample, next: Sample | null, out: number[]): void {
  let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, la = -1, lb = -1;
  if (prev) { const h = cur.t - prev.t; ax = (cur.x - prev.x) / h; ay = (cur.y - prev.y) / h; az = (cur.z - prev.z) / h; la = Math.hypot(ax, ay); }
  if (next) { const h = next.t - cur.t; bx = (next.x - cur.x) / h; by = (next.y - cur.y) / h; bz = (next.z - cur.z) / h; lb = Math.hypot(bx, by); }
  if (la < 0) { out[0] = bx; out[1] = by; out[2] = bz; return; }
  if (lb < 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  let tx = (ax + bx) / 2, ty = (ay + by) / 2;
  if (ax * bx + ay * by < 0) { tx = 0; ty = 0; }      // reversing: stop at the knot instead of looping
  const lt = Math.hypot(tx, ty), cap = 3 * Math.min(la, lb);
  if (lt > cap) { const k = cap / lt; tx *= k; ty *= k; }
  out[0] = tx; out[1] = ty;
  // altitude: classic 1D monotone rule
  out[2] = az * bz <= 0 ? 0 : clamp((az + bz) / 2, -3 * Math.min(Math.abs(az), Math.abs(bz)), 3 * Math.min(Math.abs(az), Math.abs(bz)));
}

export function createMotionSmoother(o: MotionSmootherOptions = {}): MotionSmoother {
  const delayTicks = o.delayTicks ?? 1.5;
  const teleport = o.teleportDist ?? 3000;
  const maxSamples = Math.max(4, o.maxSamples ?? 8);
  const posOmega = o.posOmega ?? 10;
  const headingRate = o.headingRate ?? 8;
  const minSpeed = o.minSpeed ?? 0.4;

  const buf: Sample[] = [];
  let interval = 0.5;            // sim seconds between samples (EMA)
  let rate = 1;                  // sim seconds per wall second (EMA)
  let rateKnown = false;
  let lastPushWall = NaN;
  let playhead = 0;
  let lastWall = NaN;
  let snapNext = true;
  // fading offset that hides curve reshapes, and smoothed derivatives
  let offX = 0, offY = 0, offZ = 0, lastPX = 0, lastPY = 0, lastPZ = 0;
  let turnS = 0, accS = 0;
  const m0 = [0, 0, 0], m1 = [0, 0, 0];
  const st: MotionState = { x: 0, y: 0, z: 0, heading: 0, speed: 0, turnRate: 0, accel: 0, vz: 0, simT: 0, moving: false };

  function snap(x: number, y: number, z = 0, heading?: number): void {
    buf.length = 0;
    st.x = x; st.y = y; st.z = z;
    offX = offY = offZ = 0;
    st.speed = 0; st.turnRate = 0; st.accel = 0; st.vz = 0; st.moving = false;
    turnS = accS = 0;
    if (heading !== undefined) st.heading = heading;
    snapNext = true;
  }

  function push(simT: number, wallT: number, x: number, y: number, z = 0, heading?: number): void {
    const last = buf[buf.length - 1];
    if (last) {
      if (simT < last.t - 1e-6) { snap(x, y, z, heading); }             // sim reset: time went backwards
      else if (Math.hypot(x - last.x, y - last.y) > teleport) { snap(x, y, z, heading); }
      else if (simT - last.t < 1e-6) { last.x = x; last.y = y; last.z = z; last.h = heading; return; }
      else {
        const dSim = simT - last.t;
        interval += (Math.min(dSim, 30) - interval) * 0.25;
        const dWall = wallT - lastPushWall;
        if (dWall > 1e-4 && dWall < 1.0) {                                // ignore pauses
          const inst = dSim / dWall;
          rate = rateKnown ? rate + (inst - rate) * 0.25 : inst;
          rateKnown = true;
        }
      }
    }
    buf.push({ t: simT, x, y, z, h: heading });
    if (buf.length > maxSamples) buf.shift();
    lastPushWall = wallT;
    if (buf.length === 1) {
      playhead = simT;
      if (snapNext) { st.x = x; st.y = y; st.z = z; if (heading !== undefined) st.heading = heading; }
    }
  }

  // evaluate the cubic Hermite through the buffer at sim time t (position, velocity, acceleration)
  const ev = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, h: undefined as number | undefined };
  function evalAt(t: number): typeof ev {
    const n = buf.length;
    if (n === 1) {
      ev.x = buf[0].x; ev.y = buf[0].y; ev.z = buf[0].z; ev.vx = ev.vy = ev.vz = ev.ax = ev.ay = 0; ev.h = buf[0].h;
      return ev;
    }
    let i = 0;
    while (i < n - 2 && buf[i + 1].t < t) i++;
    const a = buf[i], b = buf[i + 1];
    knotTangent(i > 0 ? buf[i - 1] : null, a, b, m0);
    knotTangent(a, b, i + 2 < n ? buf[i + 2] : null, m1);
    const h = b.t - a.t;
    const s = clamp((t - a.t) / h, 0, 1), s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d00 = 6 * s2 - 6 * s, d10 = 3 * s2 - 4 * s + 1, d01 = -6 * s2 + 6 * s, d11 = 3 * s2 - 2 * s;
    const e00 = 12 * s - 6, e10 = 6 * s - 4, e01 = -12 * s + 6, e11 = 6 * s - 2;
    ev.x = h00 * a.x + h10 * h * m0[0] + h01 * b.x + h11 * h * m1[0];
    ev.y = h00 * a.y + h10 * h * m0[1] + h01 * b.y + h11 * h * m1[1];
    ev.z = h00 * a.z + h10 * h * m0[2] + h01 * b.z + h11 * h * m1[2];
    ev.vx = (d00 * a.x + d10 * h * m0[0] + d01 * b.x + d11 * h * m1[0]) / h;
    ev.vy = (d00 * a.y + d10 * h * m0[1] + d01 * b.y + d11 * h * m1[1]) / h;
    ev.vz = (d00 * a.z + d10 * h * m0[2] + d01 * b.z + d11 * h * m1[2]) / h;
    ev.ax = (e00 * a.x + e10 * h * m0[0] + e01 * b.x + e11 * h * m1[0]) / (h * h);
    ev.ay = (e00 * a.y + e10 * h * m0[1] + e01 * b.y + e11 * h * m1[1]) / (h * h);
    ev.h = a.h !== undefined && b.h !== undefined ? a.h + angleDiff(a.h, b.h) * s : (b.h ?? a.h);
    return ev;
  }

  function sample(wallT: number): Readonly<MotionState> {
    const dtw = Number.isNaN(lastWall) ? 0 : clamp(wallT - lastWall, 0, 0.25);
    lastWall = wallT;
    const n = buf.length;
    if (n === 0) return st;
    const newest = buf[n - 1].t, oldest = buf[0].t;
    const delay = Math.max(1e-3, delayTicks * interval);
    const prevHead = playhead;
    // the playhead never runs backwards: it speeds up or slows down to hold `delay` behind the newest sample
    // where the sim is "now" (newest sample plus the time since it arrived), minus the delay
    const simNow = newest + clamp(wallT - lastPushWall, 0, 2 * interval / Math.max(rate, 1e-6)) * rate;
    const err = simNow - delay - playhead;
    if (err > Math.max(2 * delay, 4 * interval)) playhead = newest - delay;   // far behind (after a pause): jump forward
    else playhead += dtw * rate * clamp(1 + (0.6 * err) / delay, 0.15, 2.5);
    playhead = clamp(playhead, Math.max(oldest, Math.min(prevHead, newest)), newest);
    st.simT = playhead;

    // a late sample can reshape the curve under the playhead: carry that jump as an offset that fades out
    if (!snapNext && posOmega > 0 && n > 1) {
      evalAt(prevHead);
      offX += lastPX - ev.x; offY += lastPY - ev.y; offZ += lastPZ - ev.z;
      const k = Math.exp(-posOmega * dtw);
      offX *= k; offY *= k; offZ *= k;
    } else { offX = offY = offZ = 0; }
    snapNext = false;
    const e = evalAt(playhead);
    lastPX = e.x; lastPY = e.y; lastPZ = e.z;
    st.x = e.x + offX; st.y = e.y + offY; st.z = e.z + offZ;

    const { vx, vy, vz, ax, ay } = e;
    const speed = Math.hypot(vx, vy);
    st.speed = speed;
    st.vz = vz;
    st.moving = speed > minSpeed;
    // heading: follow the curve when moving, the sim's own heading (if any) when stopped
    let want: number | undefined;
    if (speed > minSpeed) want = Math.atan2(vy, vx);
    else if (e.h !== undefined) want = e.h;
    if (want !== undefined) {
      const k = dtw === 0 ? 1 : damp(Math.max(headingRate, rate * 3), dtw);
      st.heading += angleDiff(st.heading, want) * k;
      st.heading = Math.atan2(Math.sin(st.heading), Math.cos(st.heading));
    }
    // curvature-based turn rate and along-track accel, in sim time (physically meaningful at any sim speed)
    const turn = speed > minSpeed ? (vx * ay - vy * ax) / (speed * speed) : 0;
    const acc = speed > 1e-6 ? (vx * ax + vy * ay) / speed : 0;
    const kk = damp(6, dtw);
    turnS += (clamp(turn, -3, 3) - turnS) * kk;
    accS += (clamp(acc, -30, 30) - accS) * kk;
    st.turnRate = turnS;
    st.accel = accS;
    return st;
  }

  return { push, sample, snap, get state() { return st; } };
}

// ---------- readable-size scaling ----------
export type ModelKind = 'drone' | 'motorbike' | 'van' | 'boat' | 'crate';

/** Real size of each model's longest dimension, metres. */
export const MODEL_LENGTH_M: Record<ModelKind, number> = { drone: 3.4, motorbike: 2.0, van: 5.4, boat: 5.6, crate: 0.4 };
/** Smallest on-screen size (pixels, longest dimension) each model keeps however far the camera is. */
export const MIN_SCREEN_PX: Record<ModelKind, number> = { drone: 30, motorbike: 20, van: 28, boat: 28, crate: 9 };

export interface ScaleOptions {
  unitsPerMetre?: number;   // scene units per metre (default 1)
  fovDeg?: number;          // vertical field of view (default 42)
  viewportPx?: number;      // canvas height in CSS px (default 900)
  minPx?: number;           // override MIN_SCREEN_PX
}

/**
 * Display multiplier for a model so it never shrinks below a minimum on-screen size.
 * 1 = true size (close up); grows linearly with distance once true size would be too small.
 * The blend is smooth (no kink at the crossover). cameraDistance is in scene units.
 */
export function scaleForDistance(cameraDistance: number, kind: ModelKind = 'van', o: ScaleOptions = {}): number {
  const upm = o.unitsPerMetre ?? 1;
  const fov = ((o.fovDeg ?? 42) * Math.PI) / 180;
  const vp = o.viewportPx ?? 900;
  const minPx = o.minPx ?? MIN_SCREEN_PX[kind];
  const lenUnits = MODEL_LENGTH_M[kind] * upm;
  const pxAtTrueSize = (lenUnits / (2 * Math.max(1e-6, cameraDistance) * Math.tan(fov / 2))) * vp;
  const need = minPx / Math.max(1e-9, pxAtTrueSize);
  return Math.sqrt(1 + need * need);
}

/** Visual altitude multiplier for a display scale: grows slower than the model so a scaled-up
 *  drone still sits visibly above its ground point without drifting far off its track. */
export const altitudeScale = (displayScale: number): number => Math.sqrt(Math.max(1, displayScale));
