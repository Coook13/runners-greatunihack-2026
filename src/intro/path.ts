// Pure maths for the opening fly-in: geo <-> world frame, monotone spline tracks, the camera path,
// layer cross-fade weights and caption timing. No three.js and no DOM, so it is unit-tested in node.
//
// World frame: identical to the main map (src/render). 1 unit = 100 m, the centre of the Hawassa tile
// sits at the origin, +x is east, -z is north, +y is up. The Earth is a sphere of EARTH_R units whose
// centre is at (0, -EARTH_R, 0), so the globe touches the main map's ground plane at the origin.

export type V3 = [number, number, number];
export interface Bounds { south: number; west: number; north: number; east: number }
export interface Geo { lat: number; lon: number }

/** Tile bounds, mirrored from public/geo/tiles.json (each image is lat/lon-linear inside its box). */
export const GEO_BOUNDS: { ethiopia: Bounds; region: Bounds; hawassa: Bounds } = {
  ethiopia: { south: 3.2, west: 32.8, north: 15.2, east: 48.2 },
  region: { south: 6.05, west: 37.48, north: 8.05, east: 39.48 },
  hawassa: { south: 6.87, west: 38.3, north: 7.23, east: 38.66 },
};

export const EARTH_R = 63710;                 // 6371 km in scene units
export const MAP_SIZE = 400;                  // main map: the Hawassa tile spans 400 x 400 units
export const ORIGIN: Geo = centreOf(GEO_BOUNDS.hawassa);
export const GLOBE_CENTER: V3 = [0, -EARTH_R, 0];
export const HAWASSA_CITY: Geo = { lat: 7.05, lon: 38.48 };
export const ADDIS_ABABA: Geo = { lat: 9.03, lon: 38.74 };
/** Where the sun is overhead: north-east of Ethiopia, so the country is fully lit and the far globe falls into dusk. */
export const SUBSOLAR: Geo = { lat: 12, lon: 50 };

export interface CameraSpec { position: V3; target: V3; fov: number }
/** The main map's opening camera (src/render/scene.ts): the intro's last frame matches it exactly. */
export const MAIN_SCENE_CAMERA: CameraSpec = { position: [40, 250, 300], target: [0, 0, 10], fov: 42 };
/** The main map's linear fog (scene.fog): the intro's haze lands on these values. */
export const MAIN_SCENE_FOG = { color: 0xead9bb, near: 380, far: 1150 };

// ---------- small vector helpers ----------
const D2R = Math.PI / 180;
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Hermite smoothstep; edge0 > edge1 gives a falling ramp. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function centreOf(b: Bounds): Geo {
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

// ---------- geo <-> world ----------
function ecef(lat: number, lon: number): V3 {
  const a = lat * D2R, b = lon * D2R;
  return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
}
const A0 = ORIGIN.lat * D2R, B0 = ORIGIN.lon * D2R;
const E0: V3 = [-Math.sin(B0), Math.cos(B0), 0];
const N0: V3 = [-Math.sin(A0) * Math.cos(B0), -Math.sin(A0) * Math.sin(B0), Math.cos(A0)];
const U0: V3 = ecef(ORIGIN.lat, ORIGIN.lon);
/** Earth-fixed direction -> world direction (east = +x, up = +y, north = -z at the origin). */
const toWorldDir = (v: V3): V3 => [dot(v, E0), dot(v, U0), -dot(v, N0)];

export function geoToWorld(lat: number, lon: number, alt = 0): V3 {
  const d = toWorldDir(ecef(lat, lon));
  const r = EARTH_R + alt;
  return [d[0] * r, d[1] * r - EARTH_R, d[2] * r];
}

export function worldToGeo(p: V3): Geo & { alt: number } {
  const rel = sub(p, GLOBE_CENTER);
  const r = len(rel);
  const w = scale(rel, 1 / r);
  const e: V3 = [E0[0] * w[0] + U0[0] * w[1] - N0[0] * w[2], E0[1] * w[0] + U0[1] * w[1] - N0[1] * w[2], E0[2] * w[0] + U0[2] * w[1] - N0[2] * w[2]];
  return { lat: Math.asin(Math.max(-1, Math.min(1, e[2]))) / D2R, lon: Math.atan2(e[1], e[0]) / D2R, alt: r - EARTH_R };
}

/** Unit up (outward) direction of the globe at a geo point, in world space. */
export const upAt = (lat: number, lon: number): V3 => toWorldDir(ecef(lat, lon));

/** Local east / north / up frame at a geo point, in world space. */
export function enuAt(lat: number, lon: number): { e: V3; n: V3; u: V3 } {
  const a = lat * D2R, b = lon * D2R;
  return {
    e: toWorldDir([-Math.sin(b), Math.cos(b), 0]),
    n: toWorldDir([-Math.sin(a) * Math.cos(b), -Math.sin(a) * Math.sin(b), Math.cos(a)]),
    u: toWorldDir(ecef(lat, lon)),
  };
}

/** Main-map scene (x, z) -> geo, using the same linear tile mapping the main map uses for its 400 x 400 ground. */
export function sceneToGeo(x: number, z: number, b: Bounds = GEO_BOUNDS.hawassa): Geo {
  const c = centreOf(b);
  return { lat: c.lat - (z / MAP_SIZE) * (b.north - b.south), lon: c.lon + (x / MAP_SIZE) * (b.east - b.west) };
}

// ---------- camera pose from orbit parameters ----------
/** Look-at orbit around a ground target: range (distance), tilt from straight down, heading of the view (0 = north), roll. */
export interface OrbitParams { lat: number; lon: number; alt: number; range: number; tilt: number; heading: number; roll: number }
export interface Pose { position: V3; target: V3; up: V3 }

export function poseFromOrbit(p: OrbitParams): Pose {
  const target = geoToWorld(p.lat, p.lon, p.alt);
  const { e, n, u } = enuAt(p.lat, p.lon);
  const ch = Math.cos(p.heading), sh = Math.sin(p.heading);
  const ct = Math.cos(p.tilt), st = Math.sin(p.tilt);
  const h: V3 = add(scale(n, ch), scale(e, sh));          // horizontal view direction
  const right: V3 = sub(scale(e, ch), scale(n, sh));
  const position = add(target, scale(sub(scale(u, ct), scale(h, st)), p.range));
  const up0: V3 = add(scale(h, ct), scale(u, st));        // screen-up, always perpendicular to the view
  const up = norm(add(scale(up0, Math.cos(p.roll)), scale(right, Math.sin(p.roll))));
  return { position, target, up };
}

/** Reads a main-map camera back into orbit parameters (inverse of poseFromOrbit at the map origin). */
export function orbitFromCamera(cam: CameraSpec): OrbitParams {
  const [tx, ty, tz] = cam.target;
  const g = sceneToGeo(tx, tz);
  const off = sub(cam.position, cam.target);
  const range = len(off);
  const tilt = Math.acos(Math.max(-1, Math.min(1, off[1] / range)));
  const horiz = Math.hypot(off[0], off[2]);
  const heading = horiz < 1e-9 ? 0 : Math.atan2(-off[0], off[2]);
  return { lat: g.lat, lon: g.lon, alt: ty, range, tilt, heading, roll: 0 };
}

// ---------- monotone cubic tracks (PCHIP) ----------
export interface Track { at(x: number): number; slope(x: number): number }

/**
 * Piecewise cubic Hermite through the keys, with Fritsch-Butland tangents: it never overshoots a key,
 * stays monotone wherever the keys are, and has a continuous first derivative (no velocity jumps).
 * End slopes default to 0, so the motion eases in and out.
 */
export function makeTrack(keys: [number, number][], startSlope = 0, endSlope = 0): Track {
  const n = keys.length;
  if (n < 2) throw new Error('makeTrack needs at least two keys');
  const xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
  for (let i = 1; i < n; i++) if (!(xs[i] > xs[i - 1])) throw new Error('makeTrack keys must have increasing x');
  const h: number[] = [], d: number[] = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  const m = new Array<number>(n).fill(0);
  m[0] = startSlope;
  m[n - 1] = endSlope;
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  // keep the given end slopes from breaking monotonicity in the first and last segments
  for (const [i, j] of [[0, 0], [n - 1, n - 2]] as const) {
    if (d[j] === 0 || m[i] * d[j] < 0) m[i] = 0;
    else if (Math.abs(m[i]) > 3 * Math.abs(d[j])) m[i] = 3 * d[j];
  }
  const seg = (x: number): number => {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    return i;
  };
  return {
    at(x) {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      const i = seg(x), t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
    },
    slope(x) {
      if (x < xs[0] || x > xs[n - 1]) return 0;
      const i = seg(Math.min(x, xs[n - 1])), t = (x - xs[i]) / h[i], t2 = t * t;
      return ((6 * t2 - 6 * t) * ys[i] + (3 * t2 - 4 * t + 1) * h[i] * m[i] + (-6 * t2 + 6 * t) * ys[i + 1] + (3 * t2 - 2 * t) * h[i] * m[i + 1]) / h[i];
    },
  };
}

// ---------- layer weights ----------
/** How visible each layer is, from 0 to 1. All are continuous in range and progress, so nothing pops. */
export interface LayerWeights {
  ethiopia: number;   // country satellite tile
  region: number;     // Sidama region tile
  hawassa: number;    // district tile (the main map's ground)
  dim: number;        // darken and desaturate everything outside Ethiopia
  border: number;     // glowing national border
  borderDraw: number; // 0..1 how much of the border has traced itself
  marker: number;     // pulsing Hawassa marker
  atmosphere: number; // blue limb glow on the globe
  beyond: number;     // end of flight: everything outside the map square fades into the main map's haze
  hazeWarm: number;   // 0 = high-altitude blue haze, 1 = the main map's warm fog colour
  feather: number;    // Hawassa tile edge softness (fraction of the tile); sharpens to the main map's hard edge
  vignette: number;
}

export function layerWeights(range: number, u: number, endRange: number): LayerWeights {
  const lr = Math.log(range);
  return {
    ethiopia: smoothstep(170000, 70000, range),
    region: smoothstep(14000, 6000, range),
    hawassa: smoothstep(1900, 900, range),
    dim: 0.55 * smoothstep(95000, 34000, range) * (1 - smoothstep(9000, 4200, range)),
    border: smoothstep(85000, 36000, range) * (1 - smoothstep(4800, 2700, range)),
    borderDraw: smootherstep(0.235, 0.37, u),
    marker: smoothstep(40000, 22000, range) * (1 - smoothstep(0.86, 0.975, u)),
    atmosphere: smoothstep(18000, 60000, range),
    beyond: smootherstep(0.83, 1, u),
    hazeWarm: smoothstep(Math.log(40000), Math.log(endRange * 4), lr),
    feather: lerp(0.05, 0.004, smootherstep(0.8, 1, u)),
    vignette: 1 - smootherstep(0.82, 1, u),
  };
}

// ---------- captions ----------
export interface CaptionCue { from: number; to: number; text: string }
/** Caption cues in normalised progress (0..1), so they scale with durationSec. */
export const CAPTIONS: CaptionCue[] = [
  { from: 0.26, to: 0.47, text: 'Ethiopia' },
  { from: 0.5, to: 0.69, text: 'Sidama Region' },
  { from: 0.72, to: 0.975, text: 'Hawassa: Lake Hawassa and the villages around it' },
];
export function captionAt(u: number): string {
  for (const c of CAPTIONS) if (u >= c.from && u < c.to) return c.text;
  return '';
}

// ---------- the path ----------
export interface IntroFrame extends Pose {
  u: number;
  fov: number;
  range: number;
  alt: number;        // camera height above the globe surface, units
  lat: number; lon: number;          // ground target
  tilt: number; heading: number; roll: number;
  weights: LayerWeights;
  caption: string;
}

export interface IntroPath { end: OrbitParams; endCamera: CameraSpec; at(u: number): IntroFrame }

/**
 * The flight, as tracks over normalised progress u in [0, 1]:
 *   0.00-0.20  slowly turning globe, drifting east towards the Horn of Africa
 *   0.20-0.47  dive onto Ethiopia, border traces itself, hold ("Ethiopia")
 *   0.47-0.69  descend into Sidama, tilt starts ("Sidama Region")
 *   0.69-1.00  settle onto Hawassa and Lake Hawassa, ending exactly on the main map's camera
 * Range (distance to the target) is eased in log space, so every doubling of zoom takes similar time.
 */
export function buildIntroPath(endCamera: CameraSpec = MAIN_SCENE_CAMERA): IntroPath {
  const end = orbitFromCamera(endCamera);
  const r = end.range;
  const lateKey = Math.min(2200, Math.max(r * 1.05, r * 1.8));
  const logRange = makeTrack([
    [0, Math.log(230000)], [0.17, Math.log(165000)], [0.31, Math.log(30000)], [0.42, Math.log(21000)],
    [0.57, Math.log(3600)], [0.67, Math.log(Math.max(2300, r * 1.2 + 2000))], [0.83, Math.log(lateKey)], [1, Math.log(r)],
  ].map(([x, y]) => [x, y] as [number, number]).filter((k, i, a) => i === 0 || k[1] < a[i - 1][1]));
  const lat = makeTrack([[0, 2.5], [0.17, 6.4], [0.31, 8.8], [0.42, 8.55], [0.57, 7.16], [0.67, 7.08], [1, end.lat]]);
  const lon = makeTrack([[0, 15], [0.17, 30.5], [0.31, 39.6], [0.42, 39.35], [0.57, 38.56], [0.67, 38.5], [1, end.lon]]);
  const T = end.tilt;
  const tilt = makeTrack([[0, 0], [0.31, 0.02 * T], [0.42, 0.13 * T], [0.57, 0.24 * T], [0.67, 0.33 * T], [0.83, 0.63 * T], [1, T]]);
  const H = end.heading;
  const heading = makeTrack([[0, H + 0.5], [0.31, H + 0.33], [0.57, H + 0.16], [0.83, H + 0.05], [1, H]]);
  const roll = makeTrack([[0, 0], [0.3, 0.03], [0.55, -0.035], [0.8, 0.018], [1, 0]]);
  const fov = makeTrack([[0, 34], [0.35, 38], [1, endCamera.fov]]);
  const alt = makeTrack([[0, 0], [0.67, 0], [1, end.alt]]);

  // the sphere pose at u = 1 differs from the flat main map by a few hundredths of a unit; blend that out
  const sphereEnd = poseFromOrbit(end);
  const dPos = sub(endCamera.position, sphereEnd.position);
  const dTgt = sub(endCamera.target, sphereEnd.target);

  return {
    end,
    endCamera,
    at(uIn: number): IntroFrame {
      const u = clamp01(uIn);
      const o: OrbitParams = {
        lat: lat.at(u), lon: lon.at(u), alt: alt.at(u), range: Math.exp(logRange.at(u)),
        tilt: tilt.at(u), heading: heading.at(u), roll: roll.at(u),
      };
      const pose = poseFromOrbit(o);
      const w = smootherstep(0.6, 1, u);
      const position = add(pose.position, scale(dPos, w));
      const target = add(pose.target, scale(dTgt, w));
      const altNow = len(sub(position, GLOBE_CENTER)) - EARTH_R;
      // screen-up: blend to the main map's lookAt basis (world +y) and keep it exactly perpendicular to the view
      const view = norm(sub(target, position));
      const flatRaw = sub([0, 1, 0], scale(view, view[1]));
      const flatUp = len(flatRaw) > 1e-6 ? norm(flatRaw) : pose.up;     // straight-down end camera: keep the path's up
      const blended = add(scale(pose.up, 1 - w), scale(flatUp, w));
      const up = norm(sub(blended, scale(view, dot(blended, view))));
      return {
        u, position, target, up, fov: fov.at(u), range: o.range, alt: altNow,
        lat: o.lat, lon: o.lon, tilt: o.tilt, heading: o.heading, roll: o.roll,
        weights: layerWeights(o.range, u, r),
        caption: captionAt(u),
      };
    },
  };
}

/** Haze (fog) distances for a frame: the main map's fog, scaled with the camera range so the look is constant. */
export function hazeRange(range: number, endRange: number, fog = MAIN_SCENE_FOG): [number, number] {
  const k = range / endRange;
  return [fog.near * k, fog.far * k];
}

/** Camera clip planes that keep depth precision from orbit to street level. */
export function clipPlanes(alt: number): [number, number] {
  const a = Math.max(1, alt);
  const horizon = Math.sqrt((EARTH_R + a) ** 2 - EARTH_R ** 2);
  return [Math.max(0.5, a * 0.04), horizon * 1.08 + 2000];
}
