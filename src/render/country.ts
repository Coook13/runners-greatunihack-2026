// Country layer for the real Hawassa map: Ethiopia and the region around Hawassa as satellite ground
// planes the district terrain sits inside, a sloped apron that blends the district edge into them,
// national roads, the border, city dots, the district outline, and camera / fog / pan limits that
// follow the zoom so you can pull out from one village to the whole country.
// The sim stays in the 40 km district; this layer is only scenery.
//
// Wiring in scene.ts (real map only), for the scene.ts owner to add:
//   1. import { attachCountryLayer, styleDistrictRoads } from './country';
//   2. after the real map is built:
//        const country = real ? attachCountryLayer({ scene, camera, controls, renderer, unitsPerMetre: SCALE, districtSize: WORLD_SIZE,
//          toScene: (x, y) => { const s = worldToScene({ x, y }); return new THREE.Vector3(s.x, groundAt({ x, y }), s.z); } }) : null;
//   3. in frame(), in place of the three `lim` clamp lines (before controls.update()):
//        if (country) country.update(); else { ...old district clamp... }
//   4. in dispose():  country?.dispose();
//   5. optional crisp district roads: after buildRealRoads, `const roadStyle = realRoads ? styleDistrictRoads(realRoads.group) : null;`
//      and in applyLayer `roadStyle?.setLayer(baseLayer);`
//
// update() owns camera.near / camera.far, the fog (colour and range), controls.maxDistance and
// controls.zoomSpeed, and keeps the orbit target inside Ethiopia's bounding box (moving the camera
// with it so a clamp never tilts the view).
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

// ---------- data ----------
export interface ImageRect { url: string; x0: number; x1: number; y0: number; y1: number }
export interface CountryData {
  border: [number, number][];
  roads: { cls: string; pts: [number, number][] }[];
  cities: { name: string; pos: [number, number] }[];
  imagery: { ethiopia: ImageRect; region: ImageRect };
}

export interface CountryLayerOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: any;                                        // OrbitControls
  renderer: THREE.WebGLRenderer;
  /** World metres -> scene, y = drawn ground level (only called for points inside the district). */
  toScene: (x: number, y: number) => THREE.Vector3;
  unitsPerMetre: number;
  districtSize: number;                                 // metres, the square district starts at (0, 0)
  dataUrl?: string;                                     // default '/geo/ethiopia-country.json'
  data?: CountryData;                                   // skip the fetch (dev pages, tests)
  districtName?: string;                                // default 'Hawassa'
}

export interface CountryLayer {
  update(): void;
  dispose(): void;
  /** 0 at district zoom, 1 once zoomed out to region / country scale. */
  readonly blend: number;
}

// ---------- pure helpers (unit-tested) ----------
type P3 = { x: number; y: number; z: number };

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** LOD blend on log distance: 0 up to 2.2 district widths, 1 from 6 district widths out. */
export function zoomBlend(dist: number, districtScene: number): number {
  return smoothstep(Math.log(districtScene * 2.2), Math.log(districtScene * 6), Math.log(Math.max(1e-6, dist)));
}

export interface ViewCurves { near: number; far: number; fogNear: number; fogFar: number }
/**
 * Depth range and haze for a camera `dist` from its target. `span` is the longest distance from any
 * orbit target to the far corner of the country image, so the far plane never cuts the imagery.
 * At district zoom the haze starts just past the district and is thick by ~10 district widths out;
 * zooming out pushes it away faster than the camera moves, so the whole country reads clear.
 */
export function viewCurves(dist: number, districtScene: number, span: number): ViewCurves {
  const D = Math.max(0, dist), ds = districtScene;
  const near = Math.max(Math.min(1, Math.max(0.02, D * 0.02)), D * 0.01);
  const extra = Math.max(0, D - 2.5 * ds);
  const fogNear = D + 1.25 * ds + 2 * extra;
  const fogFar = fogNear + 10 * ds + 3 * extra;
  const far = Math.max(3000, D + span + 100);
  return { near, far, fogNear, fogFar };
}

/** Camera distance that fits a halfW x halfH box (scene units) in a perspective view, looking straight down. */
export function fitDistance(halfW: number, halfH: number, fovDeg: number, aspect: number): number {
  const t = Math.tan((fovDeg * Math.PI) / 360);
  return Math.max(halfH / t, halfW / (t * Math.max(0.2, aspect)));
}

export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }
/** Scene-space centre and size of a lat/lon-linear image given in world metres. */
export function imagePlane(img: { x0: number; x1: number; y0: number; y1: number }, toScene: (x: number, y: number) => P3) {
  const sw = toScene(img.x0, img.y0), ne = toScene(img.x1, img.y1);
  return { cx: (sw.x + ne.x) / 2, cz: (sw.z + ne.z) / 2, w: Math.abs(ne.x - sw.x), h: Math.abs(sw.z - ne.z) };
}
/** UV of a world point on an image: u west->east, v south->north (texture flipY puts the image top north). */
export function worldToUV(img: { x0: number; x1: number; y0: number; y1: number }, x: number, y: number): [number, number] {
  return [(x - img.x0) / (img.x1 - img.x0), (y - img.y0) / (img.y1 - img.y0)];
}
/** 1 in the middle of an image, falling to 0 over `f` (fraction of the side) at every edge. */
export function feather(u: number, v: number, f: number): number {
  return smoothstep(0, f, u) * smoothstep(0, f, 1 - u) * smoothstep(0, f, v) * smoothstep(0, f, 1 - v);
}
/** Distance (metres) from a world point to the square district [0, size]^2; 0 inside. */
export function distToDistrict(x: number, y: number, size: number): number {
  const dx = Math.max(0, -x, x - size), dy = Math.max(0, -y, y - size);
  return Math.hypot(dx, dy);
}
/** Apron height: the district edge height `edgeY` easing down to the ground planes over `apronM` metres. */
export function apronY(dM: number, apronM: number, edgeY: number, planeY: number): number {
  return planeY + (edgeY - planeY) * (1 - smoothstep(0, apronM, dM));
}
/** Pan limit: clamp (x, z) into the rect. */
export function clampToRect(x: number, z: number, r: Rect): [number, number] {
  return [clamp(x, r.minX, r.maxX), clamp(z, r.minZ, r.maxZ)];
}
/** Split a polyline into points at most `stepM` apart (so lines follow the apron slope). */
export function densifyXY(pts: [number, number][], stepM: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const n = Math.floor(Math.hypot(bx - ax, by - ay) / stepM);
      for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / (n + 1), ay + ((by - ay) * k) / (n + 1)]);
    }
    out.push(pts[i]);
  }
  return out;
}

// ---------- look ----------
const PLANE_RENDER = -20;                               // planes draw first, without depth, so terrain always covers them
const APRON_M = 6000;                                   // the district edge eases down to the planes over 6 km
const APRON_STEP_M = 400;
const HAZE_FALLBACK = 0xb7bba8;
const ROAD_STYLE: Record<string, { core: number; width: number; casing: number }> = {
  Road: { core: 0xffd970, width: 2.6, casing: 4.8 },    // main national roads: Google-hybrid yellow
  Unknown: { core: 0xf4f1e6, width: 1.7, casing: 3.4 }, // the rest: light grey-white
};
const BORDER = { glow: 0xffc65a, core: 0xfff0c2 };
const OUTLINE = { glow: 0x6dffc0, core: 0xc9ffe6 };

const COUNTRY_CSS = `
.cty { pointer-events: none; font: 700 13px/1.2 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; white-space: nowrap; transition: opacity .15s; }
.cty-city { width: 0; height: 0; position: relative; }
.cty-city .dot { position: absolute; left: -5px; top: -5px; width: 10px; height: 10px; border-radius: 50%; background: #fff; border: 2px solid #1d2a24; box-shadow: 0 0 0 2px rgba(255,255,255,.35); box-sizing: border-box; }
.cty-city .nm { position: absolute; left: 10px; top: -10px; color: #fff; text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,0,.9); font-size: 14px; }
.cty-city.capital .dot { width: 12px; height: 12px; left: -6px; top: -6px; background: #ffd970; }
.cty-district { width: 0; height: 0; position: relative; }
.cty-district .nm { position: absolute; left: 0; bottom: 6px; transform: translateX(-50%); color: #0d1210; background: rgba(201, 255, 230, .92);
  padding: 3px 9px; border-radius: 10px; font-size: 12px; box-shadow: 0 1px 6px rgba(0,0,0,.45); }
.cty-country .nm { color: rgba(255, 240, 194, .92); text-shadow: 0 1px 3px #000; font-size: 22px; letter-spacing: .5em; font-weight: 800; transform: translateX(-50%); position: absolute; }
`;

function cityLabel(name: string, capital: boolean): CSS2DObject {
  const el = document.createElement('div');
  el.className = `cty cty-city${capital ? ' capital' : ''}`;
  el.innerHTML = '<span class="dot"></span><span class="nm"></span>';
  (el.querySelector('.nm') as HTMLElement).textContent = name;
  return new CSS2DObject(el);
}
function textLabel(cls: string, text: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = `cty ${cls}`;
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = text;
  el.appendChild(nm);
  return new CSS2DObject(el);
}

function lineSegs(positions: number[], color: number, width: number, order: number, additive = false): LineSegments2 {
  const geo = new LineSegmentsGeometry();
  geo.setPositions(positions);
  const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity: 1, depthWrite: false, worldUnits: false });
  if (additive) mat.blending = THREE.AdditiveBlending;
  mat.fog = true;
  const l = new LineSegments2(geo, mat);
  l.renderOrder = order;
  l.frustumCulled = false;
  return l;
}

/** Mean RGB (sRGB 0..1) of a loaded image, lifted toward white: a haze that matches the imagery. */
function hazeFrom(img: CanvasImageSource): THREE.Color | null {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0, gr = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    const lift = (v: number) => v / n / 255 + (1 - v / n / 255) * 0.42;
    return new THREE.Color().setRGB(lift(r), lift(gr), lift(b), THREE.SRGBColorSpace);
  } catch { return null; }
}

// ---------- the layer ----------
export function attachCountryLayer(opts: CountryLayerOptions): CountryLayer {
  const { scene, camera, controls, renderer, toScene, unitsPerMetre: upm, districtSize: size } = opts;
  const ds = size * upm;                                // district side, scene units
  const root = new THREE.Group();
  root.name = 'country-layer';
  scene.add(root);
  if (typeof document !== 'undefined' && !document.getElementById('runners-country-css')) {
    const st = document.createElement('style');
    st.id = 'runners-country-css';
    st.textContent = COUNTRY_CSS;
    document.head.appendChild(st);
  }

  // ground planes sit at the district's mean edge height, so the apron slopes are gentle both ways
  const edgeY = (x: number, y: number) => toScene(clamp(x, 0, size), clamp(y, 0, size)).y;
  let sum = 0, cnt = 0;
  for (let i = 0; i <= 64; i++) {
    const s = (i / 64) * size;
    for (const [x, y] of [[s, 0], [s, size], [0, s], [size, s]]) { sum += edgeY(x, y); cnt++; }
  }
  const planeY = sum / cnt;
  const groundY = (x: number, y: number) => {
    const d = distToDistrict(x, y, size);
    return d >= APRON_M ? planeY : apronY(d, APRON_M, edgeY(x, y), planeY);
  };

  const haze = new THREE.Color(HAZE_FALLBACK);
  const anis = renderer.capabilities.getMaxAnisotropy();
  const loader = new THREE.TextureLoader();
  const textures: THREE.Texture[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const labels: CSS2DObject[] = [];
  const fade: { obj: THREE.Object3D; mat?: { opacity: number }; el?: HTMLElement; base: number; from: number; kind: 'country' | 'outline' | 'hawassa' }[] = [];
  let bounds: Rect = { minX: -ds, maxX: ds, minZ: -ds, maxZ: ds };
  let span = 30 * ds;
  let maxDist = 50 * ds;
  let disposed = false;
  let terrainMesh: THREE.Mesh | null = null;
  let blend = 0;

  const loadTex = (url: string, onLoad: (t: THREE.Texture) => void) => {
    loader.load(url, (t) => {
      if (disposed) { t.dispose(); return; }
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = anis;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
      textures.push(t);
      onLoad(t);
    });
  };

  function build(data: CountryData): void {
    if (disposed) return;
    const { ethiopia, region } = data.imagery;

    // --- Ethiopia satellite: the whole country plus neighbours, under everything
    const ep = imagePlane(ethiopia, toScene);
    const eGeo = new THREE.PlaneGeometry(ep.w, ep.h);
    eGeo.rotateX(-Math.PI / 2);
    const eMat = new THREE.MeshStandardMaterial({ color: haze.clone(), roughness: 1, metalness: 0, depthWrite: false });
    const eMesh = new THREE.Mesh(eGeo, eMat);
    eMesh.position.set(ep.cx, planeY, ep.cz);
    eMesh.renderOrder = PLANE_RENDER;
    eMesh.name = 'country-ethiopia';
    root.add(eMesh);
    geos.push(eGeo); mats.push(eMat);
    loadTex(ethiopia.url, (t) => { eMat.map = t; eMat.color.set(0xffffff); eMat.needsUpdate = true; });

    // --- region satellite (finer), feathered into the country image at its edge.
    // CustomBlending keeps it in the opaque pass (drawn before terrain) while still blending.
    const rp = imagePlane(region, toScene);
    const rGeo = new THREE.PlaneGeometry(rp.w, rp.h);
    rGeo.rotateX(-Math.PI / 2);
    const fc = document.createElement('canvas');
    fc.width = fc.height = 64;
    const fg = fc.getContext('2d')!;
    const fd = fg.createImageData(64, 64);
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
      const a = Math.round(feather((i + 0.5) / 64, (j + 0.5) / 64, 0.12) * 255);
      fd.data.set([a, a, a, 255], (j * 64 + i) * 4);
    }
    fg.putImageData(fd, 0, 0);
    const alpha = new THREE.CanvasTexture(fc);
    textures.push(alpha);
    const rMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, metalness: 0, depthWrite: false, alphaMap: alpha, visible: false,
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const rMesh = new THREE.Mesh(rGeo, rMat);
    rMesh.position.set(rp.cx, planeY, rp.cz);
    rMesh.renderOrder = PLANE_RENDER + 1;
    rMesh.name = 'country-region';
    root.add(rMesh);
    geos.push(rGeo); mats.push(rMat);

    // --- apron: a ring around the district easing from its edge height down to the planes.
    // It starts one cell inside the district (slightly lower than the terrain) so no slit can open.
    const n = Math.ceil((size + 2 * APRON_M) / APRON_STEP_M);
    const step = (size + 2 * APRON_M) / n;
    const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
    const vid = new Int32Array((n + 1) * (n + 1)).fill(-1);
    const inner = APRON_STEP_M * 1.01;
    const keep = (x: number, y: number) => !(x > inner && x < size - inner && y > inner && y < size - inner);
    const vert = (i: number, j: number) => {
      const k = j * (n + 1) + i;
      if (vid[k] >= 0) return vid[k];
      const x = -APRON_M + i * step, y = -APRON_M + j * step;
      const inside = distToDistrict(x, y, size) === 0;
      const s = toScene(clamp(x, 0, size), clamp(y, 0, size));
      const sx = toScene(x, y);
      const yv = inside ? s.y - 0.5 : groundY(x, y);
      verts.push(sx.x, yv, sx.z);
      const [u, v] = worldToUV(region, x, y);
      uvs.push(u, v);
      vid[k] = verts.length / 3 - 1;
      return vid[k];
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const cx = -APRON_M + (i + 0.5) * step, cy = -APRON_M + (j + 0.5) * step;
      if (!keep(cx, cy)) continue;
      const a = vert(i, j), b = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
      // world y (north) is scene -z, so this winding faces up
      idx.push(a, b, c, a, c, d);
    }
    const aGeo = new THREE.BufferGeometry();
    aGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    aGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    aGeo.setIndex(idx);
    aGeo.computeVertexNormals();
    const aMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide, visible: false });
    const aMesh = new THREE.Mesh(aGeo, aMat);
    aMesh.renderOrder = PLANE_RENDER + 2;
    aMesh.name = 'country-apron';
    root.add(aMesh);
    geos.push(aGeo); mats.push(aMat);
    loadTex(region.url, (t) => {
      rMat.map = t; aMat.map = t;
      rMat.visible = aMat.visible = true;
      rMat.needsUpdate = aMat.needsUpdate = true;
      const h = t.image ? hazeFrom(t.image as CanvasImageSource) : null;
      if (h) { haze.copy(h); if (!eMat.map) eMat.color.copy(h); }
    });

    // --- national roads: dark casing + light core, screen-space widths; skipped inside the district
    const lift = 0.35;
    for (const cls of Object.keys(ROAD_STYLE)) {
      const st = ROAD_STYLE[cls];
      const pos: number[] = [];
      for (const r of data.roads) {
        if ((ROAD_STYLE[r.cls] ? r.cls : 'Unknown') !== cls) continue;
        const p = densifyXY(r.pts, 2500);
        for (let i = 1; i < p.length; i++) {
          const [ax, ay] = p[i - 1], [bx, by] = p[i];
          if (distToDistrict((ax + bx) / 2, (ay + by) / 2, size) === 0) continue;
          const a = toScene(ax, ay), b = toScene(bx, by);
          pos.push(a.x, groundY(ax, ay) + lift, a.z, b.x, groundY(bx, by) + lift, b.z);
        }
      }
      if (!pos.length) continue;
      const casing = lineSegs(pos, 0x14110b, st.casing, 1);
      const core = lineSegs(pos, st.core, st.width, 2);
      casing.name = `country-roads-${cls}-casing`; core.name = `country-roads-${cls}`;
      root.add(casing, core);
      fade.push({ obj: casing, mat: casing.material, base: 0.55, from: 0, kind: 'country' });
      fade.push({ obj: core, mat: core.material, base: 0.95, from: 0, kind: 'country' });
    }

    // --- border: wide soft glow + crisp core
    const bpos: number[] = [];
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    const ring = data.border;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const a = toScene(ax, ay), b = toScene(bx, by);
      bpos.push(a.x, planeY + 0.5, a.z, b.x, planeY + 0.5, b.z);
      bx0 = Math.min(bx0, a.x); bx1 = Math.max(bx1, a.x); bz0 = Math.min(bz0, a.z); bz1 = Math.max(bz1, a.z);
    }
    const bGlow = lineSegs(bpos, BORDER.glow, 9, 3, true);
    const bCore = lineSegs(bpos, BORDER.core, 2.2, 4);
    bGlow.name = 'country-border-glow'; bCore.name = 'country-border';
    root.add(bGlow, bCore);
    fade.push({ obj: bGlow, mat: bGlow.material, base: 0.35, from: 0, kind: 'country' });
    fade.push({ obj: bCore, mat: bCore.material, base: 1, from: 0, kind: 'country' });

    // pan limits, zoom limit and far-plane span come from the border and the image
    bounds = { minX: bx0, maxX: bx1, minZ: bz0, maxZ: bz1 };
    maxDist = fitDistance((bx1 - bx0) / 2, (bz1 - bz0) / 2, camera.fov, Math.max(1, camera.aspect)) * 1.25;
    const corners = [toScene(ethiopia.x0, ethiopia.y0), toScene(ethiopia.x1, ethiopia.y1)];
    span = Math.hypot(Math.max(Math.abs(corners[0].x - bx1), Math.abs(corners[1].x - bx0)), Math.max(Math.abs(corners[0].z - bz0), Math.abs(corners[1].z - bz1)));

    // --- the simulated district: glowing outline + label
    const opos: number[] = [];
    const per: [number, number][] = [];
    const k = 100;
    for (let i = 0; i < k; i++) per.push([(i / k) * size, 0]);
    for (let i = 0; i < k; i++) per.push([size, (i / k) * size]);
    for (let i = 0; i < k; i++) per.push([size - (i / k) * size, size]);
    for (let i = 0; i < k; i++) per.push([0, size - (i / k) * size]);
    for (let i = 0; i < per.length; i++) {
      const [ax, ay] = per[i], [bx, by] = per[(i + 1) % per.length];
      const a = toScene(ax, ay), b = toScene(bx, by);
      opos.push(a.x, a.y + 0.6, a.z, b.x, b.y + 0.6, b.z);
    }
    const oGlow = lineSegs(opos, OUTLINE.glow, 10, 5, true);
    const oCore = lineSegs(opos, OUTLINE.core, 2.4, 6);
    oGlow.name = 'district-outline-glow'; oCore.name = 'district-outline';
    root.add(oGlow, oCore);
    fade.push({ obj: oGlow, mat: oGlow.material, base: 0.45, from: 0.15, kind: 'outline' });
    fade.push({ obj: oCore, mat: oCore.material, base: 1, from: 0.4, kind: 'outline' });
    const dLabel = textLabel('cty-district', `Simulated district: ${opts.districtName ?? 'Hawassa'}`);
    const dn = toScene(size / 2, size);
    dLabel.position.set(dn.x, dn.y + 2, dn.z);
    root.add(dLabel); labels.push(dLabel);
    fade.push({ obj: dLabel, el: dLabel.element, base: 1, from: 0, kind: 'country' });

    // --- cities
    for (const c of data.cities) {
      const capital = /addis/i.test(c.name);
      const l = cityLabel(c.name, capital);
      const s = toScene(c.pos[0], c.pos[1]);
      const inDistrict = distToDistrict(c.pos[0], c.pos[1], size) === 0;
      l.position.set(s.x, (inDistrict ? s.y : groundY(c.pos[0], c.pos[1])) + 1, s.z);
      root.add(l); labels.push(l);
      fade.push({ obj: l, el: l.element, base: 1, from: 0, kind: inDistrict ? 'hawassa' : 'country' });
    }
    // country name, roughly in the middle of the highlands
    const cn = textLabel('cty-country', 'ETHIOPIA');
    const cm = toScene(150000, 420000);
    cn.position.set(cm.x, planeY + 1, cm.z);
    root.add(cn); labels.push(cn);
    fade.push({ obj: cn, el: cn.element, base: 1, from: 0, kind: 'country' });
    applyFade();
  }

  function applyFade(): void {
    const t = blend;
    for (const f of fade) {
      // the district's own labels take over when zoomed in; outlines stay faintly on
      const k = f.kind === 'outline' ? f.from + (1 - f.from) * t : f.kind === 'hawassa' ? smoothstep(0.5, 1, t) : t;
      const o = f.base * k;
      if (f.mat) f.mat.opacity = o;
      if (f.el) f.el.style.opacity = o.toFixed(3);
      f.obj.visible = o > 0.01;
    }
  }

  if (opts.data) build(opts.data);
  else fetch(opts.dataUrl ?? '/geo/ethiopia-country.json').then((r) => r.json()).then(build).catch((e) => console.warn('country layer:', e));

  /** The district terrain used to fade its edge into the dark backdrop; with a real country around it, drop that. */
  function unfadeTerrain(): void {
    terrainMesh ??= (scene.getObjectByName('terrain') as THREE.Mesh) ?? null;
    const m = terrainMesh?.material as THREE.Material | undefined;
    if (!m || !m.userData.edgeFade || m.userData.edgeFade === 'off') return;
    m.onBeforeCompile = () => {};
    m.customProgramCacheKey = THREE.Material.prototype.customProgramCacheKey;
    m.userData.edgeFade = 'off';                         // truthy, so the scene does not patch it again
    m.needsUpdate = true;
  }

  const delta = new THREE.Vector3();
  let lastBlend = -1;
  return {
    get blend() { return blend; },
    update() {
      if (disposed) return;
      unfadeTerrain();
      // pan stays inside Ethiopia; the camera moves with the target so a clamp never tilts the view
      const [tx, tz] = clampToRect(controls.target.x, controls.target.z, bounds);
      delta.set(tx - controls.target.x, 0, tz - controls.target.z);
      if (delta.x || delta.z) { controls.target.add(delta); camera.position.add(delta); }
      const D = camera.position.distanceTo(controls.target);
      const v = viewCurves(D, ds, span);
      if (Math.abs(camera.near - v.near) > 1e-5 || Math.abs(camera.far - v.far) > 1e-3) {
        camera.near = v.near; camera.far = v.far; camera.updateProjectionMatrix();
      }
      const fog = scene.fog as THREE.Fog | null;
      if (fog && (fog as THREE.Fog).isFog) { fog.near = v.fogNear; fog.far = v.fogFar; fog.color.copy(haze); }
      controls.maxDistance = Math.max(maxDist, controls.minDistance + 1);
      blend = zoomBlend(D, ds);
      controls.zoomSpeed = 1 + blend;                    // fewer wheel turns from district to country
      if (Math.abs(blend - lastBlend) > 1e-3) { lastBlend = blend; applyFade(); }
    },
    dispose() {
      disposed = true;
      for (const l of labels) l.parent?.remove(l);       // CSS2DObject's 'removed' hook detaches the DOM node
      scene.remove(root);
      root.traverse((o) => {
        const g = (o as THREE.Mesh).geometry;
        if (g) g.dispose();
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose();
      });
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}

// ---------- district roads ----------
const DISTRICT_ROAD_PX: Record<string, { width: number; color: number; opacity: number }> = {
  trunk: { width: 3.2, color: 0xffd970, opacity: 1 },
  primary: { width: 2.8, color: 0xffe28a, opacity: 1 },
  secondary: { width: 2.2, color: 0xfff1c9, opacity: 0.95 },
  tertiary: { width: 1.6, color: 0xf2f0ea, opacity: 0.85 },
  minor: { width: 1, color: 0xe6e4de, opacity: 0.45 },
  track: { width: 0.8, color: 0xd8d0bf, opacity: 0.22 },
};

/**
 * Restyle realmap.ts's OSM roads as crisp screen-space lines (Google-hybrid: yellow trunk/primary,
 * white secondary, light grey tertiary/minor, faint tracks). Call once after buildRealRoads():
 *   styleDistrictRoads(realRoads.group)
 * It hides the 1 px lines and world-width ribbons and adds LineSegments2 copies inside the same group,
 * so the roads toggle still works. Returns setLayer(l) to call from applyLayer (street map: 0.35).
 */
export function styleDistrictRoads(group: THREE.Group): { setLayer(l: 'sat' | 'street' | 'stylised'): void } {
  const added: { mat: LineMaterial; base: number }[] = [];
  for (const child of [...group.children]) {
    const m = /^roads-(\w+)(-ribbon)?$/.exec(child.name);
    if (!m) continue;
    child.visible = false;
    if (m[2]) continue;
    const st = DISTRICT_ROAD_PX[m[1]];
    const src = (child as THREE.LineSegments).geometry?.attributes.position as THREE.BufferAttribute | undefined;
    if (!st || !src || !src.count) continue;
    const pos = Array.from(src.array as Float32Array);
    for (let i = 1; i < pos.length; i += 3) pos[i] += 0.05;
    const casing = st.width >= 2 ? lineSegs(pos, 0x16130c, st.width + 2, 0) : null;
    const core = lineSegs(pos, st.color, st.width, 1);
    if (casing) { casing.name = `${child.name}-px-casing`; group.add(casing); added.push({ mat: casing.material, base: st.opacity * 0.5 }); }
    core.name = `${child.name}-px`;
    group.add(core);
    added.push({ mat: core.material, base: st.opacity });
  }
  const setLayer = (l: 'sat' | 'street' | 'stylised') => { const k = l === 'street' ? 0.35 : 1; for (const a of added) a.mat.opacity = a.base * k; };
  setLayer('sat');
  return { setLayer };
}
