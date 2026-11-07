// Real Hawassa map for the 3D view: DEM terrain with the satellite (or street map) image draped on it,
// Lake Hawassa, OSM roads by class, place labels and the attribution line. Everything is built per
// renderer (no module-level three.js objects), so two renderers can run on one page.
import * as THREE from 'three';
import type { Vec2 } from '../contracts/types';
import {
  ATTRIBUTION, GEO_SIZE, LAKE, LAKE_AREA_M2, LAKE_CENTROID, LAKE_NAME, OTHER_WATER, PLACES, ROADS, heightAtSmooth,
  inLake, nearestShore, type RoadClass,
} from '../geo';
import { SCALE, SCENE_SIZE, WATER_LEVEL, clamp01, sceneToWorld, worldToScene, type HeightField, type WaterShape } from './mapping';

export type BaseLayer = 'sat' | 'street' | 'stylised';
export const REAL_EXAGGERATION = 3;                     // vertical exaggeration so the hills read
const LAKE_LEVEL_M = 1684;                              // Lake Hawassa's surface, metres above sea level
const SHORE_BLEND_M = 450;
const smooth = (t: number) => { const k = clamp01(t); return k * k * (3 - 2 * k); };

/** Scene height (units) for the real map: exaggerated DEM, carved below water inside Lake Hawassa. */
export function realHeightAt(p: Vec2): number {
  const land = WATER_LEVEL + 0.15 + Math.max(0, heightAtSmooth(p.x, p.y) - LAKE_LEVEL_M) * SCALE * REAL_EXAGGERATION;
  const box = p.x > 9000 && p.x < 21000 && p.y > 11800 && p.y < 29500;  // lake bbox plus the blend band
  if (!box) return land;
  const d = nearestShore(p).d;
  if (inLake(p)) return WATER_LEVEL - 0.35 - Math.min(1.4, d / 900);
  if (d >= SHORE_BLEND_M) return land;
  return WATER_LEVEL + 0.15 + (land - WATER_LEVEL - 0.15) * smooth(d / SHORE_BLEND_M);
}

/** A HeightField for the rest of the renderer (grid, storms, vehicles). Water shape is a summary only. */
export function makeRealField(river: Vec2[] = []): HeightField {
  const water: WaterShape = {
    river: river.length > 1 ? river : [{ x: -1e6, y: -1e6 }, { x: -1e6 + 1, y: -1e6 }],
    riverHalfWidth: 30,
    lake: { pos: { ...LAKE_CENTROID }, radius: Math.sqrt(LAKE_AREA_M2 / Math.PI) },
  };
  return { water, heightAt: realHeightAt, tint: () => 0.5 };
}

// ---------- terrain ----------
const STYLE = {
  low: new THREE.Color(0x8fa557), mid: new THREE.Color(0xb3a45f), high: new THREE.Color(0x8f7a62), shore: new THREE.Color(0xd9c38f),
};

export interface RealTerrain {
  mesh: THREE.Mesh;
  setLayer(l: BaseLayer): void;
  dispose(): void;
}

export function buildRealTerrain(field: HeightField, imageryBase = '/geo/', anisotropy = 4, segments = 256): RealTerrain {
  const geo = new THREE.PlaneGeometry(SCENE_SIZE, SCENE_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const w = sceneToWorld(pos.getX(i), pos.getZ(i));
    const h = field.heightAt(w);
    pos.setY(i, h);
    uv.setXY(i, Math.min(1, Math.max(0, w.x / GEO_SIZE)), Math.min(1, Math.max(0, w.y / GEO_SIZE)));
    const k = (h - WATER_LEVEL) / 30;
    if (k < 0.35) col.copy(STYLE.low).lerp(STYLE.mid, k / 0.35); else col.copy(STYLE.mid).lerp(STYLE.high, Math.min(1, (k - 0.35) / 0.65));
    if (h < WATER_LEVEL + 0.4) col.lerp(STYLE.shore, 0.6);
    colors.set([col.r, col.g, col.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const stylised = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const sat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const street = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.35 });
  const loader = new THREE.TextureLoader();
  const textures: THREE.Texture[] = [];
  let layer: BaseLayer = 'stylised';
  const mesh = new THREE.Mesh(geo, stylised);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  const load = (mat: THREE.MeshStandardMaterial, file: string, emissive: boolean) => {
    if (mat.userData.loading) return;
    mat.userData.loading = true;
    loader.load(imageryBase + file, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = anisotropy;
      textures.push(t);
      mat.map = t;
      if (emissive) mat.emissiveMap = t;
      mat.needsUpdate = true;
      mat.userData.ready = true;
      if (mesh.userData.want === mat) mesh.material = mat;
    });
  };
  const setLayer = (l: BaseLayer) => {
    layer = l;
    const mat = l === 'sat' ? sat : l === 'street' ? street : stylised;
    mesh.userData.want = mat;
    if (mat === sat) load(sat, 'hawassa-sat.jpg', false);
    if (mat === street) load(street, 'hawassa-osm.jpg', true);
    // keep the current look until the image is in, so there is never a blank map
    if (mat === stylised || mat.userData.ready) mesh.material = mat;
  };
  return {
    mesh,
    setLayer,
    dispose() {
      geo.dispose();
      [stylised, sat, street].forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      void layer;
    },
  };
}

// ---------- water ----------
function polygonMesh(ring: Vec2[], mat: THREE.Material, y: number): THREE.Mesh {
  const shape = new THREE.Shape(ring.map((p) => { const s = worldToScene(p); return new THREE.Vector2(s.x, -s.z); }));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}

export interface RealWater { group: THREE.Group; setLayer(l: BaseLayer): void }

/** Lake Hawassa and the small lakes: see-through over imagery, solid on the stylised map. */
export function buildRealWater(): RealWater {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2f7f95, roughness: 0.15, metalness: 0.15, transparent: true, opacity: 0.35, depthWrite: false });
  const g = new THREE.Group();
  g.add(polygonMesh(LAKE, mat, WATER_LEVEL + 0.02));
  for (const w of OTHER_WATER) if (w.pts.length >= 3) g.add(polygonMesh(w.pts, mat, WATER_LEVEL + 0.02));
  return {
    group: g,
    setLayer(l) {
      mat.opacity = l === 'stylised' ? 0.9 : l === 'sat' ? 0.3 : 0;
      g.visible = l !== 'street';
    },
  };
}

// ---------- roads ----------
const ROAD_STYLE: Record<RoadClass, { color: number; opacity: number; lift: number }> = {
  // Google-hybrid style over satellite: main roads bright and warm, local roads light, tracks visible but quiet.
  trunk: { color: 0xffd75e, opacity: 1, lift: 0.36 },
  primary: { color: 0xffe28a, opacity: 1, lift: 0.34 },
  secondary: { color: 0xfff1c9, opacity: 0.95, lift: 0.32 },
  tertiary: { color: 0xffffff, opacity: 0.8, lift: 0.3 },
  minor: { color: 0xf2efe8, opacity: 0.55, lift: 0.28 },
  track: { color: 0xe6dcc8, opacity: 0.35, lift: 0.26 },
}
const RIBBON_M: Partial<Record<RoadClass, number>> = { trunk: 120, primary: 100, secondary: 70, tertiary: 40 };

/** Densify a polyline so it drapes over the terrain mesh instead of cutting through hills. */
export function densify(pts: Vec2[], stepM = 160): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / stepM);
      for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / (n + 1), y: a.y + ((b.y - a.y) * k) / (n + 1) });
    }
    out.push(pts[i]);
  }
  return out;
}

export interface RealRoads { group: THREE.Group; setLayer(l: BaseLayer): void }

/**
 * OSM roads, merged into one draw call per class: wide light ribbons for trunk/primary/secondary,
 * thin lines for the rest (tracks faint). About 9 draw calls in total.
 */
export function buildRealRoads(field: HeightField): RealRoads {
  const g = new THREE.Group();
  const mats: { mat: THREE.Material & { opacity: number }; base: number }[] = [];
  const classes: RoadClass[] = ['trunk', 'primary', 'secondary', 'tertiary', 'minor', 'track'];
  for (const cls of classes) {
    const st = ROAD_STYLE[cls];
    const roads = ROADS.filter((r) => r.cls === cls);
    const lineVerts: number[] = [];
    for (const r of roads) {
      const p = densify(r.pts);
      for (let i = 1; i < p.length; i++) {
        const a = worldToScene(p[i - 1]), b = worldToScene(p[i]);
        lineVerts.push(a.x, Math.max(field.heightAt(p[i - 1]), WATER_LEVEL) + st.lift, a.z, b.x, Math.max(field.heightAt(p[i]), WATER_LEVEL) + st.lift, b.z);
      }
    }
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
    const lmat = new THREE.LineBasicMaterial({ color: st.color, transparent: true, opacity: st.opacity, depthWrite: false });
    mats.push({ mat: lmat, base: st.opacity });
    const lines = new THREE.LineSegments(lgeo, lmat);
    lines.name = `roads-${cls}`;
    g.add(lines);
    const widthM = RIBBON_M[cls];
    if (!widthM) continue;
    // ribbons: one merged mesh per class
    const verts: number[] = [], idx: number[] = [];
    const half = (widthM / 2) * SCALE;
    for (const r of roads) {
      const p = densify(r.pts);
      const base = verts.length / 3;
      for (let i = 0; i < p.length; i++) {
        const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const sc = worldToScene(p[i]);
        const px = (-dy / len) * half, pz = -(dx / len) * half;
        const y = Math.max(field.heightAt(p[i]), WATER_LEVEL) + st.lift - 0.06;
        verts.push(sc.x + px, y, sc.z + pz, sc.x - px, y, sc.z - pz);
        if (i > 0) { const k = base + i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      }
    }
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    rgeo.setIndex(idx);
    const rmat = new THREE.MeshBasicMaterial({
      color: st.color, transparent: true, opacity: st.opacity * 0.8, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mats.push({ mat: rmat, base: st.opacity * 0.8 });
    const ribbon = new THREE.Mesh(rgeo, rmat);
    ribbon.name = `roads-${cls}-ribbon`;
    g.add(ribbon);
  }
  return {
    group: g,
    // the satellite already shows the roads, so the overlay is subtle there
    setLayer(l) { const k = l === 'sat' ? 1 : l === 'street' ? 0.3 : 1; for (const m of mats) m.mat.opacity = m.base * k; },
  };
}

// ---------- labels, attribution ----------
/** Places worth a label: every named place; cities get the big style. */
export function placeLabels(): { name: string; cls: string; pos: Vec2 }[] {
  return PLACES.map((p) => ({ name: p.name, cls: p.kind === 'city' ? 'town city' : p.kind === 'village' ? 'village small' : 'village small hamlet', pos: p.pos }));
}
export const LAKE_LABEL = { name: LAKE_NAME, pos: { ...LAKE_CENTROID } };

export function attributionElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'rl-attr';
  el.textContent = ATTRIBUTION;
  return el;
}

export const REAL_CSS = `
.rl.small { font-size: 10px; font-weight: 600; padding: 1px 6px; background: rgba(255, 249, 236, 0.62); }
.rl.hamlet { opacity: .75; }
.rl.city { font-size: 15px; font-weight: 800; padding: 3px 9px; background: rgba(255, 249, 236, 0.9); }
.rl-attr { position: absolute; right: 6px; bottom: 4px; max-width: 70%; font: 10px/1.3 system-ui, sans-serif; color: rgba(30, 30, 30, .78);
  background: rgba(255, 255, 255, .55); padding: 2px 6px; border-radius: 4px; pointer-events: none; text-align: right; z-index: 1; }
`;
