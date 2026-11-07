// 125cc commuter motorbike (Boxer-like) with a rider in a hi-vis vest and red helmet, a white top box
// on the rear rack and pannier frames for the crates. Wheels spin, the fork steers, the whole bike
// leans into turns (atan(v * turnRate / g)); dead = bike on its side, rider standing next to it.
import * as THREE from 'three';
import { GeoBuilder, box, cross, cyl, limb, sharedMats, sphere } from './assets';
import { Base, CRATE, CrateRack, type ModelOptions, type ModelState } from './common';
import { clamp, damp } from './motion';

const R = 0.3, FRONT_X = 0.64, REAR_X = -0.62;
const HEAD: [number, number] = [0.36, 0.92];          // steering head
let G: { frame: THREE.BufferGeometry; frameNoRider: THREE.BufferGeometry; steer: THREE.BufferGeometry; wheel: THREE.BufferGeometry; standing: THREE.BufferGeometry } | null = null;

function frameParts(b: GeoBuilder): void {
  b.add(box(0.36, 0.26, 0.22), 'metal', { p: [0.05, 0.4, 0] });                    // engine
  b.add(cyl(0.06, 0.06, 0.2, 8), 'metal', { p: [0.1, 0.56, 0], r: [0.3, 0, 0.5] }); // cylinder
  b.add(cyl(0.03, 0.03, 0.75, 8), 'chrome', { p: [-0.3, 0.33, 0.13], r: [0, 0, Math.PI / 2 + 0.12] });
  b.add(cyl(0.055, 0.045, 0.34, 10), 'chrome', { p: [-0.62, 0.42, 0.15], r: [0, 0, Math.PI / 2 - 0.2] });
  b.add(cyl(0.04, 0.04, 0.6, 6), 'plastic', { p: [0.2, 0.66, 0], r: [0, 0, 0.95] }); // down tube
  b.add(sphere(0.17, 12, 8), 'bikeRed', { p: [0.2, 0.82, 0], s: [1.25, 0.62, 0.78] }); // tank
  b.add(box(0.6, 0.09, 0.26), 'rubber', { p: [-0.32, 0.86, 0] });                   // seat
  b.addPair(box(0.36, 0.18, 0.02), 'bikeRed', { p: [-0.3, 0.68, 0.11] });           // side panels
  b.add(box(0.5, 0.03, 0.14), 'plastic', { p: [-0.68, 0.7, 0], r: [0, 0, -0.35] });  // rear fender
  b.addPair(cyl(0.02, 0.02, 0.46, 6), 'chrome', { p: [-0.35, 0.5, 0.11], r: [0, 0, 1.0] }); // swing arm
  b.addPair(cyl(0.025, 0.025, 0.38, 6), 'chrome', { p: [-0.55, 0.62, 0.11], r: [0, 0, -0.35] }); // shocks
  b.add(box(0.06, 0.1, 0.06), 'tail', { p: [-0.97, 0.82, 0] });
  b.addPair(box(0.12, 0.02, 0.04), 'rack', { p: [0.0, 0.33, 0.2] });               // foot pegs
  // rear rack, white top box with a green cross, pannier frames
  b.add(box(0.5, 0.025, 0.3), 'rack', { p: [-0.75, 0.93, 0] });
  b.add(box(0.44, 0.34, 0.4), 'white', { p: [-0.82, 1.115, 0] });
  b.add(box(0.46, 0.03, 0.42), 'offwhite', { p: [-0.82, 1.3, 0] });
  cross(b, 'medgreen', 0.2, { p: [-0.82, 1.318, 0] });
  cross(b, 'medgreen', 0.16, { p: [-1.042, 1.12, 0], r: [0, 0, Math.PI / 2] });
  for (const z of [0.2, -0.2]) {
    b.add(box(0.52, 0.02, 0.02), 'rack', { p: [-0.7, 0.46, z * 1.0] });
    b.add(box(0.02, 0.44, 0.02), 'rack', { p: [-0.45, 0.68, z] });
    b.add(box(0.02, 0.44, 0.02), 'rack', { p: [-0.95, 0.68, z] });
    b.add(box(0.5, 0.02, 0.32), 'rack', { p: [-0.7, 0.46, z * 1.75] });               // pannier floor
  }
}

function riderSeated(b: GeoBuilder): void {
  limb(b, 'denim', [-0.2, 0.92, 0.12], [0.16, 0.82, 0.2], 0.075);     // thighs
  limb(b, 'denim', [-0.2, 0.92, -0.12], [0.16, 0.82, -0.2], 0.075);
  limb(b, 'denim', [0.16, 0.82, 0.2], [0.03, 0.4, 0.2], 0.06);        // shins
  limb(b, 'denim', [0.16, 0.82, -0.2], [0.03, 0.4, -0.2], 0.06);
  b.addPair(box(0.2, 0.09, 0.1), 'rubber', { p: [0.06, 0.35, 0.2] });   // boots
  limb(b, 'hivis', [-0.18, 0.98, 0], [-0.02, 1.4, 0], 0.17);           // torso in a hi-vis vest
  b.add(box(0.05, 0.04, 0.3), 'lamp', { p: [-0.13, 1.18, 0], r: [0, 0, -0.4] });  // reflective band
  limb(b, 'jacket', [-0.02, 1.36, 0.2], [0.12, 1.14, 0.27], 0.055);   // arms to the bars
  limb(b, 'jacket', [-0.02, 1.36, -0.2], [0.12, 1.14, -0.27], 0.055);
  limb(b, 'jacket', [0.12, 1.14, 0.27], [0.28, 1.06, 0.33], 0.05);
  limb(b, 'jacket', [0.12, 1.14, -0.27], [0.28, 1.06, -0.33], 0.05);
  b.add(sphere(0.145, 12, 10), 'helmet', { p: [0.04, 1.6, 0] });
  b.add(sphere(0.1, 10, 8), 'glass', { p: [0.12, 1.59, 0], s: [0.7, 0.75, 1.1] });  // visor
}

function riderStanding(b: GeoBuilder): void {
  for (const z of [0.1, -0.1]) {
    limb(b, 'denim', [0, 0.06, z], [0, 0.9, z], 0.07);
    b.add(box(0.22, 0.1, 0.1), 'rubber', { p: [0.04, 0.05, z] });
    limb(b, 'jacket', [0, 1.42, z * 2.1], [0.05, 0.95, z * 2.4], 0.05);
  }
  limb(b, 'hivis', [0, 0.92, 0], [0, 1.45, 0], 0.17);
  b.add(sphere(0.145, 12, 10), 'helmet', { p: [0.02, 1.68, 0] });
  b.add(sphere(0.1, 10, 8), 'glass', { p: [0.1, 1.67, 0], s: [0.7, 0.75, 1.1] });
}

function buildGeo(): NonNullable<typeof G> {
  if (G) return G;
  const f = new GeoBuilder(); frameParts(f); riderSeated(f);
  const f2 = new GeoBuilder(); frameParts(f2);
  // steering assembly, in a frame whose origin is the steering head and whose y axis runs down the fork
  const s = new GeoBuilder();
  const forkLen = Math.hypot(FRONT_X - HEAD[0], HEAD[1] - R);
  s.addPair(cyl(0.025, 0.025, forkLen, 8), 'chrome', { p: [0, -forkLen / 2, 0.08] });
  s.add(cyl(0.015, 0.015, 0.72, 6), 'chrome', { p: [-0.02, 0.12, 0], r: [Math.PI / 2, 0, 0] });   // bars
  s.addPair(cyl(0.022, 0.022, 0.12, 6), 'rubber', { p: [-0.02, 0.12, 0.33], r: [Math.PI / 2, 0, 0] });
  s.add(cyl(0.085, 0.08, 0.07, 12), 'chrome', { p: [0.08, 0.0, 0], r: [0, 0, Math.PI / 2] });     // headlight
  s.add(cyl(0.07, 0.07, 0.01, 12), 'lamp', { p: [0.118, 0.0, 0], r: [0, 0, Math.PI / 2] });
  s.add(box(0.36, 0.03, 0.12), 'bikeRed', { p: [0.06, -forkLen + R + 0.06, 0], r: [0, 0, -0.2] }); // front fender
  const w = new GeoBuilder();
  w.add(new THREE.TorusGeometry(0.255, 0.048, 8, 20), 'rubber');
  w.add(new THREE.TorusGeometry(0.205, 0.012, 4, 20), 'rim');
  w.add(cyl(0.05, 0.05, 0.11, 10), 'metal', { r: [Math.PI / 2, 0, 0] });
  for (let i = 0; i < 6; i++) w.add(box(0.4, 0.006, 0.006), 'chrome', { r: [0, 0, (i / 6) * Math.PI] });
  const st = new GeoBuilder(); riderStanding(st);
  return (G = { frame: f.build(), frameNoRider: f2.build(), steer: s.build(), wheel: w.build(), standing: st.build() });
}

export class MotorbikeModel extends Base {
  readonly kind = 'motorbike' as const;
  private lean = new THREE.Group();
  private frame: THREE.Mesh;
  private steerPivot = new THREE.Group();
  private steer = new THREE.Group();
  private front: THREE.Mesh;
  private rear: THREE.Mesh;
  private standing: THREE.Mesh;
  private spin = 0;
  private steerA = 0;
  private leanA = 0;
  private pitch = 0;
  private rack: CrateRack;

  constructor(opts: ModelOptions = {}) {
    super(opts);
    const g = buildGeo();
    this.boundR = 1.2;
    this.body.add(this.lean);
    this.frame = this.solid(g.frame, this.lean);
    const rake = Math.atan2(FRONT_X - HEAD[0], HEAD[1] - R);
    this.steerPivot.position.set(HEAD[0], HEAD[1], 0);
    this.steerPivot.rotation.z = rake;                  // tilt the steering axis back by the rake
    this.lean.add(this.steerPivot);
    this.steerPivot.add(this.steer);
    this.solid(g.steer, this.steer);
    const forkLen = Math.hypot(FRONT_X - HEAD[0], HEAD[1] - R);
    this.front = this.solid(g.wheel, this.steer);
    this.front.position.set(0, -forkLen, 0);
    this.front.rotation.z = -rake;
    this.rear = this.solid(g.wheel, this.lean);
    this.rear.position.set(REAR_X, R, 0);
    this.standing = this.solid(g.standing, this.body);
    this.standing.position.set(-0.1, 0, 0.95);
    this.standing.visible = false;
    const top = -0.82, py = 0.47;
    this.rack = new CrateRack([[-0.7, py, 0.36], [-0.7, py, -0.36], [top, 1.315, 0], [top, 1.315 + CRATE.h, 0]]);
    this.lean.add(this.rack.mesh);
    this.solids.push(this.rack.mesh);
    this.addShadow(2.3, 1.1);
    void sharedMats;
  }

  protected onAliveChange(alive: boolean): void {
    const g = buildGeo();
    this.frame.geometry = alive ? g.frame : g.frameNoRider;
    this.standing.visible = !alive;
  }

  update(st: ModelState, dt: number): void {
    dt = this.begin(st, dt);
    const v = st.alive ? st.speed : 0;
    this.spin -= Math.min(v / R, 30) * dt;
    this.rear.rotation.z = this.spin;
    // the front wheel sits in the raked steering frame, so spin it about its own axle
    this.front.rotation.set(0, 0, this.spin - this.steerPivot.rotation.z);
    // lean into the turn; a light steer angle; parked = resting on the side stand
    let leanT = clamp(-Math.atan((v * this.turn) / 9.81), -0.6, 0.6);
    if (v < 0.4) leanT = -0.09;
    const steerT = v > 0.5 ? clamp(Math.atan((1.26 * this.turn) / Math.max(v, 1.5)), -0.5, 0.5) : 0.25;
    let pitchT = clamp(0.012 * this.acc, -0.04, 0.05);
    let lift = 0;
    if (!st.alive) { leanT = -1.38; pitchT = 0; lift = 0.06; }
    this.leanA += (leanT - this.leanA) * damp(st.alive ? 5 : 3, dt);
    this.steerA += (steerT - this.steerA) * damp(5, dt);
    this.pitch += (pitchT - this.pitch) * damp(4, dt);
    this.steer.rotation.y = this.steerA;
    this.lean.rotation.set(this.leanA, 0, this.pitch);
    this.lean.position.set(0, lift + Math.abs(Math.sin(this.leanA)) * 0.04, 0);
    this.body.position.set(0, 0, 0);
    this.orient(st, 0, 0, dt);
    this.rack.show(st.carrying);
    if (this.shadow) { this.shadow.rotation.y = this.yaw; this.shadow.scale.setScalar(this.s); }
    this.smokeFrom(new THREE.Vector3(0.05, 0.3, 0.3), !st.alive, dt);
  }
}
