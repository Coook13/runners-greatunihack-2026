// Shared assets for every carrier model: one PBR palette material (colour, roughness, metalness and
// emissive come from tiny data textures, so a whole vehicle is one draw call), a geometry builder that
// merges parts onto palette entries, and the procedural textures the effects use. No DOM needed.
import * as THREE from 'three';

// ---------- palette ----------
// [colour, roughness, metalness, emissive]
const PALETTE = {
  white: [0xf3f4f1, 0.36, 0.05, 0],
  offwhite: [0xe2e1da, 0.6, 0.0, 0],
  orange: [0xf07a1a, 0.4, 0.05, 0],
  medgreen: [0x1f9d55, 0.5, 0.0, 0],
  carbon: [0x26282c, 0.42, 0.3, 0],
  rubber: [0x161616, 0.92, 0.0, 0],
  plastic: [0x2c2e31, 0.6, 0.0, 0],
  metal: [0x8d9196, 0.35, 0.7, 0],
  chrome: [0xd8dade, 0.14, 0.9, 0],
  glass: [0x18232c, 0.06, 0.4, 0],
  rim: [0xb7bbc0, 0.4, 0.6, 0],
  navRed: [0xff2a1a, 0.4, 0.0, 0xff2010],
  navGreen: [0x20ff50, 0.4, 0.0, 0x10ff40],
  lamp: [0xfffbe8, 0.2, 0.0, 0xfff4d0],
  tail: [0xb01010, 0.3, 0.0, 0x600000],
  amber: [0xffa020, 0.3, 0.0, 0x804000],
  crate: [0xb88d58, 0.85, 0.0, 0x1a1006],
  strap: [0x4a3a28, 0.8, 0.0, 0],
  seal: [0xe9e4d6, 0.7, 0.0, 0],
  hivis: [0xd6f01e, 0.7, 0.0, 0x101400],
  jacket: [0x2e3a4a, 0.85, 0.0, 0],
  denim: [0x2f3e5c, 0.85, 0.0, 0],
  skin: [0x6b4630, 0.7, 0.0, 0],
  helmet: [0xd8401f, 0.3, 0.05, 0],
  bikeRed: [0xb0221c, 0.32, 0.1, 0],
  canopy: [0x2667b8, 0.85, 0.0, 0],
  hull: [0xf0efe8, 0.28, 0.0, 0],
  stripe: [0x1e4f9c, 0.35, 0.0, 0],
  deck: [0xcfccc3, 0.8, 0.0, 0],
  wood: [0x8a6a45, 0.8, 0.0, 0],
  outboard: [0x3a3d42, 0.38, 0.2, 0],
  rack: [0x202224, 0.5, 0.5, 0],
  jerry: [0x2f6b2e, 0.6, 0.0, 0],
  tarp: [0x4f5a3a, 0.9, 0.0, 0],
  dust: [0xa48d6c, 0.95, 0.0, 0],
  vanBlue: [0x1d5fa8, 0.4, 0.05, 0],
  shirt: [0x9c3b2e, 0.85, 0.0, 0],
} as const satisfies Record<string, readonly [number, number, number, number]>;
export type Pal = keyof typeof PALETTE;

const KEYS = Object.keys(PALETTE) as Pal[];
const W = 64;
const INDEX = new Map<Pal, number>(KEYS.map((k, i) => [k, i]));
export const palU = (k: Pal): number => (INDEX.get(k)! + 0.5) / W;

function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean, nearest: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function paletteTextures(): { map: THREE.DataTexture; rm: THREE.DataTexture; em: THREE.DataTexture } {
  const c = new Uint8Array(W * 4), r = new Uint8Array(W * 4), e = new Uint8Array(W * 4);
  KEYS.forEach((k, i) => {
    const [col, rough, metal, emi] = PALETTE[k];
    c.set([(col >> 16) & 255, (col >> 8) & 255, col & 255, 255], i * 4);
    r.set([0, Math.round(rough * 255), Math.round(metal * 255), 255], i * 4);
    e.set([(emi >> 16) & 255, (emi >> 8) & 255, emi & 255, 255], i * 4);
  });
  return { map: dataTex(c, W, 1, true, true), rm: dataTex(r, W, 1, false, true), em: dataTex(e, W, 1, true, true) };
}

// ---------- shared materials (created once, reused by every instance) ----------
export interface SharedMats {
  base: THREE.MeshStandardMaterial;       // normal look
  dead: THREE.MeshStandardMaterial;       // charred / broken
  highlight: THREE.MeshStandardMaterial;  // amber glow (leak finder, selection)
  intruder: THREE.MeshStandardMaterial;   // attack-console fake node
  blur: THREE.MeshBasicMaterial;          // rotor blur discs
  line: THREE.LineBasicMaterial;          // winch cable
  strobe: THREE.MeshBasicMaterial;
}
let mats: SharedMats | null = null;
export function sharedMats(): SharedMats {
  if (mats) return mats;
  const { map, rm, em } = paletteTextures();
  const base = new THREE.MeshStandardMaterial({
    map, roughnessMap: rm, metalnessMap: rm, emissiveMap: em, emissive: 0xffffff, emissiveIntensity: 1,
    roughness: 1, metalness: 1, envMapIntensity: 0.7,
  });
  const dead = base.clone();
  dead.color.setHex(0x5c5c5c);
  dead.emissiveMap = null; dead.emissive.setHex(0x000000);
  const highlight = base.clone();
  highlight.emissiveMap = null; highlight.emissive.setHex(0xffa020); highlight.emissiveIntensity = 0.45;
  const intruder = base.clone();
  intruder.color.setHex(0xff7a6a); intruder.emissiveMap = null; intruder.emissive.setHex(0x5a0a06); intruder.emissiveIntensity = 0.8;
  const blur = new THREE.MeshBasicMaterial({ map: blurTexture(), transparent: true, depthWrite: false, opacity: 0.55, side: THREE.DoubleSide, color: 0x222222 });
  const line = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
  const strobe = new THREE.MeshBasicMaterial({ color: 0xffffff });
  mats = { base, dead, highlight, intruder, blur, line, strobe };
  return mats;
}

/** Optional: a soft studio environment for the model materials only (makes paint, glass and metal read
 *  as PBR). Does not touch scene.environment. Call once with the app's renderer. */
export async function applyModelEnvironment(renderer: THREE.WebGLRenderer, intensity = 0.7): Promise<void> {
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  const m = sharedMats();
  for (const mat of [m.base, m.dead, m.highlight, m.intruder]) { mat.envMap = env; mat.envMapIntensity = intensity; mat.needsUpdate = true; }
}

// ---------- geometry builder ----------
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

export type Xf = { p?: [number, number, number]; r?: [number, number, number]; s?: number | [number, number, number] };
export function xf(t: Xf = {}): THREE.Matrix4 {
  const s = t.s ?? 1;
  tmpS.set(...(typeof s === 'number' ? ([s, s, s] as [number, number, number]) : s));
  tmpE.set(...(t.r ?? [0, 0, 0]));
  tmpQ.setFromEuler(tmpE);
  tmpP.set(...(t.p ?? [0, 0, 0]));
  return tmpM.compose(tmpP, tmpQ, tmpS).clone();
}

/** Collects parts (any three geometry + a palette key + a transform) and merges them into one mesh geometry. */
export class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];
  add(geo: THREE.BufferGeometry, pal: Pal, t: Xf | THREE.Matrix4 = {}): this {
    const m = t instanceof THREE.Matrix4 ? t : xf(t);
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(m);
    if (m.determinant() < 0) {                       // mirrored part: fix the winding so faces stay outward
      const pos = g.attributes.position.array as Float32Array, nor = g.attributes.normal.array as Float32Array;
      for (let i = 0; i < pos.length; i += 9) for (let k = 0; k < 3; k++) {
        const a = i + 3 + k, b = i + 6 + k;
        [pos[a], pos[b]] = [pos[b], pos[a]];
        [nor[a], nor[b]] = [nor[b], nor[a]];
      }
    }
    const n = g.attributes.position.count, uv = new Float32Array(n * 2), u = palU(pal);
    for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = 0.5; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.parts.push(g);
    return this;
  }
  /** Add a part and its mirror image across the centreline (z -> -z). */
  addPair(geo: THREE.BufferGeometry, pal: Pal, t: Xf | THREE.Matrix4 = {}): this {
    const m = t instanceof THREE.Matrix4 ? t : xf(t);
    this.add(geo.clone(), pal, m.clone());
    return this.add(geo, pal, new THREE.Matrix4().makeScale(1, 1, -1).multiply(m));
  }
  build(): THREE.BufferGeometry {
    let count = 0;
    for (const g of this.parts) count += g.attributes.position.count;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    let o = 0;
    for (const g of this.parts) {
      pos.set(g.attributes.position.array as Float32Array, o * 3);
      nor.set(g.attributes.normal.array as Float32Array, o * 3);
      uv.set(g.attributes.uv.array as Float32Array, o * 2);
      o += g.attributes.position.count;
      g.dispose();
    }
    this.parts = [];
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }
}

// ---------- primitive helpers ----------
export const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
export const cyl = (rTop: number, rBot: number, h: number, seg = 10) => new THREE.CylinderGeometry(rTop, rBot, h, seg);
export const sphere = (r: number, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);

/** A capsule limb from a to b (both [x,y,z]), radius r. */
export function limb(b: GeoBuilder, pal: Pal, a: [number, number, number], c: [number, number, number], r: number): void {
  const va = new THREE.Vector3(...a), vc = new THREE.Vector3(...c);
  const len = va.distanceTo(vc);
  const g = new THREE.CapsuleGeometry(r, Math.max(0.001, len - 2 * r * 0.4), 3, 8);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vc.clone().sub(va).normalize());
  const m = new THREE.Matrix4().compose(va.clone().add(vc).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  b.add(g, pal, m);
}

/** Medical cross (two thin bars) lying in the plane given by the transform, size = arm span. */
export function cross(b: GeoBuilder, pal: Pal, size: number, t: Xf): void {
  const th = 0.006, w = size * 0.32;
  const m = xf(t);
  b.add(box(size, th, w), pal, m.clone());
  b.add(box(w, th, size), pal, m);
}

/** Lathe around the x axis: profile = [radius, x] pairs from tail to nose. */
export function latheX(profile: [number, number][], seg = 14, squashY = 1, squashZ = 1): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(Math.max(0.0001, r), x)), seg);
  g.rotateZ(-Math.PI / 2);                            // lathe axis +y -> +x
  g.scale(1, squashY, squashZ);
  return g;
}

// ---------- procedural textures (DataTexture, no canvas) ----------
function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf_ = x - xi, yf = y - yi;
  const u = xf_ * xf_ * (3 - 2 * xf_), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function makeTex(size: number, f: (u: number, v: number) => [number, number, number, number], repeat = false): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const [r, g, b, a] = f((i + 0.5) / size, (j + 0.5) / size);
    d.set([r * 255, g * 255, b * 255, a * 255].map((x) => Math.max(0, Math.min(255, Math.round(x)))), (j * size + i) * 4);
  }
  const t = dataTex(d, size, size, true, false);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

let blurTex: THREE.DataTexture | null = null;
/** Rotor blur: a translucent disc, darker near the tips, with faint blade streaks. */
export function blurTexture(): THREE.DataTexture {
  return (blurTex ??= makeTex(64, (u, v) => {
    const x = u * 2 - 1, y = v * 2 - 1, r = Math.hypot(x, y), a = Math.atan2(y, x);
    if (r > 1) return [1, 1, 1, 0];
    const streak = 0.75 + 0.25 * Math.cos(a * 2);
    const tip = r > 0.9 ? 1.4 : 1;
    const alpha = r < 0.12 ? 0 : (0.25 + 0.45 * r) * streak * tip * (1 - Math.pow(r, 8));
    return [1, 1, 1, alpha];
  }));
}

let radialTex: THREE.DataTexture | null = null;
/** Soft round blob, white with alpha falloff (shadows, glows, smoke). */
export function radialTexture(): THREE.DataTexture {
  return (radialTex ??= makeTex(64, (u, v) => {
    const r = Math.hypot(u * 2 - 1, v * 2 - 1);
    const a = Math.max(0, 1 - r);
    return [1, 1, 1, a * a * (3 - 2 * a)];
  }));
}

let smokeTex: THREE.DataTexture | null = null;
export function smokeTexture(): THREE.DataTexture {
  return (smokeTex ??= makeTex(64, (u, v) => {
    const r = Math.hypot(u * 2 - 1, v * 2 - 1);
    const n = 0.6 + 0.4 * valueNoise(u * 6, v * 6);
    const a = Math.max(0, 1 - r) * n;
    return [1, 1, 1, Math.min(1, a * 1.4)];
  }));
}

let washTex: THREE.DataTexture | null = null;
/** Rotor wash on the ground: a dusty ring with streaks. */
export function washTexture(): THREE.DataTexture {
  return (washTex ??= makeTex(64, (u, v) => {
    const x = u * 2 - 1, y = v * 2 - 1, r = Math.hypot(x, y), a = Math.atan2(y, x);
    const ring = Math.exp(-Math.pow((r - 0.72) / 0.16, 2));
    const streak = 0.55 + 0.45 * valueNoise(a * 5 + 10, r * 3);
    return [1, 1, 1, r > 1 ? 0 : ring * streak];
  }));
}

let foamTex: THREE.DataTexture | null = null;
/** Boat wake foam: u across the wake (edges + centre churn), v along it (tiles). */
export function foamTexture(): THREE.DataTexture {
  return (foamTex ??= makeTex(64, (u, v) => {
    const edge = Math.exp(-Math.pow((Math.abs(u - 0.5) - 0.42) / 0.07, 2));
    const centre = Math.exp(-Math.pow((u - 0.5) / 0.12, 2)) * 0.8;
    const n = valueNoise(u * 14, v * 14) * 0.6 + valueNoise(u * 31, v * 31) * 0.4;
    return [1, 1, 1, Math.min(1, (edge + centre) * (0.35 + 0.9 * n))];
  }, true));
}
