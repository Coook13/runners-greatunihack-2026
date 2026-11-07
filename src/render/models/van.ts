// White 4x4 field van (HiAce-like, 5.4 m): semi-bonnet nose, dark glass, blue band, green medical
// cross on both sides and the roof, snorkel, bull bar, roof rack with a spare, jerrycans and crates.
// Wheels spin and the fronts steer; the sprung body rolls out of turns and pitches with acceleration.
import * as THREE from 'three';
import { GeoBuilder, box, cross, cyl, sharedMats } from './assets';
import { Base, CRATE, CrateRack, type ModelOptions, type ModelState } from './common';
import { clamp, damp } from './motion';

const WHEEL_R = 0.36, WHEEL_X = [1.72, -1.39], TRACK = 0.8;
let G: { body: THREE.BufferGeometry; wheel: THREE.BufferGeometry } | null = null;

function buildGeo(): NonNullable<typeof G> {
  if (G) return G;
  const b = new GeoBuilder();
  // side profile, extruded across the width with rounded (bevelled) edges
  const sh = new THREE.Shape();
  const arch = (xw: number) => { const r = 0.46, a = Math.asin(0.06 / r); sh.lineTo(xw - r * Math.cos(a), 0.48); sh.absarc(xw, 0.42, r, Math.PI - a, a, true); };
  sh.moveTo(-2.62, 0.48);
  arch(WHEEL_X[1]);
  arch(WHEEL_X[0]);
  sh.lineTo(2.55, 0.48); sh.lineTo(2.64, 0.6); sh.lineTo(2.64, 1.0); sh.lineTo(2.5, 1.16); sh.lineTo(1.98, 1.3);
  sh.lineTo(1.38, 2.12); sh.lineTo(1.2, 2.2); sh.lineTo(-2.55, 2.2); sh.lineTo(-2.62, 2.12); sh.closePath();
  const bevel = 0.07, width = 1.88 - 2 * bevel;
  const shell = new THREE.ExtrudeGeometry(sh, { depth: width, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: 6 });
  shell.translate(0, 0, -width / 2);
  shell.computeVertexNormals();
  b.add(shell, 'white');
  const W = 0.94 + 0.012;                                   // outer side surface (half width)
  // glass: windscreen, front doors, rear door
  const ws = Math.atan2(2.12 - 1.3, 1.98 - 1.38);        // windscreen rake
  b.add(box(0.95, 0.03, 1.62), 'glass', { p: [1.68 + 0.06 * Math.sin(ws), 1.71 + 0.06 * Math.cos(ws), 0], r: [0, 0, -ws] });
  b.addPair(box(0.9, 0.52, 0.02), 'glass', { p: [0.82, 1.72, W] });
  b.add(box(0.02, 0.5, 1.4), 'glass', { p: [-2.7, 1.72, 0] });
  // livery: blue band, dusty sills, green crosses (sides + roof, so it reads from the air)
  b.addPair(box(4.9, 0.12, 0.02), 'vanBlue', { p: [-0.05, 1.12, W] });
  b.addPair(box(2.0, 0.12, 0.02), 'dust', { p: [0.17, 0.56, W] });          // dusty sill between the arches
  cross(b, 'medgreen', 0.62, { p: [-1.15, 1.6, W + 0.006], r: [Math.PI / 2, 0, 0] });
  cross(b, 'medgreen', 0.62, { p: [-1.15, 1.6, -W - 0.006], r: [Math.PI / 2, 0, 0] });
  cross(b, 'medgreen', 0.7, { p: [0.85, 2.205 + bevel, 0] });
  // front: bumper, grille, lamps, bull bar; rear: bumper, tail lamps
  b.add(box(0.16, 0.22, 1.86), 'plastic', { p: [2.68, 0.62, 0] });
  b.add(box(0.04, 0.24, 1.0), 'plastic', { p: [2.67, 0.95, 0] });
  b.addPair(box(0.05, 0.14, 0.3), 'lamp', { p: [2.62, 1.0, 0.72] });
  b.addPair(box(0.05, 0.08, 0.12), 'amber', { p: [2.66, 0.78, 0.84] });
  b.addPair(cyl(0.03, 0.03, 0.7, 6), 'rack', { p: [2.86, 0.86, 0.42] });
  b.add(cyl(0.03, 0.03, 0.9, 6), 'rack', { p: [2.86, 1.2, 0], r: [Math.PI / 2, 0, 0] });
  b.add(cyl(0.03, 0.03, 1.5, 6), 'rack', { p: [2.84, 0.62, 0], r: [Math.PI / 2, 0, 0] });
  b.add(box(0.14, 0.2, 1.86), 'plastic', { p: [-2.7, 0.6, 0] });
  b.addPair(box(0.04, 0.32, 0.14), 'tail', { p: [-2.69, 1.18, 0.84] });
  // mirrors, snorkel, side steps, mud flaps
  b.addPair(box(0.08, 0.2, 0.16), 'plastic', { p: [1.9, 1.45, 1.03] });
  b.add(cyl(0.05, 0.05, 1.05, 8), 'plastic', { p: [2.05, 1.6, 0.98] });
  b.add(cyl(0.06, 0.06, 0.16, 8), 'plastic', { p: [2.05, 2.15, 0.98], r: [0, 0, Math.PI / 2] });
  b.addPair(box(1.6, 0.04, 0.16), 'rack', { p: [0.15, 0.42, 0.98] });
  b.addPair(box(0.02, 0.24, 0.26), 'rubber', { p: [-1.9, 0.36, 0.82] });
  // roof rack: frame, slats, legs, load at the front, crates go behind
  const ry = 2.2 + bevel + 0.14;
  b.addPair(box(3.1, 0.05, 0.05), 'rack', { p: [-0.9, ry, 0.8] });
  for (const x of [-2.45, 0.65]) b.add(box(0.05, 0.05, 1.65), 'rack', { p: [x, ry, 0] });
  for (let x = -2.2; x < 0.6; x += 0.5) b.add(box(0.04, 0.03, 1.6), 'rack', { p: [x, ry - 0.04, 0] });
  for (const x of [-2.4, -0.9, 0.6]) b.addPair(box(0.05, 0.16, 0.05), 'rack', { p: [x, ry - 0.08, 0.8] });
  b.add(new THREE.TorusGeometry(0.29, 0.1, 6, 14), 'rubber', { p: [0.2, ry + 0.1, -0.35], r: [Math.PI / 2, 0, 0] });
  b.add(box(0.34, 0.45, 0.17), 'jerry', { p: [0.3, ry + 0.24, 0.35], r: [0, 0, Math.PI / 2] });
  b.add(box(0.34, 0.45, 0.17), 'jerry', { p: [0.3, ry + 0.24, 0.6], r: [0, 0, Math.PI / 2] });
  const body = b.build();

  const w = new GeoBuilder();
  const tyre = new THREE.LatheGeometry([[0.24, -0.12], [0.33, -0.12], [0.36, -0.08], [0.36, 0.08], [0.33, 0.12], [0.24, 0.12]].map(([r, y]) => new THREE.Vector2(r, y)), 16);
  w.add(tyre, 'rubber', { r: [Math.PI / 2, 0, 0] });
  w.add(cyl(0.24, 0.24, 0.2, 12), 'rim', { r: [Math.PI / 2, 0, 0] });
  w.add(cyl(0.08, 0.08, 0.22, 8), 'metal', { r: [Math.PI / 2, 0, 0] });
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; w.add(cyl(0.035, 0.035, 0.205, 6), 'plastic', { p: [Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0], r: [Math.PI / 2, 0, 0] }); }
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; w.add(box(0.05, 0.03, 0.22), 'rubber', { p: [Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0], r: [0, 0, a] }); }
  return (G = { body, wheel: w.build() });
}

/** Crate slots on the roof rack: 5 rows x 4 across, then a second layer of 4. */
function rackSlots(ry: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const zs = [-0.21, 0.21, -0.6, 0.6];
  for (let layer = 0; layer < 2; layer++) for (const x of [-0.35, -0.8, -1.25, -1.7, -2.15]) for (const z of zs) {
    if (layer === 1 && out.length >= 24) break;
    if (layer === 1 && Math.abs(z) > 0.3) continue;
    if (layer === 1 && x < -1.3) continue;
    out.push([x, ry + layer * CRATE.h, z]);
  }
  return out.slice(0, 24);
}

export class VanModel extends Base {
  readonly kind = 'van' as const;
  private sprung = new THREE.Group();
  private wheels: THREE.Mesh[] = [];
  private spin = 0;
  private steer = 0;
  private roll = 0;
  private pitch = 0;
  private rack: CrateRack;
  private hazard: THREE.Mesh[] = [];

  constructor(opts: ModelOptions = {}) {
    super(opts);
    const g = buildGeo();
    this.boundR = 3;
    this.body.add(this.sprung);
    this.sprung.rotation.order = 'YXZ';
    this.solid(g.body, this.sprung);
    for (const x of WHEEL_X) for (const z of [TRACK, -TRACK]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, WHEEL_R, z);
      const m = this.solid(g.wheel, pivot);
      if (z < 0) m.rotation.y = Math.PI;
      this.body.add(pivot);
      this.wheels.push(m);
    }
    this.rack = new CrateRack(rackSlots(2.2 + 0.07 + 0.12));
    this.sprung.add(this.rack.mesh);
    this.solids.push(this.rack.mesh);
    const hzMat = new THREE.MeshBasicMaterial({ color: 0xffa020 });
    for (const [x, z] of [[2.67, 0.84], [2.67, -0.84], [-2.71, 0.84], [-2.71, -0.84]]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.14), hzMat);
      h.position.set(x, x > 0 ? 0.78 : 0.95, z);
      h.visible = false;
      this.sprung.add(h);
      this.hazard.push(h);
    }
    this.addShadow(6.0, 2.4);
  }

  update(st: ModelState, dt: number): void {
    dt = this.begin(st, dt);
    const v = st.alive ? st.speed : 0;
    this.spin -= Math.min(v / WHEEL_R, 28) * dt;
    const steerT = v > 0.5 ? clamp(Math.atan((3.11 * this.turn) / Math.max(v, 2)), -0.55, 0.55) : this.steer;
    this.steer += (steerT - this.steer) * damp(5, dt);
    this.wheels.forEach((w, i) => {
      w.rotation.z = i % 2 === 0 ? this.spin : -this.spin;   // left wheels are mirrored
      (w.parent as THREE.Group).rotation.y = i < 2 ? this.steer : 0;
    });
    // body roll out of the turn, squat/dive with acceleration, a little dirt-road shake
    let rollT = clamp(0.012 * v * this.turn, -0.07, 0.07);
    let pitchT = clamp(0.008 * this.acc, -0.04, 0.04);
    if (!st.alive) { rollT = 0.1; pitchT = -0.06; }
    this.roll += (rollT - this.roll) * damp(4, dt);
    this.pitch += (pitchT - this.pitch) * damp(4, dt);
    const shake = Math.min(1, v / 6) * (Math.sin(this.time * 23 + this.t0) * 0.006 + Math.sin(this.time * 37) * 0.004);
    this.sprung.position.set(0, shake + (st.alive ? 0 : -0.12), 0);
    this.sprung.rotation.set(this.roll, 0, this.pitch);
    this.body.position.set(0, 0, 0);
    this.orient(st, 0, st.alive ? 0 : 0.04, dt);
    this.rack.show(st.carrying);
    const blink = !st.alive && (this.time % 0.9) < 0.45;
    for (const h of this.hazard) h.visible = blink;
    if (this.shadow) { this.shadow.rotation.y = this.yaw; this.shadow.scale.setScalar(this.s); }
    this.smokeFrom(new THREE.Vector3(2.2, 1.2, 0), !st.alive, dt);
  }

  protected disposeOwn(): void {
    for (const h of this.hazard) h.geometry.dispose();
    (this.hazard[0]?.material as THREE.Material | undefined)?.dispose();
  }
}
