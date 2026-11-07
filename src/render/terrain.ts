// Static world: terrain, water, trees, roads, villages, buildings, hubs, cell grid and labels.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CELL_SIZE, WORLD_SIZE } from '../contracts/config';
import type { Vec2 } from '../contracts/types';
import {
  SCENE_SIZE, WATER_LEVEL, distToPolyline, hashString, mulberry32, sceneToWorld, waterDistance, worldToScene,
  type HeightField, type WaterShape,
} from './mapping';

const SEGMENTS = 220;

// Warm, sun-baked palette.
const C = {
  sand: new THREE.Color(0xd9c38f),
  grassLush: new THREE.Color(0x7d9a46),
  grassDry: new THREE.Color(0xa7a456),
  ochre: new THREE.Color(0xb88b4a),
  rock: new THREE.Color(0x8f7a62),
  water: 0x3f8fa0,
  road: 0xa9825a,
};

export function buildTerrain(field: HeightField): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(SCENE_SIZE, SCENE_SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const w = sceneToWorld(pos.getX(i), pos.getZ(i));
    const h = field.heightAt(w);
    pos.setY(i, h);
    // colour by height, closeness to water and a noise tint
    const wd = waterDistance(w, field.water);
    const tint = field.tint(w);
    if (h < 5) col.copy(C.grassLush).lerp(C.grassDry, tint * 0.7);
    else if (h < 10) col.copy(C.grassDry).lerp(C.ochre, (h - 5) / 5 * 0.8 + tint * 0.2);
    else col.copy(C.ochre).lerp(C.rock, Math.min(1, (h - 10) / 8));
    if (wd < 900) col.lerp(C.grassLush, 0.5 * (1 - wd / 900));       // greener near water
    if (wd < 380) col.lerp(C.sand, 1 - Math.max(0, wd - 120) / 260);   // sandy banks, soft edge
    colors.set([col.r, col.g, col.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 }));
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

export function buildWater(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(SCENE_SIZE, SCENE_SIZE, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: C.water, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.88 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = WATER_LEVEL;
  mesh.receiveShadow = true;
  return mesh;
}

/** Smooth river ribbon and lake disc just above the carved bed, so water edges are clean curves. */
export function buildRiverSurface(w: WaterShape): THREE.Group {
  const k = SCENE_SIZE / WORLD_SIZE;
  const half = (w.riverHalfWidth + 70) * k;
  const y = WATER_LEVEL + 0.32;
  const verts: number[] = [], idx: number[] = [];
  w.river.forEach((p, i) => {
    const a = w.river[Math.max(0, i - 1)], b = w.river[Math.min(w.river.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const sc = worldToScene(p);
    const px = (-dy / len) * half, pz = -(dx / len) * half;
    verts.push(sc.x + px, y, sc.z + pz, sc.x - px, y, sc.z - pz);
    if (i > 0) { const j = i * 2; idx.push(j - 2, j - 1, j, j - 1, j + 1, j); }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: C.water, roughness: 0.2, metalness: 0.1, side: THREE.DoubleSide });
  const river = new THREE.Mesh(geo, mat);
  const lake = new THREE.Mesh(new THREE.CircleGeometry((w.lake.radius + 70) * k, 64), mat);
  lake.rotation.x = -Math.PI / 2;
  const lc = worldToScene(w.lake.pos);
  lake.position.set(lc.x, y, lc.z);
  river.receiveShadow = lake.receiveShadow = true;
  const g = new THREE.Group();
  g.add(river, lake);
  return g;
}

/** Scattered low-poly trees, kept off water. Roads clear them later via clearTreesNear. */
export function buildTrees(field: HeightField, seed: number, count = 900): THREE.Group {
  const rng = mulberry32(seed ^ 0x7ee5);
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.16, 0.9, 5);
  trunkGeo.translate(0, 0.45, 0);
  const crownGeo = new THREE.ConeGeometry(0.9, 2.2, 6);
  crownGeo.translate(0, 1.9, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2e, flatShading: true }), count);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x5f7f35, flatShading: true }), count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const shade = new THREE.Color();
  const spots: Vec2[] = [];
  let n = 0;
  for (let tries = 0; n < count && tries < count * 6; tries++) {
    const w = { x: rng() * WORLD_SIZE, y: rng() * WORLD_SIZE };
    if (waterDistance(w, field.water) < 300) continue;
    // trees grow in clumps: favour places where the tint noise is high
    if (field.tint(w) < 0.45 && rng() < 0.8) continue;
    const sc = worldToScene(w);
    const k = 0.7 + rng() * 0.8;
    p.set(sc.x, field.heightAt(w) - 0.1, sc.z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
    s.set(k, k * (0.8 + rng() * 0.5), k);
    m.compose(p, q, s);
    trunks.setMatrixAt(n, m);
    crowns.setMatrixAt(n, m);
    crowns.setColorAt(n, shade.setHSL(0.22 + rng() * 0.06, 0.45, 0.28 + rng() * 0.1));
    spots.push(w);
    n++;
  }
  trunks.count = crowns.count = n;
  crowns.castShadow = true;
  const g = new THREE.Group();
  g.add(trunks, crowns);
  g.userData.spots = spots;
  return g;
}

/** Hide trees standing on a road or inside a village. */
export function clearTreesNear(trees: THREE.Group, paths: Vec2[][], centres: Vec2[], roadClear = 220, villageClear = 900): void {
  const spots = trees.userData.spots as Vec2[];
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const mesh of trees.children as THREE.InstancedMesh[]) {
    spots.forEach((w, i) => {
      const nearVillage = centres.some((c) => Math.hypot(c.x - w.x, c.y - w.y) < villageClear);
      const nearRoad = !nearVillage && paths.some((p) => distToPolyline(w, p) < roadClear);
      if (nearVillage || nearRoad) mesh.setMatrixAt(i, zero);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Dirt roads as flat ribbons draped over the terrain. */
export function buildRoads(field: HeightField, paths: Vec2[][], widthM = 140): THREE.Mesh {
  const verts: number[] = [];
  const idx: number[] = [];
  const half = (widthM / 2) * (SCENE_SIZE / WORLD_SIZE);
  for (const path of paths) {
    const base = verts.length / 3;
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      const sc = worldToScene(path[i]);
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      // perpendicular in world (x,y) -> scene (x,-z)
      const px = (-dy / len) * half, pz = -(dx / len) * half;
      const y = Math.max(field.heightAt(path[i]), WATER_LEVEL + 0.05) + 0.18;
      verts.push(sc.x + px, y, sc.z + pz, sc.x - px, y, sc.z - pz);
      // no road surface across open water (reads as a ford or ferry crossing)
      const wet = waterDistance(path[i], field.water) < 40 && waterDistance(path[i - 1] ?? path[i], field.water) < 40;
      if (i > 0 && !wet) {
        const k = base + i * 2;
        idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: C.road, roughness: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** Hut clusters: one instanced mesh for walls, one for thatched roofs. */
export function buildVillages(field: HeightField, villages: { pos: Vec2; huts: number; seed: number }[]): THREE.Group {
  const total = villages.reduce((s, v) => s + v.huts, 0);
  const wallGeo = new THREE.CylinderGeometry(0.55, 0.6, 0.7, 7);
  wallGeo.translate(0, 0.35, 0);
  const roofGeo = new THREE.ConeGeometry(0.85, 0.75, 7);
  roofGeo.translate(0, 1.05, 0);
  const walls = new THREE.InstancedMesh(wallGeo, new THREE.MeshStandardMaterial({ color: 0xd8b58a, flatShading: true }), total);
  const roofs = new THREE.InstancedMesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0x9a7240, flatShading: true }), total);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  let n = 0;
  for (const v of villages) {
    const rng = mulberry32(v.seed);
    for (let i = 0; i < v.huts; i++) {
      const ang = rng() * Math.PI * 2, r = 250 + Math.sqrt(rng()) * 650;
      const w = { x: v.pos.x + Math.cos(ang) * r, y: v.pos.y + Math.sin(ang) * r };
      if (waterDistance(w, field.water) < 120) w.x += 400;
      const sc = worldToScene(w);
      const k = 0.8 + rng() * 0.5;
      p.set(sc.x, field.heightAt(w) - 0.05, sc.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28);
      s.set(k, k, k);
      m.compose(p, q, s);
      walls.setMatrixAt(n, m);
      roofs.setMatrixAt(n, m);
      roofs.setColorAt(n, c.setHSL(0.09 + rng() * 0.03, 0.45, 0.35 + rng() * 0.1));
      n++;
    }
  }
  walls.castShadow = roofs.castShadow = true;
  const g = new THREE.Group();
  g.add(walls, roofs);
  return g;
}

/** Cell grid draped over the terrain (toggle with setGridVisible). */
export function buildGrid(field: HeightField): THREE.LineSegments {
  const pts: number[] = [];
  const step = 250;                                     // metres between samples along a line
  const push = (a: Vec2, b: Vec2) => {
    const sa = worldToScene(a), sb = worldToScene(b);
    pts.push(sa.x, Math.max(field.heightAt(a), WATER_LEVEL) + 0.3, sa.z, sb.x, Math.max(field.heightAt(b), WATER_LEVEL) + 0.3, sb.z);
  };
  for (let g = 0; g <= WORLD_SIZE; g += CELL_SIZE) {
    for (let t = 0; t < WORLD_SIZE; t += step) {
      push({ x: g, y: t }, { x: g, y: t + step });
      push({ x: t, y: g }, { x: t + step, y: g });
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xfff4dc, transparent: true, opacity: 0.35, depthWrite: false }));
  lines.visible = false;
  return lines;
}

/** Soft sky dome with a warm horizon. */
export function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1400, 32, 16);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x8fb8d8), horizon = new THREE.Color(0xf3dfbf), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 1400);
    c.copy(horizon).lerp(top, Math.pow(t, 0.6));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
}

// ---------- buildings and markers ----------
const std = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...extra });

export function setTowerUp(t: THREE.Group, up: boolean): void {
  (t.userData.mat as THREE.MeshStandardMaterial).color.set(up ? 0xd65a3a : 0x7a7a7a);
  const light = t.getObjectByName('beacon') as THREE.Mesh;
  (light.material as THREE.MeshBasicMaterial).color.set(up ? 0x7dffb0 : 0x444444);
  t.userData.up = up;
}

// ---------- real-size buildings (metres) ----------
// Built in real metres, origin at ground level, front facing +z. The renderer scales them per frame
// (true size close up, a readable minimum on screen when zoomed out), the same way it sizes carriers.
/** Box with its base at y0, centred on (x, z). Metres. */
function blk(w: number, h: number, d: number, mat: THREE.Material, x = 0, y0 = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y0 + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Gable roof: a triangular prism along x (length l, span w, ridge rise h), eaves at y0. */
function gable(l: number, w: number, h: number, mat: THREE.Material, y0: number, x = 0, z = 0): THREE.Mesh {
  const shape = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, h)]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: l, bevelEnabled: false });
  g.translate(0, 0, -l / 2);
  g.rotateY(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y0, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function cylinder(r: number, h: number, mat: THREE.Material, x: number, y0: number, z: number, seg = 10): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.position.set(x, y0 + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Real-world footprint (longest side, metres) and label/link height of each marker, for the renderer. */
export const MARKER_SIZE = {
  clinic: { len: 15, top: 11 },
  store: { len: 32, top: 10 },
  dispatch: { len: 14, top: 22 },
  hub: { len: 40, top: 7 },
  tower: { len: 30, top: 31 },
} as const;

/** Rural health post: whitewashed block with a painted band, tin gable roof, water tank, and a lit
 *  sign box with a green cross on every side so it reads from any direction. */
export function buildHealthPost(): THREE.Group {
  const g = new THREE.Group();
  const wall = std(0xf2ede3), band = std(0x2f8f83), tin = std(0x9ba4a9, { metalness: 0.55, roughness: 0.45 });
  const dark = std(0x283036, { roughness: 0.35 }), concrete = std(0xb9b2a4);
  g.add(blk(13, 6.4, 8, concrete, 0, -6));                                 // plinth, skirted below ground
  g.add(blk(12, 3.0, 7, wall, 0, 0.4));
  g.add(blk(12.06, 0.9, 7.06, band, 0, 0.4));
  g.add(gable(13, 8.4, 1.8, tin, 3.4));
  g.add(blk(1.2, 2.1, 0.1, dark, -1.4, 0.4, 3.52));                       // door
  g.add(blk(3.2, 0.14, 1.8, tin, -1.4, 2.8, 4.4));                         // porch roof
  for (const x of [-4.2, 1.4, 4.2]) g.add(blk(1.3, 1.0, 0.1, dark, x, 1.7, 3.52));
  for (const x of [-4.2, -1.4, 1.4, 4.2]) g.add(blk(1.3, 1.0, 0.1, dark, x, 1.7, -3.52));
  g.add(blk(1.9, 1.6, 1.9, std(0x6e6a62), 7.6, 0, -2.2));                  // tank stand
  g.add(cylinder(0.85, 1.7, std(0x1d1f22, { roughness: 0.6 }), 7.6, 1.6, -2.2, 14));
  // sign: pole + white box, green cross on all four faces
  g.add(cylinder(0.14, 8, std(0xcfd3d6, { metalness: 0.5, roughness: 0.4 }), 7.4, 0, 3.2, 8));
  const signY = 8 + 1.7;
  g.add(blk(3.4, 3.4, 3.4, std(0xf7f7f2, { emissive: 0xffffff, emissiveIntensity: 0.25 }), 7.4, 8, 3.2));
  const green = std(0x1f9d55, { emissive: 0x0f7a3a, emissiveIntensity: 0.6 });
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2, ox = Math.sin(a) * 1.72, oz = Math.cos(a) * 1.72;
    const bar = blk(2.4, 0.8, 0.08, green, 7.4 + ox, signY - 0.4, 3.2 + oz);
    const post = blk(0.8, 2.4, 0.08, green, 7.4 + ox, signY - 1.2, 3.2 + oz);
    bar.rotation.y = post.rotation.y = a;
    g.add(bar, post);
  }
  return g;
}

/** Medical store: corrugated warehouse with two roller doors, a concrete apron and stacked crates. */
export function buildWarehouse(): THREE.Group {
  const g = new THREE.Group();
  const wall = std(0xd8c39b), tin = std(0x8e999e, { metalness: 0.5, roughness: 0.5 }), door = std(0x4c545a, { metalness: 0.4 });
  const concrete = std(0xbab4a8), crate = std(0xb98d55, { roughness: 0.9 });
  g.add(blk(32, 6.3, 26, concrete, 0, -6, 3));                             // apron, skirted below ground
  g.add(blk(28, 6, 16, wall, 0, 0.3));
  g.add(gable(29.4, 17.4, 2.4, tin, 6.3));
  for (const x of [-6.5, 6.5]) g.add(blk(5, 4.6, 0.12, door, x, 0.3, 8.02));
  g.add(blk(1.1, 2.2, 0.12, door, 12, 0.3, 8.02));
  g.add(blk(28.2, 0.5, 16.2, std(0x2f8f83), 0, 5.6));                      // painted fascia band
  for (const [x, z, n] of [[-1.5, 11, 3], [0, 11.8, 2], [1.5, 11, 1], [-12, 10.5, 2]] as const) {
    for (let k = 0; k < n; k++) g.add(blk(1.2, 1.1, 1.2, crate, x, 0.3 + k * 1.1, z));
  }
  return g;
}

/** Dispatch (central mode only): an office block with a tall mast and a dish. */
export function buildDispatchOffice(): THREE.Group {
  const g = new THREE.Group();
  g.add(blk(14, 13, 10, std(0x5b6670), 0, -6));
  g.add(blk(14.2, 0.4, 10.2, std(0x3e464d), 0, 7));
  for (const x of [-4.5, 0, 4.5]) g.add(blk(2.4, 1.4, 0.1, std(0x23303a, { roughness: 0.3 }), x, 3.6, 5.02));
  g.add(cylinder(0.25, 15, std(0xcccccc, { metalness: 0.5 }), 4, 7.4, -2, 8));
  const dish = new THREE.Mesh(new THREE.SphereGeometry(2.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0xeeeeee));
  dish.rotation.x = Math.PI / 2.5;
  dish.position.set(-3, 9.5, 0);
  dish.castShadow = true;
  g.add(dish);
  return g;
}

/** Relay hub: a fenced gravel yard with a drone pad, a container store and a small solar array. */
export function buildHubYard(): THREE.Group {
  const g = new THREE.Group();
  const gravel = std(0xc8b48a), metal = std(0x9aa0a4, { metalness: 0.6, roughness: 0.4 });
  g.add(blk(40, 8.25, 40, gravel, 0, -8));                                 // yard, skirted below ground
  // chain-link fence: posts, top rail and a see-through mesh panel; gap for the gate on the front (+z)
  const mesh = new THREE.MeshStandardMaterial({ color: 0x8a9196, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  const side = (x: number, z: number, len: number, rotY: number) => {
    const s = new THREE.Group();
    const panel = blk(len, 2, 0.04, mesh, 0, 0.25);
    panel.castShadow = false;                               // see-through mesh: no solid shadow
    s.add(panel, blk(len, 0.08, 0.08, metal, 0, 2.2));
    for (let p = -len / 2; p <= len / 2 + 1e-6; p += len / Math.max(1, Math.round(len / 5))) s.add(blk(0.12, 2.3, 0.12, metal, p, 0.25));
    s.position.set(x, 0, z);
    s.rotation.y = rotY;
    g.add(s);
  };
  side(0, -20, 40, 0); side(-20, 0, 40, Math.PI / 2); side(20, 0, 40, Math.PI / 2);
  side(-11.5, 20, 17, 0); side(11.5, 20, 17, 0);
  // drone pad: concrete disc with a painted ring
  g.add(cylinder(7, 0.15, std(0xd9d5cc), 0, 0.25, 2, 28));
  const ring = new THREE.Mesh(new THREE.RingGeometry(5, 5.8, 40), std(0xf2c230, { emissive: 0x6a5000, emissiveIntensity: 0.3 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 0.42, 2);
  ring.receiveShadow = true;
  g.add(ring);
  // container store, charging cabinet, solar array
  g.add(blk(6.1, 2.6, 2.4, std(0x2f5d8a, { metalness: 0.3, roughness: 0.6 }), -12, 0.25, -15));
  g.add(blk(1.2, 1.8, 0.8, std(0xdedfd8), -7.5, 0.25, -16));
  for (const x of [8, 14]) {
    const panel = blk(5, 0.12, 3, std(0x1d2c4a, { metalness: 0.4, roughness: 0.25 }), x, 1.6, -15);
    panel.rotation.x = -0.35;
    g.add(panel, blk(0.15, 1.6, 0.15, metal, x, 0.25, -14.2), blk(0.15, 2.2, 0.15, metal, x, 0.25, -15.8));
  }
  return g;
}

/** Cell tower: 30 m lattice mast with antennas and a beacon light. Call setTowerUp to grey it out. */
export function buildMast(): THREE.Group {
  const g = new THREE.Group();
  const mat = std(0xd65a3a, { metalness: 0.4 });
  const H = 30, rb = 2.2, rt = 0.6;
  const corner = (i: number, y: number) => {
    const a = (i / 3) * Math.PI * 2, r = rb + (rt - rb) * (y / H);
    return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  };
  const strut = (a: THREE.Vector3, b: THREE.Vector3, r: number) => {
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 5), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = true;
    g.add(m);
  };
  for (let i = 0; i < 3; i++) {
    strut(corner(i, 0), corner(i, H), 0.16);
    for (let y = 5; y < H; y += 5) strut(corner(i, y), corner(i + 1, y), 0.06);
    for (let y = 0; y < H; y += 5) strut(corner(i, y), corner(i + 1, y + 5), 0.05);
  }
  const white = std(0xf0f0ec);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 3;
    const ant = blk(0.5, 2.6, 0.25, white, Math.cos(a) * 0.9, H - 3.4, Math.sin(a) * 0.9);
    ant.rotation.y = -a;
    g.add(ant);
  }
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), new THREE.MeshBasicMaterial({ color: 0x7dffb0 }));
  light.position.y = H + 0.9;
  light.name = 'beacon';
  g.add(light);
  g.userData.mat = mat;
  return g;
}

export function makeLabel(text: string, cls: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = `rl ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

/** Label CSS, injected once. */
export const LABEL_CSS = `
.rl { font: 600 12px/1.2 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #2b2418; white-space: nowrap;
  padding: 2px 7px; border-radius: 10px; background: rgba(255, 249, 236, 0.82); box-shadow: 0 1px 4px rgba(60, 40, 10, 0.25);
  pointer-events: none; user-select: none; transform: translateY(-14px); letter-spacing: .01em; }
.rl.village { background: rgba(255, 249, 236, 0.72); font-weight: 600; }
.rl.clinic { color: #0f5e55; }
.rl.store { color: #7a4a12; }
.rl.hub { color: #6b5520; background: rgba(255, 244, 214, 0.7); font-weight: 500; font-size: 11px; }
.rl.geo { background: none; box-shadow: none; color: rgba(30, 70, 90, 0.75); font-style: italic; font-weight: 500; }
.rl.town { font-size: 13px; font-weight: 700; }
.rl.node { font-size: 11px; font-weight: 600; background: rgba(30, 30, 30, 0.75); color: #fff; }
.rl.node.fake { background: rgba(170, 30, 30, 0.85); }
.rl.node.hl { background: rgba(214, 140, 20, 0.92); }
/* district labels fade out at country zoom (the renderer sets --dfade / --dvis on the overlay) */
.rl.dl { opacity: var(--dfade, 1); visibility: var(--dvis, visible); }
`;

// ---------- helpers ----------
export const seedOf = (id: string): number => hashString(id);
