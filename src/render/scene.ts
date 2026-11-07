// The 3D view. Draws the district and everything in a Snapshot. Carriers are the procedural models in
// ./models, moved by one motion smoother each (sim samples in, smooth 60 fps motion out).
// The renderer is omniscient (it shows stores and every node); agents never see any of this.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CELL_COVERAGE, DEMO_SEED, WORLD_SIZE } from '../contracts/config';
import type { CarrierKind, NodeId, NodeKind, NodeState, RendererApi, Snapshot, Tool, Vec2 } from '../contracts/types';
import {
  HUB_NAMES, LAKE_NAME, MARKET_NAME, RIVER_NAME, SCALE, SCENE_SIZE, TOWN_NAME, VILLAGE_NAMES, WATER_LEVEL,
  clampToWorld, damp, hashString, makeHeightField, roadEdges, roadPath, worldToScene,
  type WaterShape,
} from './mapping';
import {
  LABEL_CSS, MARKER_SIZE, buildDispatchOffice, buildGrid, buildHealthPost, buildHubYard, buildMast, buildRoads, buildTerrain, buildWarehouse,
  buildRiverSurface, buildTrees, buildVillages, buildWater, clearTreesNear, makeLabel, setTowerUp,
} from './terrain';
import { TRAIL_COLORS, Trail, buildRing } from './entities';
import { createCarrierModel, createMotionSmoother, scaleForDistance, sharedMats, type CarrierModel, type MotionSmoother } from './models';
import { createGroundSampler } from './ground';
import { StormLayer, buildZonePreview } from './zones';
import { Picker } from './picking';
import {
  LAKE_LABEL, REAL_CSS, attributionElement, buildRealRoads, buildRealTerrain, buildRealWater, makeRealField, placeLabels,
  type BaseLayer,
} from './realmap';
import { LAKE, nearestPlace } from '../geo';
import { BACKDROP, ensureModelEnvironment } from './look';
import { attachCountryLayer, styleDistrictRoads } from './country';

/** Optional real geometry from the sim (WP1 world.ts) so water and roads line up with movement. */
export interface RenderWorld {
  water?: WaterShape;
  roads?: Vec2[][];
  villages?: { name: string; pos: Vec2 }[];
}
export interface RendererOptions {
  seed?: number;
  world?: RenderWorld;
  /** 'hawassa' draws the real map (DEM terrain, satellite image, Lake Hawassa, OSM roads). Default 'fictional'. */
  map?: 'fictional' | 'hawassa';
  baseLayer?: BaseLayer;                                // real map only; default 'sat'
  imageryBase?: string;                                 // where hawassa-sat.jpg / hawassa-osm.jpg are served; default '/geo/'
  coverage?: { pos: Vec2; radius: number }[];           // cell towers; default CELL_COVERAGE (pass the real map's)
  hubNames?: Record<string, string>;                    // label text per hub id
  /** Smaller shadow map and pixel ratio 1, for two renderers side by side. */
  lowPower?: boolean;
  /** Share one CameraLink between renderers so they move together. */
  cameraLink?: CameraLink;
}

export interface CameraView { position: [number, number, number]; target: [number, number, number] }

/** Keeps several renderers' cameras in step (split screen). Create one with createCameraLink(). */
export interface CameraLink {
  join(id: number, apply: (v: CameraView) => void): void;
  leave(id: number): void;
  publish(id: number, v: CameraView): void;
}

export function createCameraLink(): CameraLink {
  const members = new Map<number, (v: CameraView) => void>();
  return {
    join(id, apply) { members.set(id, apply); },
    leave(id) { members.delete(id); },
    publish(id, v) { for (const [k, apply] of members) if (k !== id) apply(v); },
  };
}

/** Extras beyond the frozen RendererApi. All optional for the lead to use. */
export interface RendererExtras {
  setGridVisible(v: boolean): void;
  toggleGrid(): boolean;
  setLabelsVisible(v: boolean): void;
  focus(id: NodeId): void;                              // glide the camera to a node
  onZoneDraw(cb: (pos: Vec2, radiusM: number) => void): void; // dead-zone tool: drag sets the radius
  /** Real map only: base layer (satellite, street map, stylised). No-op on the fictional map. */
  setBaseLayer(l: BaseLayer): void;
  getBaseLayer(): BaseLayer;
  setRoadsVisible(v: boolean): void;
  toggleRoads(): boolean;
  getCamera(): CameraView;
  setCamera(v: CameraView): void;
  onCameraChange(cb: (v: CameraView) => void): void;
}
export type Renderer = RendererApi & RendererExtras;

const CARRIERS: ReadonlySet<NodeKind> = new Set(['drone', 'motorbike', 'van', 'boat']);
const JUMP_M = 4000;                                    // a bigger jump between snapshots = teleport, no gliding
// One size rule for every carrier: they all share the display multiplier that keeps a van (5.4 m) at least
// SIZE_REF_PX long on screen, so real relative sizes hold at every zoom (drone 3.4 m span, motorbike 2 m, boat 5.6 m).
const SIZE_REF_PX = 54;
// Buildings, hubs and towers are real size close up and keep a readable minimum on screen when zoomed out,
// tied to the carrier rule so the two stay in proportion if SIZE_REF_PX changes.
const MARKER_PX = { clinic: 0.7, store: 0.85, dispatch: 0.7, hub: 0.8, tower: 0.95 } as const;
type MarkerKind = keyof typeof MARKER_PX;
const markerKindOf = (k: NodeKind): MarkerKind => (k === 'clinic' || k === 'store' || k === 'dispatch' ? k : 'clinic');
const WATER_TOP = WATER_LEVEL + 0.02;                   // the drawn lake surface
// Country zoom: past 2 district widths the district's labels, trails and links fade out (gone by 3), and
// carriers / markers stop growing past 1.5 widths (just beyond the default whole-district view), so far
// out they shrink to a few pixels instead of turning into giant icons.
const FADE_FROM = 2 * SCENE_SIZE, FADE_TO = 3 * SCENE_SIZE;
const SIZE_CAP_DIST = 1.5 * SCENE_SIZE;
const FRAME_TILT = 0.38;                                // default view: radians away from straight down

interface Ent {
  id: NodeId;
  kind: NodeKind;
  root: THREE.Group;                                    // buildings: the marker; carriers: ground point under the model
  body: THREE.Group | null;                             // buildings only
  model: CarrierModel | null;                           // carriers only: owns height, rotation, scale and looks
  sm: MotionSmoother | null;
  ring: THREE.Mesh;                                     // selection
  hlRing: THREE.Mesh;                                   // highlight (leak finder)
  fakeRing: THREE.Mesh;
  ringBase: number;                                     // ring scale before the pulse
  pick: THREE.Mesh;
  label: CSS2DObject;
  trail: Trail | null;
  last: Vec2;                                           // position in the last snapshot
  anchor: THREE.Vector3;                                // where links attach, scene space
  normal: THREE.Vector3;                                // terrain normal under a ground vehicle
  alive: boolean; fake: boolean; boxes: number;
  alt: number | undefined; phase: NodeState['phase'];
  look: 'normal' | 'dead' | 'fake';
  orig: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
}

let rendererSeq = 0;                                     // id for camera links only; no shared scene state

export function createRenderer(canvas: HTMLCanvasElement, opts: RendererOptions = {}): Renderer {
  const seed = opts.seed ?? DEMO_SEED;
  const real = opts.map === 'hawassa';
  const instanceId = ++rendererSeq;
  const coverage = opts.coverage ?? CELL_COVERAGE;
  // per-renderer materials: two renderers on one page never share mutable three.js objects
  const deadMat = new THREE.MeshStandardMaterial({ color: 0x7c7c7c, flatShading: true, roughness: 1 });
  const fakeMat = new THREE.MeshStandardMaterial({ color: 0xc8322a, flatShading: true, roughness: 0.6, emissive: 0x5a0a06, emissiveIntensity: 0.6 });
  const field = real ? makeRealField(opts.world?.water?.river) : makeHeightField(seed, opts.world?.water);
  const groundAt = (p: Vec2) => Math.max(field.heightAt(p), WATER_LEVEL);

  // ---------- three basics ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(opts.lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  // the map floats on a deep neutral dark in both map modes: no sky dome, no light margin
  renderer.setClearColor(BACKDROP, 1);
  scene.background = new THREE.Color(BACKDROP);
  scene.fog = new THREE.Fog(BACKDROP, 900, 2600);

  const camera = new THREE.PerspectiveCamera(42, 1, 1, 3000);
  // default view: the whole district with a slight tilt (refined on the first snapshot)
  camera.position.set(0, 520, 210);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enablePan = true;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 1.3;
  controls.minDistance = 0.12;                          // ~12 m: close enough to see a carrier model up close
  controls.maxDistance = 1800;
  controls.screenSpacePanning = false;

  // warm late-morning sun with a soft sky fill
  scene.add(new THREE.HemisphereLight(0xfff1d6, 0x6b6a3a, 1.25));
  const sun = new THREE.DirectionalLight(0xffe0b0, 2.6);
  sun.position.set(-180, 260, 140);
  sun.castShadow = true;
  sun.shadow.mapSize.set(opts.lowPower ? 1024 : 2048, opts.lowPower ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -230, right: 230, top: 230, bottom: -230, near: 10, far: 800 });
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target);

  // ---------- labels overlay (DOM, crisp text) ----------
  const labels = new CSS2DRenderer();
  // zIndex 0 makes a stacking context, so the per-label z-indexes never rise above the UI layer
  Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '0' });
  canvas.insertAdjacentElement('afterend', labels.domElement);
  if (!document.getElementById('runners-label-css')) {
    const st = document.createElement('style');
    st.id = 'runners-label-css';
    st.textContent = LABEL_CSS + REAL_CSS;
    document.head.appendChild(st);
  }
  const addLabel = (text: string, cls: string, p: Vec2, y: number) => {
    const l = makeLabel(text, `${cls} dl`);
    const sc = worldToScene(p);
    l.position.set(sc.x, y, sc.z);
    scene.add(l);
    return l;
  };

  // ---------- static world ----------
  let baseLayer: BaseLayer = opts.baseLayer ?? 'sat';
  let roadsOn = true;
  const realTerrain = real ? buildRealTerrain(field, opts.imageryBase ?? '/geo/', renderer.capabilities.getMaxAnisotropy()) : null;
  const realWater = real ? buildRealWater() : null;
  const realRoads = real ? buildRealRoads(field) : null;
  const roadStyle = realRoads ? styleDistrictRoads(realRoads.group) : null;   // crisp screen-space road lines
  const terrain = realTerrain ? realTerrain.mesh : buildTerrain(field);
  scene.add(terrain);
  let trees: THREE.Group | null = null;
  if (realTerrain) {
    scene.add(realWater!.group, realRoads!.group);
  } else {
    scene.add(buildWater(), buildRiverSurface(field.water));
    trees = buildTrees(field, seed);
    scene.add(trees);
  }
  const grid = buildGrid(field);
  scene.add(grid);
  const applyLayer = () => {
    if (!realTerrain) return;
    realTerrain.setLayer(baseLayer);
    realWater!.setLayer(baseLayer);
    realRoads!.setLayer(baseLayer);
    roadStyle?.setLayer(baseLayer);
    realRoads!.group.visible = roadsOn;
  };
  applyLayer();
  // carriers sit on the terrain exactly as drawn (the analytic field can float above the coarse mesh)
  const ground = createGroundSampler(terrain);
  const groundUnder = (x: number, z: number) => Math.max(ground.height(x, z), WATER_TOP);
  // Real map: the district sits inside real region + country satellite imagery; zoom out to all of Ethiopia.
  const country = real ? attachCountryLayer({ scene, camera, controls, renderer, unitsPerMetre: SCALE, districtSize: WORLD_SIZE,
    toScene: (x, y) => { const sc = worldToScene({ x, y }); return new THREE.Vector3(sc.x, groundAt({ x, y }), sc.z); } }) : null;
  const sm0 = sharedMats();
  ensureModelEnvironment([sm0.base, sm0.dead, sm0.highlight, sm0.intruder]);

  // geography labels
  const placeLabelObjs: { l: CSS2DObject; pos: Vec2 }[] = [];
  if (real) {
    addLabel(LAKE_LABEL.name, 'geo', LAKE_LABEL.pos, WATER_LEVEL + 2);
    for (const p of placeLabels()) placeLabelObjs.push({ l: addLabel(p.name, p.cls, p.pos, groundAt(p.pos) + 4), pos: p.pos });
  } else {
    const riverMid = field.water.river[Math.floor(field.water.river.length * 0.2)];
    addLabel(RIVER_NAME, 'geo', riverMid, WATER_LEVEL + 2);
    addLabel(LAKE_NAME, 'geo', field.water.lake.pos, WATER_LEVEL + 2);
  }
  const attribution = real ? attributionElement() : null;
  if (attribution) labels.domElement.insertAdjacentElement('afterend', attribution);

  // cell towers sit at the coverage centres; a faint ring shows each coverage area
  const towers = coverage.map((c) => {
    const t = buildMast();
    const sc = worldToScene(c.pos);
    t.position.set(sc.x + 3, groundUnder(sc.x + 3, sc.z - 3), sc.z - 3);
    const ring = coverageRing(c.pos, c.radius);
    t.userData.ring = ring;
    scene.add(t, ring);
    setTowerUp(t, true);
    return t;
  });
  if (!real) {
    addLabel(TOWN_NAME, 'village town', coverage[0].pos, groundAt(coverage[0].pos) + 9);
    if (coverage[1]) addLabel(MARKET_NAME, 'village', coverage[1].pos, groundAt(coverage[1].pos) + 9);
  }

  function coverageRing(pos: Vec2, radius: number): THREE.LineLoop {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const w = clampToWorld({ x: pos.x + Math.cos(a) * radius, y: pos.y + Math.sin(a) * radius });
      const sc = worldToScene(w);
      pts.push(new THREE.Vector3(sc.x, groundAt(w) + 0.5, sc.z));
    }
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0x9dffc4, dashSize: 2.5, gapSize: 1.8, transparent: true, opacity: 0.7 }),
    );
    line.computeLineDistances();
    return line;
  }

  // settlements (roads, villages, hubs) are built once, when the first snapshot tells us where nodes sit
  let settled = false;
  let hubsBuilt = false;
  function buildSettlements(s: Snapshot): void {
    const stores = s.nodes.filter((n) => n.kind === 'store');
    const clinics = s.nodes.filter((n) => n.kind === 'clinic').sort((a, b) => a.id.localeCompare(b.id));
    if (!clinics.length) return;
    settled = true;
    if (real) {
      // real roads are already drawn; the clinic label carries the village name, so drop the duplicate
      for (const p of placeLabelObjs) p.l.visible = !clinics.some((c) => Math.hypot(c.pos.x - p.pos.x, c.pos.y - p.pos.y) < 1200);
      return;
    }
    const places: Vec2[] = [...stores.map((n) => n.pos), ...clinics.map((n) => n.pos), ...s.hubs.map((h) => h.pos), ...coverage.map((c) => c.pos)];
    const paths = opts.world?.roads ?? roadEdges(places).map(([a, b]) => roadPath(places[a], places[b], a * 131 + b));
    scene.add(buildRoads(field, paths));
    const villages = [
      ...clinics.map((c) => ({ pos: c.pos, huts: 9 + (hashString(c.id) % 5), seed: hashString(c.id) })),
      ...coverage.map((c, i) => ({ pos: c.pos, huts: i === 0 ? 30 : 16, seed: seed + i })),
    ];
    scene.add(buildVillages(field, villages));
    if (trees) clearTreesNear(trees, paths, [...places, ...villages.map((v) => v.pos)]);
  }

  const hubObjs: THREE.Group[] = [];
  // Hub yards and store aprons are seated on the high side of their footprint, so a carrier standing
  // inside one stands on its surface instead of the terrain beneath it.
  const pads: { obj: THREE.Object3D; halfM: number; topM: number }[] = [];
  function padTop(x: number, z: number): number {
    let top = -Infinity;
    for (const p of pads) {
      const k = p.obj.scale.x, r = p.halfM * k;
      if (Math.abs(x - p.obj.position.x) < r && Math.abs(z - p.obj.position.z) < r) top = Math.max(top, p.obj.position.y + p.topM * k);
    }
    return top;
  }
  function buildHubs(s: Snapshot): void {
    if (hubsBuilt || !s.hubs.length) return;
    hubsBuilt = true;
    s.hubs.forEach((h, i) => {
      const g = buildHubYard();
      const sc = worldToScene(h.pos);
      g.position.set(sc.x, groundUnder(sc.x, sc.z), sc.z);
      g.rotation.y = (hashString(h.id) % 628) / 100;
      const name = opts.hubNames?.[h.id] ?? (real ? nearestPlace(h.pos, 6000)?.name : undefined);
      const l = makeLabel(real ? `${name ? `${name} hub` : 'Relay hub'} · ${h.id}` : `${HUB_NAMES[i % HUB_NAMES.length]} · ${h.id}`, 'hub dl');
      l.position.y = MARKER_SIZE.hub.top;
      g.add(l);
      scene.add(g);
      hubObjs.push(g);
      pads.push({ obj: g, halfM: 18, topM: 0.25 });
    });
  }

  // ---------- entities ----------
  const ents = new Map<NodeId, Ent>();
  const entLayer = new THREE.Group();
  const trailLayer = new THREE.Group();
  scene.add(entLayer, trailLayer);
  const pickGeo = new THREE.SphereGeometry(2.6, 8, 6);
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  let villageIdx = 0;

  function nameFor(n: NodeState): string {
    if (n.kind === 'clinic') {
      const v = opts.world?.villages?.find((v) => Math.hypot(v.pos.x - n.pos.x, v.pos.y - n.pos.y) < 1500)
        ?? (real ? nearestPlace(n.pos, 1500) : null);
      return `${v?.name ?? VILLAGE_NAMES[villageIdx++ % VILLAGE_NAMES.length]} clinic`;
    }
    if (n.kind === 'store') return n.id.replace(/^store-?/i, 'Store ');
    if (n.kind === 'dispatch') return 'Dispatch server';
    return n.id;
  }

  function createEnt(n: NodeState): Ent {
    const carrier = CARRIERS.has(n.kind);
    const root = new THREE.Group();
    let body: THREE.Group | null = null;
    let model: CarrierModel | null = null;
    let sm: MotionSmoother | null = null;
    const spin = (hashString(n.id) % 628) / 100;
    if (carrier) {
      model = createCarrierModel(n.kind as CarrierKind, { unitsPerMetre: SCALE, seed: hashString(n.id) });
      entLayer.add(model.object);
      sm = createMotionSmoother({ teleportDist: JUMP_M });
      sm.snap(n.pos.x, n.pos.y, n.alt ?? 0, n.heading ?? spin);
    } else {
      body = n.kind === 'clinic' ? buildHealthPost() : n.kind === 'store' ? buildWarehouse() : buildDispatchOffice();
      if (n.kind === 'store') pads.push({ obj: root, halfM: 14, topM: 0.3 });
      body.rotation.y = spin;
      root.add(body);
    }
    const ring = buildRing(0xffffff), hlRing = buildRing(0xffb020), fakeRing = buildRing(0xff3b30);
    root.add(ring, hlRing, fakeRing);
    const pick = new THREE.Mesh(pickGeo, pickMat);
    pick.userData.nodeId = n.id;
    const size = MARKER_SIZE[markerKindOf(n.kind)];
    if (!carrier) { pick.position.y = size.top * 0.4; pick.scale.setScalar((size.len * 0.6) / 2.6); }
    root.add(pick);
    const label = makeLabel(nameFor(n), carrier ? 'node dl' : `${n.kind} dl`);
    label.position.y = size.top + 1;
    label.visible = !carrier;
    root.add(label);
    const orig = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    body?.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) orig.set(m, m.material); });
    const sc = worldToScene(n.pos);
    root.position.set(sc.x, groundUnder(sc.x, sc.z), sc.z);
    const e: Ent = {
      id: n.id, kind: n.kind, root, body, model, sm, ring, hlRing, fakeRing, ringBase: carrier ? 1 : (size.len * 0.7) / 1.5, pick, label,
      trail: carrier ? new Trail(TRAIL_COLORS[n.kind as CarrierKind]) : null,
      last: { ...n.pos }, anchor: root.position.clone(),
      normal: new THREE.Vector3(0, 1, 0),
      alive: true, fake: false, boxes: 0, alt: undefined, phase: undefined, look: 'normal', orig,
    };
    entLayer.add(root);
    if (e.trail) { (e.trail.line.material as THREE.LineBasicMaterial).opacity = districtFade; trailLayer.add(e.trail.line); }
    return e;
  }

  /** Buildings only: carriers' looks belong to their model. */
  function setLook(e: Ent, look: Ent['look']): void {
    if (e.look === look) return;
    e.look = look;
    for (const [m, mat] of e.orig) m.material = look === 'normal' ? mat : look === 'dead' ? deadMat : fakeMat;
    e.label.element.classList.toggle('fake', look === 'fake');
  }

  function removeEnt(e: Ent): void {
    e.model?.dispose();                                 // detaches it; the shared model assets stay for other renderers
    const pi = pads.findIndex((p) => p.obj === e.root);
    if (pi >= 0) pads.splice(pi, 1);
    entLayer.remove(e.root);
    e.root.remove(e.label);                             // detaches the DOM element via CSS2DObject's 'removed' hook
    for (const r of [e.ring, e.hlRing, e.fakeRing]) { r.geometry.dispose(); (r.material as THREE.Material).dispose(); }
    if (e.trail) { trailLayer.remove(e.trail.line); e.trail.line.geometry.dispose(); (e.trail.line.material as THREE.Material).dispose(); }
    ents.delete(e.id);
  }

  // ---------- links ----------
  const MAX_LINKS = 800;
  const linkPos = new Float32Array(MAX_LINKS * 6);
  const linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3).setUsage(THREE.DynamicDrawUsage));
  const linkLines = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: 0x1798b8, transparent: true, opacity: 0.7, depthWrite: false }));
  linkLines.frustumCulled = false;
  scene.add(linkLines);
  let links: [NodeId, NodeId][] = [];

  // ---------- zones ----------
  const storms = new StormLayer();
  scene.add(storms.group);
  const zonePreview = buildZonePreview();
  scene.add(zonePreview);

  // ---------- state ----------
  let lastT = -Infinity;
  let tool: Tool = 'select';
  let selected: NodeId | null = null;
  let highlighted = new Set<NodeId>();
  let networkUp = true;
  const selectCbs: ((id: NodeId | null) => void)[] = [];
  const groundCbs: ((pos: Vec2, tool: Tool) => void)[] = [];
  const nodeCbs: ((id: NodeId, tool: Tool) => void)[] = [];
  const zoneCbs: ((pos: Vec2, r: number) => void)[] = [];
  let focusGoal: THREE.Vector3 | null = null;

  const picker = new Picker({
    canvas, camera, controls, terrain,
    pickables: () => [...ents.values()].map((e) => e.pick),
    tool: () => tool,
    nodeClick: (id) => {
      if (tool === 'select') { selected = id; selectCbs.forEach((cb) => cb(id)); }
      nodeCbs.forEach((cb) => cb(id, tool));
    },
    groundClick: (pos) => {
      if (tool === 'select' && selected) { selected = null; selectCbs.forEach((cb) => cb(null)); }
      groundCbs.forEach((cb) => cb(pos, tool));
    },
    zoneDraw: (pos, r) => { zoneCbs.forEach((cb) => cb(pos, r)); return zoneCbs.length > 0; },
    zonePreview: (c, r) => {
      zonePreview.visible = !!c;
      if (c) { zonePreview.position.set(c.x, c.y + 15, c.z); zonePreview.scale.set(Math.max(r, 0.5), 1, Math.max(r, 0.5)); }
    },
  });

  // ---------- default framing: the whole district ----------
  let camTouched = false;                               // the user (or a linked view) moved the camera
  let framePts: Vec2[] | null = null;
  controls.addEventListener('start', () => { camTouched = true; });
  /** Fit the camera to these world points, looking north with a slight tilt. */
  function frameOn(pts: Vec2[]): void {
    framePts = pts;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of pts) {
      const sc = worldToScene(p);
      x0 = Math.min(x0, sc.x); x1 = Math.max(x1, sc.x); z0 = Math.min(z0, sc.z); z1 = Math.max(z1, sc.z);
    }
    if (!Number.isFinite(x0)) return;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const halfW = (x1 - x0) / 2 + 14, halfH = (z1 - z0) / 2 + 14;    // ~1.4 km margin
    const t = Math.tan((camera.fov * Math.PI) / 360), tc = Math.cos(FRAME_TILT), ts = Math.sin(FRAME_TILT);
    // the near (south) edge is closest to the camera, so it bounds both directions
    const d = (Math.max((halfH * tc) / t, halfW / (t * Math.max(0.3, camera.aspect))) + halfH * ts) * 1.04;
    controls.maxDistance = Math.max(controls.maxDistance, d * 1.5);
    const ty = groundUnder(cx, cz);
    controls.target.set(cx, ty, cz);
    camera.position.set(cx, ty + d * tc, cz + d * ts);
    focusGoal = null;
  }
  const districtPts = (s?: Snapshot): Vec2[] => {
    const pts: Vec2[] = coverage.map((c) => c.pos);
    if (real) for (let i = 0; i < LAKE.length; i += 8) pts.push(LAKE[i]);
    if (s) {
      for (const n of s.nodes) if (!CARRIERS.has(n.kind)) pts.push(n.pos);
      for (const h of s.hubs) pts.push(h.pos);
    }
    return pts;
  };

  // ---------- update from a snapshot ----------
  function update(s: Snapshot): void {
    const wall = performance.now() / 1000;
    const reset = s.t < lastT;
    if (s.t !== lastT) simMovedAt = wall;
    lastT = s.t;
    if (!settled) {
      buildSettlements(s);
      if (settled && !camTouched) frameOn(districtPts(s));
    }
    buildHubs(s);
    const seen = new Set<NodeId>();
    for (const n of s.nodes) {
      seen.add(n.id);
      let e = ents.get(n.id);
      if (!e) { e = createEnt(n); ents.set(n.id, e); }
      e.alive = n.alive;
      e.fake = !!n.fake;
      e.boxes = n.boxes.length;
      if (e.sm && e.model) {
        // samples are keyed by SIM time, so relative speeds stay true however bursty the snapshots are
        if (reset || Math.hypot(n.pos.x - e.last.x, n.pos.y - e.last.y) > JUMP_M) e.trail?.clear();
        e.sm.push(s.t, wall, n.pos.x, n.pos.y, n.alt ?? 0, n.heading);
        e.alt = n.alt;
        e.phase = n.phase;
        e.model.setIntruder(e.fake);
        e.label.element.classList.toggle('fake', e.fake);
      } else setLook(e, e.fake ? 'fake' : e.alive ? 'normal' : 'dead');
      e.last.x = n.pos.x; e.last.y = n.pos.y;
    }
    for (const e of [...ents.values()]) if (!seen.has(e.id)) removeEnt(e);
    links = s.links;
    storms.sync(s.deadZones, groundAt);
    if (s.cellNetworkUp !== networkUp) {
      networkUp = s.cellNetworkUp;
      for (const t of towers) { setTowerUp(t, networkUp); (t.userData.ring as THREE.Object3D).visible = networkUp; }
    }
  }

  // ---------- per-frame animation ----------
  const tmp = new THREE.Vector3();
  let lastFrame = performance.now();
  let raf = 0;
  let districtFade = 1;
  let simMovedAt = -Infinity;                           // wall seconds when sim time last changed

  const scaleOpts = { unitsPerMetre: SCALE, fovDeg: 42, viewportPx: 900, minPx: SIZE_REF_PX };

  function placeCarrier(e: Ent, dt: number, wall: number): void {
    const m = e.model!, q = e.sm!.sample(wall);
    const x = (q.x - WORLD_SIZE / 2) * SCALE, z = -(q.y - WORLD_SIZE / 2) * SCALE;
    const g0 = groundUnder(x, z), pad = padTop(x, z);
    const gy = Math.max(g0, pad);                       // ground, lake surface or yard; the model adds altitude itself
    e.root.position.set(x, gy, z);
    const onWheels = e.kind === 'van' || e.kind === 'motorbike';
    if (onWheels) { if (g0 > WATER_TOP + 1e-4 && pad < g0) ground.normal(x, z, e.normal); else e.normal.set(0, 1, 0); }
    const dist = camera.position.distanceTo(e.root.position);
    const isHl = highlighted.has(e.id);
    m.setHighlight(isHl);
    m.update({
      pos3: e.root.position, heading: q.heading, speed: q.speed, turnRate: q.turnRate, accel: q.accel,
      alt: e.alt !== undefined ? q.z : undefined, phase: e.phase, carrying: e.boxes, alive: e.alive,
      groundNormal: onWheels ? e.normal : undefined,
      scale: scaleForDistance(Math.min(dist, SIZE_CAP_DIST), 'van', scaleOpts),
    }, dt);
    m.anchor(e.anchor);
    // rings, pick sphere and label follow the model: around the body for drones, on the ground for the rest
    const r = m.radius();
    const ax = e.anchor.x - x, ay = e.anchor.y - gy, az = e.anchor.z - z;
    e.ringBase = Math.max(r * 1.15, dist * 0.01) / 1.5;
    const lift = Math.min(0.12, 0.002 + dist * 0.002);  // just clear of the terrain at any zoom
    const ringY = e.kind === 'drone' ? ay : lift;
    e.ring.position.set(ax, ringY, az); e.hlRing.position.set(ax, ringY, az); e.fakeRing.position.set(ax, ringY, az);
    e.pick.position.set(ax, ay, az);
    e.pick.scale.setScalar(Math.max(r * 1.3, dist * 0.012) / 2.6);
    e.label.position.set(ax, ay + r * 0.8, az);
    if (e.trail) {
      e.trail.bright = isHl ? 2.4 : 1;
      if (e.alive) e.trail.push(e.kind === 'drone' ? e.anchor : tmp.set(x, gy + 2.5 * lift, z));
    }
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    tick();
  }

  /** One frame of animation and drawing. */
  function tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const timeSec = now / 1000;

    // the near plane follows the zoom so carrier close-ups are not clipped (far plane and fog are left alone)
    const camDist = camera.position.distanceTo(controls.target);
    if (!country) {                                     // on the real map the country layer owns near / far
      const near = Math.min(1, Math.max(0.02, camDist * 0.02));
      if (Math.abs(near - camera.near) > 1e-4) { camera.near = near; camera.updateProjectionMatrix(); }
    }
    scaleOpts.fovDeg = camera.fov;
    scaleOpts.viewportPx = canvas.clientHeight || 900;
    const fadeT = Math.min(1, Math.max(0, (camDist - FADE_FROM) / (FADE_TO - FADE_FROM)));
    const fade = 1 - fadeT * fadeT * (3 - 2 * fadeT);
    if (fade !== districtFade) {
      districtFade = fade;
      labels.domElement.style.setProperty('--dfade', fade.toFixed(3));
      labels.domElement.style.setProperty('--dvis', fade < 0.01 ? 'hidden' : 'visible');
      trailLayer.visible = linkLines.visible = fade > 0.01;
      for (const e of ents.values()) if (e.trail) (e.trail.line.material as THREE.LineBasicMaterial).opacity = fade;
      (linkLines.material as THREE.LineBasicMaterial).opacity = 0.7 * fade;
    }

    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    /** Scene units per metre for a marker: true size close up, at least minPx long on screen far away. */
    const markerScale = (obj: THREE.Object3D, lenM: number, minPx: number): number => {
      const d = Math.min(SIZE_CAP_DIST, Math.max(1e-6, camera.position.distanceTo(obj.position)));
      const px = (lenM * SCALE * scaleOpts.viewportPx) / (2 * d * tanHalf);
      const need = minPx / Math.max(1e-9, px);
      return SCALE * Math.sqrt(1 + need * need);
    };
    /** Seat a scaled marker on the highest ground under its footprint (its skirt covers the low side). */
    const seat = (obj: THREE.Object3D, halfM: number, k: number) => {
      const { x, z } = obj.position, r = halfM * k;
      obj.position.y = Math.max(groundUnder(x, z), groundUnder(x + r, z + r), groundUnder(x - r, z + r), groundUnder(x + r, z - r), groundUnder(x - r, z - r));
    };
    for (const t of towers) t.scale.setScalar(markerScale(t, MARKER_SIZE.tower.top, SIZE_REF_PX * MARKER_PX.tower));
    for (const h of hubObjs) {
      const k = markerScale(h, MARKER_SIZE.hub.len, SIZE_REF_PX * MARKER_PX.hub);
      h.scale.setScalar(k);
      seat(h, MARKER_SIZE.hub.len * 0.5, k);
    }

    for (const e of ents.values()) {
      // paused sim: carriers freeze in place (otherwise a hovering drone reads "stopped" and lands)
      if (e.model) placeCarrier(e, timeSec - simMovedAt < 1.5 ? dt : 0, timeSec);
      else {
        const mk = markerKindOf(e.kind), k = markerScale(e.root, MARKER_SIZE[mk].len, SIZE_REF_PX * MARKER_PX[mk]);
        e.root.scale.setScalar(k);
        seat(e.root, MARKER_SIZE[mk].len * 0.45, k);
        e.anchor.copy(e.root.position).y += MARKER_SIZE[mk].top * 0.7 * k;
      }
      const isSel = e.id === selected, isHl = highlighted.has(e.id);
      e.ring.visible = isSel;
      e.hlRing.visible = isHl;
      e.fakeRing.visible = e.fake;
      e.ring.scale.setScalar(e.ringBase);
      if (isHl) e.hlRing.scale.setScalar(e.ringBase * (1.2 + 0.15 * Math.sin(timeSec * 5)));
      if (e.fake) e.fakeRing.scale.setScalar(e.ringBase * (1.1 + 0.2 * Math.sin(timeSec * 6)));
      if (e.model) {
        e.label.visible = isSel || isHl || e.fake;
        e.label.element.classList.toggle('hl', isHl);
      }
    }

    // radio links between blended positions
    let n = 0;
    for (const [a, b] of links) {
      if (n >= MAX_LINKS) break;
      const ea = ents.get(a), eb = ents.get(b);
      if (!ea || !eb) continue;
      const pa = ea.anchor, pb = eb.anchor;
      linkPos.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], n * 6);
      n++;
    }
    linkGeo.setDrawRange(0, n * 2);
    linkGeo.attributes.position.needsUpdate = true;

    // towers blink while the network is up
    for (const t of towers) {
      const light = t.getObjectByName('beacon')!;
      light.scale.setScalar(t.userData.up ? 1 + 0.35 * Math.max(0, Math.sin(timeSec * 4)) : 0.8);
    }
    storms.animate(timeSec);

    // camera glide for focus()
    if (focusGoal) {
      const k = damp(4, dt);
      tmp.copy(focusGoal).sub(controls.target).multiplyScalar(k);
      controls.target.add(tmp);
      camera.position.add(tmp);
      if (controls.target.distanceTo(focusGoal) < 0.3) focusGoal = null;
    }
    // keep the orbit target over the district
    const lim = (WORLD_SIZE / 2) * SCALE;
    if (country) country.update();                      // drives zoom range, fog, far plane and pan limits (Ethiopia)
    else {
      controls.target.x = Math.max(-lim, Math.min(lim, controls.target.x));
      controls.target.z = Math.max(-lim, Math.min(lim, controls.target.z));
    }
    // the orbit target rides the ground, so zooming in over hills never dives under them; close up
    // (a few hundred metres) it only lifts, so a view aimed at a flying drone keeps its aim
    let tgap = groundUnder(controls.target.x, controls.target.z) - controls.target.y;
    if (tgap < 0 && camDist < 5) tgap = 0;
    const tdy = tgap * damp(6, dt);
    controls.target.y += tdy;
    camera.position.y += tdy;
    controls.update();
    const minY = groundUnder(camera.position.x, camera.position.z) + Math.max(0.1, camera.near * 3);
    if (camera.position.y < minY) camera.position.y = minY;
    emitCamera();
    renderer.render(scene, camera);
    labels.render(scene, camera);
  }

  // ---------- camera sharing (split screen) ----------
  const camCbs: ((v: CameraView) => void)[] = [];
  let lastCam = '';
  const getCamera = (): CameraView => ({
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [controls.target.x, controls.target.y, controls.target.z],
  });
  const camKey = (v: CameraView) => [...v.position, ...v.target].map((x) => x.toFixed(3)).join(',');
  function setCamera(v: CameraView): void {
    camera.position.set(...v.position);
    controls.target.set(...v.target);
    focusGoal = null;
    camTouched = true;
    lastCam = camKey(getCamera());                      // applied from outside: do not echo it back
  }
  function emitCamera(): void {
    if (!camCbs.length && !opts.cameraLink) return;
    const v = getCamera();
    const k = camKey(v);
    if (k === lastCam) return;
    lastCam = k;
    opts.cameraLink?.publish(instanceId, v);
    camCbs.forEach((cb) => cb(v));
  }
  opts.cameraLink?.join(instanceId, setCamera);

  // ---------- sizing ----------
  function resize(): void {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    labels.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    if (!camTouched && framePts) frameOn(framePts);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  frameOn(districtPts());
  resize();
  frame();
  // console / screenshot helper: canvas.__runners.anchor('drone-01') -> [x, y, z, groundY] where that node is drawn;
  // tick() draws one frame on demand (background tabs throttle requestAnimationFrame)
  Object.defineProperty(canvas, '__runners', {
    configurable: true,
    value: { anchor: (id: NodeId) => { const e = ents.get(id); return e ? [...e.anchor.toArray(), e.root.position.y] : null; }, scene, camera, tick },
  });

  return {
    update,
    setTool(t) { tool = t; canvas.style.cursor = t === 'select' ? '' : 'crosshair'; },
    onSelect(cb) { selectCbs.push(cb); },
    onGroundClick(cb) { groundCbs.push(cb); },
    onNodeClick(cb) { nodeCbs.push(cb); },
    highlight(ids) { highlighted = new Set(ids); },
    setGridVisible(v) { grid.visible = v; },
    toggleGrid() { grid.visible = !grid.visible; return grid.visible; },
    setLabelsVisible(v) { labels.domElement.style.visibility = v ? 'visible' : 'hidden'; },
    focus(id) {
      const e = ents.get(id);
      if (e) { focusGoal = e.root.position.clone(); camTouched = true; }   // carriers: the ground point under them
    },
    onZoneDraw(cb) { zoneCbs.push(cb); },
    setBaseLayer(l) { baseLayer = l; applyLayer(); },
    getBaseLayer() { return baseLayer; },
    setRoadsVisible(v) { roadsOn = v; applyLayer(); },
    toggleRoads() { roadsOn = !roadsOn; applyLayer(); return roadsOn; },
    getCamera,
    setCamera,
    onCameraChange(cb) { camCbs.push(cb); },
    dispose() {
      cancelAnimationFrame(raf);
      opts.cameraLink?.leave(instanceId);
      attribution?.remove();
      realTerrain?.dispose();
      country?.dispose();
      deadMat.dispose();
      fakeMat.dispose();
      ro.disconnect();
      picker.dispose();
      controls.dispose();
      for (const e of [...ents.values()]) removeEnt(e);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      labels.domElement.remove();
      renderer.dispose();
    },
  };
}
