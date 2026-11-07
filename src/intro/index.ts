// Opening fly-in for the demo: a turning globe dives onto Ethiopia, then Sidama, then settles on Hawassa,
// ending on exactly the main map's opening camera so the map can take over. Imagery is the bundled
// lat/lon-linear Sentinel-2 tiles; the border is Natural Earth (public/geo/ethiopia-border.json).
import * as THREE from 'three';
import {
  EARTH_R, GEO_BOUNDS, GLOBE_CENTER, HAWASSA_CITY, MAIN_SCENE_CAMERA, MAIN_SCENE_FOG, MAP_SIZE, SUBSOLAR,
  buildIntroPath, clipPlanes, geoToWorld, hazeRange, upAt, type Bounds, type CameraSpec, type IntroFrame,
} from './path';

export { MAIN_SCENE_CAMERA, buildIntroPath } from './path';
export type { CameraSpec } from './path';

export interface IntroOptions {
  durationSec?: number;                 // default 12
  onDone?: () => void;                  // after the fade-out (or straight away when fadeOutSec is 0)
  captions?: (text: string) => void;    // called on each change; '' clears. Omit to use the built-in captions.
  endCamera?: CameraSpec;               // default: the main map's opening camera
  fadeOutSec?: number;                  // default 0.9. 0 = hold the last frame until dispose()
}
export interface IntroHandle {
  skip(): void;
  dispose(): void;
  ready: Promise<void>;                 // resolves when imagery is on the GPU and the clock starts
}

const BASE = (import.meta.env?.BASE_URL ?? '/') + 'geo/';
const SPACE = new THREE.Color(0x03060c);
const HAZE_HIGH = new THREE.Color(0x9fb9d6);
const ATTRIBUTION = 'Imagery: Sentinel-2 cloudless 2020 by EOX IT Services GmbH (Copernicus Sentinel data 2020), CC BY-NC-SA 4.0 · Borders: Natural Earth';

type Ring = [number, number][];
interface BorderData { ethiopia: Ring[]; world: Ring[] }

// ---------- shaders ----------
const GROUND_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying float vViewZ;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 mv = viewMatrix * w;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const GROUND_FS = /* glsl */ `
uniform sampler2D uMap; uniform vec4 uBounds; uniform float uOpacity; uniform vec2 uFeather;
uniform sampler2D uMask; uniform vec4 uMaskBounds; uniform float uDim;
uniform vec4 uInner; uniform float uBeyond; uniform float uRim;
uniform vec3 uSun; uniform vec3 uHaze; uniform vec2 uHazeRange;
varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying float vViewZ;
void main() {
  vec3 c = texture2D(uMap, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, 1.08), 0.0);
  vec2 g = vec2(mix(uBounds.y, uBounds.w, vUv.x), mix(uBounds.x, uBounds.z, vUv.y));   // lon, lat
  vec2 mUv = vec2((g.x - uMaskBounds.y) / (uMaskBounds.w - uMaskBounds.y), (g.y - uMaskBounds.x) / (uMaskBounds.z - uMaskBounds.x));
  float inB = step(0.0, mUv.x) * step(mUv.x, 1.0) * step(0.0, mUv.y) * step(mUv.y, 1.0);
  float m = texture2D(uMask, clamp(mUv, 0.0, 1.0)).r * inB;
  c = mix(c, vec3(l) * vec3(0.30, 0.32, 0.36), uDim * (1.0 - m));
  vec3 N = normalize(vN);
  float s = mix(0.035, 1.0, smoothstep(-0.12, 0.55, dot(N, uSun)));
  c *= s;
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  c = mix(c, vec3(0.42, 0.62, 0.95) * mix(0.12, 1.0, s), rim * uRim);
  float inside = smoothstep(0.0, 0.004, min(min(g.x - uInner.y, uInner.w - g.x), min(g.y - uInner.x, uInner.z - g.y)));
  float hz = clamp((vViewZ - uHazeRange.x) / (uHazeRange.y - uHazeRange.x), 0.0, 1.0);
  c = mix(c, uHaze, max(hz, uBeyond * (1.0 - inside)));
  float edge = 1.0;
  if (uFeather.x > 0.0) {
    vec2 e = min(vUv, 1.0 - vUv) / uFeather;
    edge = clamp(min(e.x, e.y), 0.0, 1.0);
    edge = edge * edge * (3.0 - 2.0 * edge);
  }
  gl_FragColor = vec4(c, uOpacity * edge);
  #include <colorspace_fragment>
}`;

// screen-space ribbon: constant pixel width at any altitude, hidden on the far side of the globe
const LINE_VS = /* glsl */ `
uniform vec2 uRes; uniform float uWidth;
attribute vec3 aOther; attribute float aSide; attribute float aEnd; attribute float aDist; attribute vec3 aNormal;
varying float vSide; varying float vDist; varying float vFacing;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 c0 = projectionMatrix * viewMatrix * wp;
  vec4 c1 = projectionMatrix * viewMatrix * (modelMatrix * vec4(aOther, 1.0));
  vSide = aSide; vDist = aDist;
  vFacing = dot(normalize(aNormal), normalize(cameraPosition - wp.xyz));
  if (c0.w <= 0.0 || c1.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 s0 = c0.xy / c0.w * 0.5 * uRes, s1 = c1.xy / c1.w * 0.5 * uRes;
  vec2 dir = s1 - s0; float L = length(dir); dir = L > 1e-4 ? dir / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x) * (aEnd > 0.5 ? -1.0 : 1.0);
  vec2 off = nrm * aSide * uWidth - dir * uWidth;
  c0.xy += off / (0.5 * uRes) * c0.w;
  gl_Position = c0;
}`;

const LINE_FS = /* glsl */ `
uniform vec3 uCore; uniform vec3 uGlow; uniform float uOpacity; uniform float uProgress; uniform float uTime;
varying float vSide; varying float vDist; varying float vFacing;
void main() {
  if (vFacing < 0.0 || vDist > uProgress) discard;
  float a = abs(vSide);
  float core = smoothstep(0.24, 0.12, a);
  float glow = exp(-a * a * 5.0) * (0.82 + 0.18 * sin(uTime * 2.2));
  float head = smoothstep(0.035, 0.0, uProgress - vDist) * step(uProgress, 0.999);
  vec3 col = uCore * core + uGlow * glow + vec3(1.0) * head * glow;
  float alpha = clamp(max(core, glow * 0.85) * uOpacity * smoothstep(0.0, 0.12, vFacing), 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
  #include <colorspace_fragment>
}`;

const MARKER_FS = /* glsl */ `
uniform float uTime; uniform float uOpacity; uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0; float r = length(p);
  float core = smoothstep(0.075, 0.055, r);
  float outline = smoothstep(0.02, 0.0, abs(r - 0.085)) * 0.9;
  float halo = exp(-r * r * 40.0) * 0.55;
  float rings = 0.0;
  for (int i = 0; i < 2; i++) {
    float ph = fract(uTime * 0.55 + float(i) * 0.5);
    float rr = 0.1 + ph * 0.86;
    rings += smoothstep(0.012 + 0.02 * ph, 0.0, abs(r - rr)) * (1.0 - ph) * (1.0 - ph);
  }
  vec3 col = mix(uColor, vec3(1.0), clamp(core * 0.85 + outline, 0.0, 1.0));
  float a = clamp(core + outline + halo + rings, 0.0, 1.0) * uOpacity * smoothstep(1.0, 0.95, r);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

// ---------- geometry ----------
function geoGrid(b: Bounds, sx: number, sy: number): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= sy; j++) {
    for (let i = 0; i <= sx; i++) {
      const lat = b.south + ((b.north - b.south) * j) / sy, lon = b.west + ((b.east - b.west) * i) / sx;
      pos.push(...geoToWorld(lat, lon));
      nrm.push(...upAt(lat, lon));
      uv.push(i / sx, j / sy);
    }
  }
  for (let j = 0; j < sy; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * (sx + 1) + i, b2 = a + 1, c = a + sx + 1, d = c + 1;
      idx.push(a, b2, c, c, b2, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function buildRibbon(rings: Ring[]): THREE.BufferGeometry {
  const P: number[] = [], O: number[] = [], S: number[] = [], E: number[] = [], D: number[] = [], N: number[] = [], I: number[] = [];
  let v = 0;
  for (const ring of rings) {
    // densify so long straight borders follow the lat/lon-linear imagery and the globe's curve
    const pts: [number, number][] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25));
      for (let s = 0; s < k; s++) pts.push([x0 + ((x1 - x0) * s) / k, y0 + ((y1 - y0) * s) / k]);
    }
    pts.push(ring[ring.length - 1]);
    const w = pts.map(([lon, lat]) => geoToWorld(lat, lon, 0));
    const nr = pts.map(([lon, lat]) => upAt(lat, lon));
    const cum = [0];
    for (let i = 1; i < w.length; i++) cum.push(cum[i - 1] + Math.hypot(w[i][0] - w[i - 1][0], w[i][1] - w[i - 1][1], w[i][2] - w[i - 1][2]));
    const total = cum[cum.length - 1] || 1;
    for (let i = 0; i < w.length - 1; i++) {
      const a = w[i], b = w[i + 1];
      for (const [p, o, end, n, dist] of [[a, b, 0, nr[i], cum[i]], [b, a, 1, nr[i + 1], cum[i + 1]]] as const) {
        for (const side of [-1, 1]) {
          P.push(...p); O.push(...o); S.push(side); E.push(end); N.push(...n); D.push(dist / total);
        }
      }
      I.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
      v += 4;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aOther', new THREE.Float32BufferAttribute(O, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(S, 1));
  g.setAttribute('aEnd', new THREE.Float32BufferAttribute(E, 1));
  g.setAttribute('aDist', new THREE.Float32BufferAttribute(D, 1));
  g.setAttribute('aNormal', new THREE.Float32BufferAttribute(N, 3));
  g.setIndex(I);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

// ---------- canvas textures ----------
const lonX = (lon: number, W: number) => ((lon + 180) / 360) * W;
const latY = (lat: number, H: number) => ((90 - lat) / 180) * H;

/** Stylised equirectangular Earth with the real Ethiopia tile feathered into place. */
function globeCanvas(world: Ring[], eth: CanvasImageSource | null, W = 4096): HTMLCanvasElement {
  const H = W / 2;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  const sea = ctx.createLinearGradient(0, 0, 0, H);
  sea.addColorStop(0, '#0a1a31'); sea.addColorStop(0.5, '#123056'); sea.addColorStop(1, '#0a1a31');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, W, H);
  const land = ctx.createLinearGradient(0, 0, 0, H);
  for (const [lat, col] of [[90, '#d9dde0'], [62, '#9aa08a'], [45, '#6f7a52'], [28, '#b59a68'], [16, '#a08654'], [5, '#5b6a3a'], [-12, '#6b6f40'], [-25, '#9c845a'], [-40, '#6f7a52'], [-62, '#c9ced2'], [-90, '#eef1f3']] as const) {
    land.addColorStop((90 - lat) / 180, col);
  }
  ctx.fillStyle = land;
  ctx.strokeStyle = 'rgba(255,240,215,0.16)';
  ctx.lineWidth = 1.2;
  for (const ring of world) {
    ctx.beginPath();
    ring.forEach(([lon, lat], i) => (i ? ctx.lineTo(lonX(lon, W), latY(lat, H)) : ctx.moveTo(lonX(lon, W), latY(lat, H))));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  if (eth) {
    const b = GEO_BOUNDS.ethiopia;
    const x = lonX(b.west, W), y = latY(b.north, H), w = lonX(b.east, W) - x, h = latY(b.south, H) - y;
    const tile = document.createElement('canvas');
    tile.width = Math.ceil(w) * 2; tile.height = Math.ceil(h) * 2;
    const t = tile.getContext('2d')!;
    t.drawImage(eth, 0, 0, tile.width, tile.height);
    t.globalCompositeOperation = 'destination-out';
    const fx = tile.width * (0.8 / (b.east - b.west)), fy = tile.height * (0.8 / (b.north - b.south));
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [
      [0, 0, fx, 0, 0, 0, fx, tile.height], [tile.width, 0, tile.width - fx, 0, tile.width - fx, 0, fx, tile.height],
      [0, 0, 0, fy, 0, 0, tile.width, fy], [0, tile.height, 0, tile.height - fy, 0, tile.height - fy, tile.width, fy],
    ]) {
      const gr = t.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      t.fillStyle = gr;
      t.fillRect(rx, ry, rw, rh);
    }
    ctx.drawImage(tile, x, y, w, h);
  }
  return cv;
}

/** White inside Ethiopia, black outside, over the Ethiopia tile bounds. */
function maskCanvas(rings: Ring[]): HTMLCanvasElement {
  const b = GEO_BOUNDS.ethiopia, W = 1024, H = Math.round((W * (b.north - b.south)) / (b.east - b.west));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.filter = 'blur(2px)';
  ctx.fillStyle = '#fff';
  for (const ring of rings) {
    ctx.beginPath();
    ring.forEach(([lon, lat], i) => {
      const px = ((lon - b.west) / (b.east - b.west)) * W, py = ((b.north - lat) / (b.north - b.south)) * H;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  }
  return cv;
}

// ---------- overlay (captions, vignette, curtain, attribution) ----------
const CSS = `
.ri-ov{position:absolute;pointer-events:none;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ri-curtain{position:absolute;inset:0;background:#03060c;transition:opacity .9s ease}
.ri-vig{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,transparent 52%,rgba(0,0,0,.5) 100%)}
.ri-cap{position:absolute;left:6%;bottom:13%;max-width:70%;color:#fff;opacity:0;transform:translateY(14px);
  transition:opacity .9s ease,transform 1.1s cubic-bezier(.2,.7,.2,1);text-shadow:0 2px 22px rgba(0,0,0,.6)}
.ri-cap.on{opacity:1;transform:none}
.ri-cap::before{content:"";display:block;width:44px;height:2px;background:#ffb020;margin-bottom:16px}
.ri-cap b{display:block;font-weight:300;font-size:clamp(30px,4.6vw,72px);line-height:1.02;letter-spacing:.01em}
.ri-cap span{display:block;margin-top:.55em;font-size:clamp(14px,1.5vw,22px);font-weight:400;letter-spacing:.03em;opacity:.88}
.ri-attr{position:absolute;right:10px;bottom:6px;font-size:10px;color:rgba(255,255,255,.55);text-shadow:0 1px 3px rgba(0,0,0,.8)}
`;

function makeOverlay(canvas: HTMLCanvasElement, builtInCaptions: boolean) {
  if (!document.getElementById('ri-css')) {
    const st = document.createElement('style');
    st.id = 'ri-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const root = document.createElement('div');
  root.className = 'ri-ov';
  const vig = document.createElement('div');
  vig.className = 'ri-vig';
  const attr = document.createElement('div');
  attr.className = 'ri-attr';
  attr.textContent = ATTRIBUTION;
  const curtain = document.createElement('div');
  curtain.className = 'ri-curtain';
  root.append(vig, attr, curtain);
  canvas.insertAdjacentElement('afterend', root);
  let cap: HTMLDivElement | null = null;
  return {
    root, vig, curtain,
    place() {
      Object.assign(root.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.clientWidth}px`, height: `${canvas.clientHeight}px` });
    },
    caption(text: string) {
      if (!builtInCaptions) return;
      const old = cap;
      if (old) { old.classList.remove('on'); setTimeout(() => old.remove(), 1200); }
      cap = null;
      if (!text) return;
      const el = document.createElement('div');
      el.className = 'ri-cap';
      const [title, ...rest] = text.split(':');
      const b = document.createElement('b');
      b.textContent = title.trim();
      el.appendChild(b);
      if (rest.length) { const s = document.createElement('span'); s.textContent = rest.join(':').trim(); el.appendChild(s); }
      root.insertBefore(el, curtain);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
      cap = el;
    },
  };
}

// ---------- main ----------
export function playIntro(canvas: HTMLCanvasElement, opts: IntroOptions = {}): IntroHandle {
  const duration = Math.max(1, opts.durationSec ?? 12);
  const fadeOut = Math.max(0, opts.fadeOutSec ?? 0.9);
  const path = buildIntroPath(opts.endCamera ?? MAIN_SCENE_CAMERA);
  const endRange = path.end.range;

  canvas.style.opacity = '1';
  canvas.style.transition = '';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(SPACE, 1);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const overlay = makeOverlay(canvas, !opts.captions);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 10, 400000);

  // shared uniforms (the same objects are referenced by every ground material)
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.needsUpdate = true;
  const eb = GEO_BOUNDS.ethiopia, hb = GEO_BOUNDS.hawassa;
  const shared = {
    uMask: { value: white as THREE.Texture },
    uMaskBounds: { value: new THREE.Vector4(eb.south, eb.west, eb.north, eb.east) },
    uDim: { value: 0 },
    uInner: { value: new THREE.Vector4(hb.south, hb.west, hb.north, hb.east) },
    uBeyond: { value: 0 },
    uSun: { value: new THREE.Vector3(...upAt(SUBSOLAR.lat, SUBSOLAR.lon)) },
    uHaze: { value: HAZE_HIGH.clone() },
    uHazeRange: { value: new THREE.Vector2(1e9, 2e9) },
  };
  const groundMat = (map: THREE.Texture, b: Bounds, feather: [number, number], order: number, globe = false) => {
    const m = new THREE.ShaderMaterial({
      vertexShader: GROUND_VS, fragmentShader: GROUND_FS,
      uniforms: {
        ...shared,
        uMap: { value: map }, uBounds: { value: new THREE.Vector4(b.south, b.west, b.north, b.east) },
        uOpacity: { value: globe ? 1 : 0 }, uFeather: { value: new THREE.Vector2(...feather) }, uRim: { value: globe ? 0.7 : 0 },
      },
      transparent: !globe, depthTest: globe, depthWrite: globe, side: THREE.FrontSide,
    });
    return { m, order };
  };
  const prepTex = (t: THREE.Texture, srgb = true) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = maxAniso;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  };

  const loader = new THREE.TextureLoader();
  const tex = (f: string) => loader.loadAsync(BASE + f).then((t) => prepTex(t)).catch(() => null);
  const json = <T,>(f: string) => fetch(BASE + f).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

  const disposables: { dispose(): void }[] = [white];
  let ethPatch: THREE.Mesh | null = null, regionPatch: THREE.Mesh | null = null, hawassaPatch: THREE.Mesh | null = null;
  let border: THREE.Mesh | null = null, marker: THREE.Mesh | null = null, globe: THREE.Mesh | null = null;
  const lineUniforms = {
    uRes: { value: new THREE.Vector2(1, 1) }, uWidth: { value: 7 },
    uCore: { value: new THREE.Color(0xfff4dc) }, uGlow: { value: new THREE.Color(0xffa31a) },
    uOpacity: { value: 0 }, uProgress: { value: 0 }, uTime: { value: 0 },
  };
  const markerUniforms = { uTime: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0xffb020) } };

  let disposed = false, started = false, finished = false, raf = 0, t0 = 0, lastCaption = '';
  const say = (text: string) => {
    if (text === lastCaption) return;
    lastCaption = text;
    opts.captions?.(text);
    overlay.caption(text);
  };

  function resize(): void {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    lineUniforms.uRes.value.copy(db);
    lineUniforms.uWidth.value = 7 * renderer.getPixelRatio();
    overlay.place();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  renderer.clear();

  const tmpUp = new THREE.Vector3();
  function apply(f: IntroFrame, timeSec: number): void {
    camera.position.set(...f.position);
    camera.up.copy(tmpUp.set(...f.up));
    camera.lookAt(f.target[0], f.target[1], f.target[2]);
    const [near, far] = clipPlanes(f.alt);
    camera.near = near; camera.far = far; camera.fov = f.fov;
    camera.updateProjectionMatrix();
    const w = f.weights;
    const [hn, hf] = hazeRange(f.range, endRange);
    shared.uHazeRange.value.set(hn, hf);
    shared.uHaze.value.copy(HAZE_HIGH).lerp(new THREE.Color(MAIN_SCENE_FOG.color), w.hazeWarm);
    shared.uDim.value = w.dim;
    shared.uBeyond.value = w.beyond;
    renderer.setClearColor(SPACE.clone().lerp(new THREE.Color(MAIN_SCENE_FOG.color), w.hazeWarm), 1);
    if (globe) (globe.material as THREE.ShaderMaterial).uniforms.uRim.value = 0.7 * w.atmosphere;
    const setPatch = (m: THREE.Mesh | null, a: number) => {
      if (!m) return;
      m.visible = a > 0.001;
      (m.material as THREE.ShaderMaterial).uniforms.uOpacity.value = a;
    };
    setPatch(ethPatch, w.ethiopia);
    setPatch(regionPatch, w.region);
    setPatch(hawassaPatch, w.hawassa);
    if (hawassaPatch) (hawassaPatch.material as THREE.ShaderMaterial).uniforms.uFeather.value.set(w.feather, w.feather);
    if (border) {
      border.visible = w.border > 0.001 && w.borderDraw > 0;
      lineUniforms.uOpacity.value = w.border;
      lineUniforms.uProgress.value = w.borderDraw;
      lineUniforms.uTime.value = timeSec;
    }
    if (marker) {
      marker.visible = w.marker > 0.001;
      markerUniforms.uOpacity.value = w.marker;
      markerUniforms.uTime.value = timeSec;
      marker.scale.setScalar(f.range * 0.09);
    }
    overlay.vig.style.opacity = w.vignette.toFixed(3);
    say(f.caption);
  }

  async function load(): Promise<void> {
    const [ethT, regT, hawT, borderData] = await Promise.all([
      tex('ethiopia-sat.jpg'), tex('region-sat.jpg'), tex('hawassa-sat.jpg'), json<BorderData>('ethiopia-border.json'),
    ]);
    if (disposed) return;
    // globe
    const gTex = prepTex(new THREE.CanvasTexture(globeCanvas(borderData?.world ?? [], (ethT?.image as CanvasImageSource) ?? null)));
    disposables.push(gTex);
    const g = groundMat(gTex, { south: -90, west: -180, north: 90, east: 180 }, [0, 0], 0, true);
    globe = new THREE.Mesh(geoGrid({ south: -89.9, west: -180, north: 89.9, east: 180 }, 256, 128), g.m);
    globe.renderOrder = 0;
    globe.frustumCulled = false;
    scene.add(globe);
    if (borderData?.ethiopia?.length) {
      const mTex = new THREE.CanvasTexture(maskCanvas(borderData.ethiopia));
      mTex.colorSpace = THREE.NoColorSpace;
      shared.uMask.value = mTex;
      disposables.push(mTex);
    }
    const patch = (t: THREE.Texture | null, b: Bounds, geo: THREE.BufferGeometry, feather: [number, number], order: number) => {
      if (!t) return null;
      disposables.push(t);
      const mesh = new THREE.Mesh(geo, groundMat(t, b, feather, order).m);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    ethPatch = patch(ethT, eb, geoGrid(eb, 96, 76), [0.8 / (eb.east - eb.west), 0.8 / (eb.north - eb.south)], 2);
    const rb = GEO_BOUNDS.region;
    regionPatch = patch(regT, rb, geoGrid(rb, 40, 40), [0.06, 0.06], 3);
    // the district tile is flat and exactly the main map's 400 x 400 ground
    const flat = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 1, 1);
    flat.rotateX(-Math.PI / 2);
    hawassaPatch = patch(hawT, hb, flat, [0.05, 0.05], 4);
    if (borderData?.ethiopia?.length) {
      border = new THREE.Mesh(buildRibbon(borderData.ethiopia), new THREE.ShaderMaterial({
        vertexShader: LINE_VS, fragmentShader: LINE_FS, uniforms: lineUniforms,
        transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,   // ribbon winding flips with screen direction
        blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
      }));
      border.renderOrder = 6;
      border.frustumCulled = false;
      scene.add(border);
    }
    const mg = new THREE.PlaneGeometry(1, 1);
    marker = new THREE.Mesh(mg, new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: MARKER_FS, uniforms: markerUniforms, transparent: true, depthTest: false, depthWrite: false,
    }));
    marker.position.set(...geoToWorld(HAWASSA_CITY.lat, HAWASSA_CITY.lon, 0.3));
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...upAt(HAWASSA_CITY.lat, HAWASSA_CITY.lon)));
    marker.renderOrder = 7;
    marker.frustumCulled = false;
    scene.add(marker);

    // upload every texture and compile every shader now, so nothing hitches mid-flight
    for (const t of [gTex, ethT, regT, hawT, shared.uMask.value]) if (t) renderer.initTexture(t);
    scene.traverse((o) => { o.visible = true; });
    apply(path.at(0), 0);
    renderer.compile(scene, camera);
    apply(path.at(0), 0);
    renderer.render(scene, camera);
  }

  function finish(fast: boolean): void {
    if (finished || disposed) return;
    finished = true;
    cancelAnimationFrame(raf);
    if (started) { apply(path.at(1), performance.now() / 1000); renderer.render(scene, camera); }
    say('');
    detach();
    const f = fast ? Math.min(fadeOut, 0.4) : fadeOut;
    if (f <= 0) { opts.onDone?.(); return; }
    for (const el of [canvas, overlay.root]) { el.style.transition = `opacity ${f}s ease`; el.style.opacity = '0'; }
    setTimeout(() => { dispose(); canvas.style.pointerEvents = 'none'; opts.onDone?.(); }, f * 1000 + 30);
  }

  function frame(): void {
    if (disposed || finished) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const u = (now - t0) / 1000 / duration;
    apply(path.at(u), now / 1000);
    renderer.render(scene, camera);
    if (u >= 1) finish(false);
  }

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true); };
  const onClick = () => finish(true);
  window.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', onClick);
  function detach(): void {
    window.removeEventListener('keydown', onKey);
    canvas.removeEventListener('pointerdown', onClick);
  }

  const ready = load().then(() => {
    if (disposed || finished) return;
    started = true;
    t0 = performance.now();
    overlay.curtain.style.opacity = '0';
    frame();
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    detach();
    ro.disconnect();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    for (const d of disposables) d.dispose();
    renderer.dispose();
    overlay.root.remove();
  }

  return { skip: () => finish(true), dispose, ready };
}

export { EARTH_R, GLOBE_CENTER };
