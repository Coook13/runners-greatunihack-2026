// Small fibreglass outboard boat (5.6 m): lofted V hull, white gelcoat with a blue sheer stripe, blue
// canopy on four poles, benches, a boatman at the tiller and an outboard that swings with the turn.
// Bobs at rest, lifts its bow with speed, heels into turns, and draws an animated foam wake.
import * as THREE from 'three';
import { GeoBuilder, box, cyl, foamTexture, limb, sphere, type Pal } from './assets';
import { Base, CRATE, CrateRack, type ModelOptions, type ModelState } from './common';
import { clamp, damp, smoothstep } from './motion';

// stations: x, gunwale half-breadth, chine half-breadth, keel y, chine y, gunwale y (waterline = 0)
const ST: [number, number, number, number, number, number][] = [
  [-2.7, 0.8, 0.7, -0.2, -0.1, 0.42], [-1.8, 0.86, 0.74, -0.22, -0.12, 0.43], [-0.8, 0.88, 0.74, -0.23, -0.12, 0.45],
  [0.2, 0.86, 0.68, -0.22, -0.1, 0.48], [1.2, 0.76, 0.52, -0.18, -0.05, 0.53], [2.0, 0.55, 0.3, -0.08, 0.05, 0.6],
  [2.6, 0.25, 0.1, 0.12, 0.22, 0.68], [2.85, 0.02, 0.01, 0.42, 0.44, 0.72],
];
let G: { hull: THREE.BufferGeometry; motor: THREE.BufferGeometry } | null = null;

type V3 = [number, number, number];
/** Triangles between two polylines, each triangle flipped if needed so its normal agrees with `hint`. */
function strip(b: GeoBuilder, lo: V3[], hi: V3[], pal: Pal, hint: (p: V3) => V3): void {
  const pos: number[] = [];
  const tri = (a: V3, c: V3, d: V3) => {
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const h = hint([(a[0] + c[0] + d[0]) / 3, (a[1] + c[1] + d[1]) / 3, (a[2] + c[2] + d[2]) / 3]);
    if (n[0] * h[0] + n[1] * h[1] + n[2] * h[2] < 0) pos.push(...a, ...d, ...c); else pos.push(...a, ...c, ...d);
  };
  for (let i = 0; i < lo.length - 1; i++) { tri(lo[i], lo[i + 1], hi[i]); tri(hi[i], lo[i + 1], hi[i + 1]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  b.add(g, pal);
}

function buildGeo(): NonNullable<typeof G> {
  if (G) return G;
  const b = new GeoBuilder();
  const lerp = (a: number, c: number, t: number) => a + (c - a) * t;
  for (const side of [1, -1]) {
    const keel: V3[] = ST.map(([x, , , k]) => [x, k, 0]);
    const chine: V3[] = ST.map(([x, , c, , hc]) => [x, hc, c * side]);
    const at = (t: number): V3[] => ST.map(([x, g, c, , hc, gy]) => [x, lerp(hc, gy, t), lerp(c, g, t) * side]);
    const out = (p: V3): V3 => [0, p[1] < 0 ? -0.6 : 0, side];
    strip(b, keel, chine, 'hull', out);
    strip(b, chine, at(0.62), 'hull', out);
    strip(b, at(0.62), at(0.8), 'stripe', out);
    strip(b, at(0.8), at(1), 'hull', out);
    // inside skin and the gunwale cap
    const inner: V3[] = ST.map(([x, g, , , , gy]) => [x, gy, Math.max(0, g - 0.05) * side]);
    const floor: V3[] = ST.map(([x, , c]) => [x, 0.02, Math.max(0, c - 0.06) * side]);
    strip(b, floor, inner, 'deck', () => [0, 0.3, -side]);
    strip(b, ST.map(([x, g, , , , gy]) => [x, gy, g * side]), inner, 'outboard', () => [0, 1, 0]);
    strip(b, floor, ST.map(([x]) => [x, 0.02, 0]), 'deck', () => [0, 1, 0]);
  }
  // transom
  const [tx, tg, tc, tk, thc, tgy] = ST[0];
  const tr = new THREE.Shape([new THREE.Vector2(-tg, tgy), new THREE.Vector2(-tc, thc), new THREE.Vector2(0, tk), new THREE.Vector2(tc, thc), new THREE.Vector2(tg, tgy)]);
  b.add(new THREE.ShapeGeometry(tr), 'hull', { p: [tx, 0, 0], r: [0, -Math.PI / 2, 0] });
  b.add(new THREE.ShapeGeometry(tr), 'hull', { p: [tx + 0.002, 0, 0], r: [0, Math.PI / 2, 0] });
  // benches, bow deck, fuel tank
  for (const [x, w] of [[-2.05, 0.78], [-0.4, 0.84], [1.15, 0.7]] as [number, number][]) b.add(box(0.32, 0.04, w * 2), 'wood', { p: [x, 0.32, 0] });
  b.add(box(0.55, 0.03, 0.56), 'hull', { p: [2.22, 0.63, 0], r: [0, 0, -0.12] });
  b.add(box(0.42, 0.22, 0.3), 'bikeRed', { p: [-2.35, 0.14, 0.45] });
  // canopy: four poles and a blue fabric roof
  for (const x of [-1.35, 0.55]) for (const z of [0.72, -0.72]) b.add(cyl(0.02, 0.02, 1.5, 6), 'chrome', { p: [x, 1.15, z] });
  b.addPair(box(2.1, 0.03, 0.84), 'canopy', { p: [-0.4, 1.95, 0.4], r: [0.1, 0, 0] });
  b.add(box(2.1, 0.035, 0.12), 'canopy', { p: [-0.4, 1.99, 0] });
  // boatman at the stern, hand on the tiller
  limb(b, 'denim', [-2.15, 0.36, 0.1], [-1.85, 0.4, 0.12], 0.07);
  limb(b, 'denim', [-2.15, 0.36, -0.1], [-1.85, 0.4, -0.12], 0.07);
  limb(b, 'denim', [-1.85, 0.4, 0.12], [-1.8, 0.05, 0.14], 0.055);
  limb(b, 'denim', [-1.85, 0.4, -0.12], [-1.8, 0.05, -0.14], 0.055);
  limb(b, 'shirt', [-2.15, 0.42, 0], [-2.1, 0.92, 0], 0.16);
  limb(b, 'shirt', [-2.1, 0.86, 0.2], [-2.3, 0.62, 0.3], 0.05);
  limb(b, 'shirt', [-2.1, 0.86, -0.2], [-1.95, 0.6, -0.25], 0.05);
  b.add(sphere(0.12, 10, 8), 'skin', { p: [-2.08, 1.08, 0] });
  b.add(cyl(0.13, 0.14, 0.07, 10), 'offwhite', { p: [-2.08, 1.17, 0] });   // cap
  const hull = b.build();

  const m = new GeoBuilder();                        // outboard, origin at the transom pivot
  m.add(box(0.36, 0.34, 0.3), 'outboard', { p: [-0.18, 0.62, 0] });
  m.add(box(0.38, 0.06, 0.32), 'rubber', { p: [-0.18, 0.43, 0] });
  m.add(box(0.1, 0.5, 0.1), 'outboard', { p: [-0.14, 0.15, 0] });
  m.add(box(0.3, 0.08, 0.1), 'outboard', { p: [-0.14, -0.13, 0] });
  m.add(box(0.03, 0.03, 0.03), 'white', { p: [-0.36, 0.7, 0] });
  m.add(cyl(0.02, 0.02, 0.55, 6), 'rubber', { p: [0.22, 0.6, 0.3], r: [0, -0.8, Math.PI / 2] });   // tiller
  return (G = { hull, motor: m.build() });
}

export class BoatModel extends Base {
  readonly kind = 'boat' as const;
  private motor: THREE.Mesh;
  private wake: THREE.Mesh;
  private wakeMat: THREE.MeshBasicMaterial;
  private bowFoam: THREE.Mesh;
  private rack: CrateRack;
  private plane = 0;
  private heel = 0;
  private steer = 0;
  private wakeScroll = 0;

  constructor(opts: ModelOptions = {}) {
    super(opts);
    const g = buildGeo();
    this.boundR = 3;
    this.solid(g.hull);
    this.motor = this.solid(g.motor);
    this.motor.position.set(-2.72, 0, 0);
    const fy = 0.02 + CRATE.h * 0;
    this.rack = new CrateRack([
      [-1.2, fy, 0.25], [-1.2, fy, -0.25], [0.2, fy, 0.25], [0.2, fy, -0.25], [-0.75, fy, 0.25], [-0.75, fy, -0.25],
      [-1.2, fy + CRATE.h, 0.25], [-1.2, fy + CRATE.h, -0.25], [0.2, fy + CRATE.h, 0.25], [0.2, fy + CRATE.h, -0.25], [-0.75, fy + CRATE.h, 0], [0.65, fy, 0],
    ]);
    this.body.add(this.rack.mesh);
    this.solids.push(this.rack.mesh);
    // foam wake: a V of scrolling foam behind the stern, widening with distance
    this.wakeMat = new THREE.MeshBasicMaterial({ map: foamTexture().clone(), transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2 });
    this.wakeMat.map!.wrapS = this.wakeMat.map!.wrapT = THREE.RepeatWrapping;
    this.wakeMat.map!.needsUpdate = true;
    const wg = new THREE.BufferGeometry();
    const L = 26, segs = 12, pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, x = -2.75 - t * L, half = 0.7 + t * L * 0.36;
      pos.push(x, 0.03, -half, x, 0.03, half);
      uv.push(0, t * 4, 1, t * 4);
      if (i < segs) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    wg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    // fade along the length with vertex alpha
    const col: number[] = [];
    for (let i = 0; i <= segs; i++) { const a = Math.pow(1 - i / segs, 1.4); col.push(1, 1, 1, a, 1, 1, 1, a); }
    wg.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    wg.setIndex(idx);
    this.wakeMat.vertexColors = true;
    this.wake = new THREE.Mesh(wg, this.wakeMat);
    this.wake.renderOrder = 1;
    this.body.add(this.wake);
    const bf = new THREE.PlaneGeometry(1.4, 1.9).rotateX(-Math.PI / 2);
    this.bowFoam = new THREE.Mesh(bf, this.wakeMat);
    this.bowFoam.position.set(2.0, 0.02, 0);
    this.body.add(this.bowFoam);
  }

  update(st: ModelState, dt: number): void {
    dt = this.begin(st, dt);
    const v = st.alive ? st.speed : 0;
    const t = this.time + this.t0;
    this.plane += (smoothstep(0.5, 5, v) - this.plane) * damp(1.5, dt);
    this.heel += (clamp(-0.03 * v * this.turn, -0.12, 0.12) - this.heel) * damp(3, dt);
    this.steer += (clamp(-this.turn * 1.5, -0.5, 0.5) - this.steer) * damp(4, dt);
    const calm = 1 - 0.6 * this.plane;
    let roll = this.heel + Math.sin(t * 1.1) * 0.035 * calm;
    let pitch = 0.07 * this.plane - 0.01 * this.acc + Math.sin(t * 1.3) * 0.02 * calm;
    let heave = Math.sin(t * 1.6) * 0.04 * calm + 0.05 * this.plane;
    if (!st.alive) { roll = 0.22 + Math.sin(t * 0.8) * 0.02; pitch = -0.05; heave = -0.16; }
    this.body.position.set(0, heave * this.s, 0);
    this.orient(st, pitch, roll, dt, false);
    this.motor.rotation.y = this.steer;
    this.rack.show(st.carrying);
    // wake strength follows speed; the foam scrolls backwards
    this.wakeScroll += v * dt * 0.06;
    this.wakeMat.map!.offset.set(0, this.wakeScroll);
    this.wakeMat.opacity = 0.85 * this.plane;
    this.wake.visible = this.bowFoam.visible = this.plane > 0.02;
    this.smokeFrom(new THREE.Vector3(-2.9, 0.7, 0), !st.alive, dt);
  }

  protected disposeOwn(): void {
    this.wake.geometry.dispose();
    this.bowFoam.geometry.dispose();
    this.wakeMat.map?.dispose();
    this.wakeMat.dispose();
  }
}
