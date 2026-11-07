// Medical delivery VTOL (quad-plane): high wing, twin booms with 4 lift rotors, pusher prop, H-tail,
// cargo pod with the crate underneath. White/orange livery, green medical cross, nav lights + strobe.
// Flight: climbs to ~120 m on takeoff, hovers on lift rotors for takeoff/landing/hand-off (rotor wash
// on the ground), cruises wing-borne with lift rotors stopped fore-aft, banks with turn rate, pitches
// with acceleration, winches the crate down on a cable at hand-off, tumbles and smokes when dead.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GeoBuilder, box, cross, cyl, latheX, radialTexture, sharedMats, sphere, washTexture } from './assets';
import { Base, CRATE, CrateRack, crateGeometry, type ModelOptions, type ModelState, UP } from './common';
import { altitudeScale, clamp, damp, springStep } from './motion';

export const DRONE_CRUISE_ALT = 120;      // metres
export const DRONE_HANDOFF_ALT = 18;      // hover height while winching
const LIFT_ROTORS: [number, number][] = [[0.5, 0.62], [0.5, -0.62], [-0.62, 0.62], [-0.62, -0.62]];
const ROTOR_Y = 0.852;
const PUSHER: [number, number] = [-1.02, 0.64];
const POD_BELLY_Y = 0.42;                 // crate top sits here
const CRATE_BASE_Y = POD_BELLY_Y - CRATE.h;

interface DroneGeo { body: THREE.BufferGeometry; prop: THREE.BufferGeometry; propsStopped: THREE.BufferGeometry; blur: THREE.BufferGeometry; pusher: THREE.BufferGeometry; pusherBlur: THREE.BufferGeometry; wash: THREE.BufferGeometry }
let G: DroneGeo | null = null;

function wingPanel(b: GeoBuilder, z0: number, z1: number, pal: 'white' | 'orange'): void {
  const sh = new THREE.Shape();
  // unit-chord airfoil, leading edge at +0.28, trailing edge at -0.72
  const top: [number, number][] = [[0.28, 0], [0.25, 0.04], [0.16, 0.075], [0.03, 0.09], [-0.2, 0.075], [-0.45, 0.045], [-0.72, 0.004]];
  const bot: [number, number][] = [[-0.72, -0.004], [-0.4, -0.018], [0.0, -0.028], [0.2, -0.02]];
  sh.moveTo(top[0][0], top[0][1]);
  for (const [x, y] of [...top.slice(1), ...bot]) sh.lineTo(x, y);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: z1 - z0, bevelEnabled: false, steps: 1 });
  const p = g.attributes.position;
  const dih = Math.tan((3 * Math.PI) / 180);
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i) + z0, c = 0.36 + (0.22 - 0.36) * (z / 1.7);
    p.setXYZ(i, p.getX(i) * c, p.getY(i) * c + z * dih + 0.8, z);
  }
  g.computeVertexNormals();
  b.addPair(g, pal);
}

function buildGeo(): DroneGeo {
  if (G) return G;
  const b = new GeoBuilder();
  // fuselage + orange nose
  b.add(latheX([[0.035, -0.95], [0.07, -0.82], [0.12, -0.5], [0.15, -0.15], [0.15, 0.3], [0.13, 0.6], [0.09, 0.8]], 14, 0.95), 'white', { p: [0, 0.64, 0] });
  b.add(latheX([[0.09, 0.8], [0.04, 0.93], [0.001, 0.96]], 14, 0.95), 'orange', { p: [0, 0.64, 0] });
  b.add(latheX([[0.001, -0.08], [0.06, -0.05], [0.07, 0.1], [0.05, 0.25], [0.001, 0.3]], 10, 0.6), 'glass', { p: [0.42, 0.74, 0] }); // sensor window
  // wing: white inner panels, orange tips
  wingPanel(b, 0, 1.42, 'white');
  wingPanel(b, 1.42, 1.7, 'orange');
  // booms, motors, landing legs
  for (const z of [0.62, -0.62]) {
    b.add(cyl(0.028, 0.028, 2.17, 8), 'carbon', { p: [-0.235, 0.745, z], r: [0, 0, Math.PI / 2] });
    b.add(cyl(0.04, 0.04, 0.06, 10), 'carbon', { p: [0.85, 0.745, z], r: [0, 0, Math.PI / 2] }); // boom cap
    for (const [x] of LIFT_ROTORS.filter(([, rz]) => rz === z)) {
      b.add(cyl(0.036, 0.04, 0.075, 12), 'carbon', { p: [x, 0.805, z] });
      b.add(cyl(0.012, 0.012, 0.74, 5), 'carbon', { p: [x + (x > 0 ? 0.08 : -0.08), 0.37, z] });
      b.add(box(0.2, 0.018, 0.03), 'rubber', { p: [x + (x > 0 ? 0.08 : -0.08), 0.009, z] });
    }
    // twin fins with orange caps and a small cross
    b.add(box(0.24, 0.3, 0.012), 'white', { p: [-1.2, 0.895, z] });
    b.add(box(0.24, 0.06, 0.014), 'orange', { p: [-1.2, 1.075, z] });
    cross(b, 'medgreen', 0.1, { p: [-1.2, 0.9, z + Math.sign(z) * 0.008], r: [Math.PI / 2, 0, 0] });
  }
  b.add(box(0.2, 0.014, 1.26), 'white', { p: [-1.22, 1.045, 0] });     // horizontal stabiliser
  b.add(box(0.06, 0.016, 1.26), 'orange', { p: [-1.29, 1.046, 0] });    // elevator
  // cargo pod under the fuselage
  b.add(latheX([[0.001, -0.5], [0.08, -0.42], [0.16, -0.2], [0.17, 0.1], [0.14, 0.35], [0.06, 0.48], [0.001, 0.52]], 12, 0.42), 'white', { p: [-0.1, 0.47, 0] });
  b.add(box(0.06, 0.08, 0.04), 'carbon', { p: [-0.1, 0.52, 0] });       // pylon
  cross(b, 'medgreen', 0.11, { p: [-0.05, 0.47, 0.172], r: [Math.PI / 2, 0, 0] });
  cross(b, 'medgreen', 0.11, { p: [-0.05, 0.47, -0.172], r: [Math.PI / 2, 0, 0] });
  cross(b, 'medgreen', 0.22, { p: [-0.02, 0.86, 0] });                   // on the wing, readable from above
  // pusher nacelle
  b.add(cyl(0.035, 0.045, 0.08, 10), 'carbon', { p: [-0.98, 0.64, 0], r: [0, 0, Math.PI / 2] });
  // nav lights: red port (left, -z), green starboard (+z), white tail
  const tipY = 0.8 + 1.7 * Math.tan((3 * Math.PI) / 180);
  b.add(sphere(0.026, 8, 6), 'navRed', { p: [0.02, tipY, -1.71] });
  b.add(sphere(0.026, 8, 6), 'navGreen', { p: [0.02, tipY, 1.71] });
  b.add(sphere(0.02, 8, 6), 'lamp', { p: [-1.33, 1.055, 0] });
  const body = b.build();

  const pb = new GeoBuilder();
  pb.add(box(0.29, 0.006, 0.045), 'carbon', { p: [0.155, 0, 0], r: [0.2, 0, 0] });
  pb.add(box(0.29, 0.006, 0.045), 'carbon', { p: [-0.155, 0, 0], r: [-0.2, 0, 0] });
  pb.add(cyl(0.022, 0.022, 0.03, 8), 'carbon');
  const prop = pb.build();
  const sb = new GeoBuilder();
  for (const [x, z] of LIFT_ROTORS) sb.add(prop.clone(), 'carbon', { p: [x, ROTOR_Y, z] });
  const propsStopped = sb.build();
  const discs = LIFT_ROTORS.map(([x, z]) => new THREE.CircleGeometry(0.3, 24).rotateX(-Math.PI / 2).translate(x, ROTOR_Y + 0.004, z));
  const blur = mergeGeometries(discs)!;
  discs.forEach((d) => d.dispose());
  const ub = new GeoBuilder();
  ub.add(box(0.012, 0.4, 0.035), 'carbon', { r: [0, 0.25, 0] });
  ub.add(cyl(0.02, 0.02, 0.04, 8), 'carbon', { r: [0, 0, Math.PI / 2] });
  const pusher = ub.build();
  const pusherBlur = new THREE.CircleGeometry(0.2, 20).rotateY(Math.PI / 2);
  const wash = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  return (G = { body, prop, propsStopped, blur, pusher, pusherBlur, wash });
}

type Winch = 'stowed' | 'lowering' | 'down' | 'retracting';

export class DroneModel extends Base {
  readonly kind = 'drone' as const;
  private props: THREE.Mesh[] = [];
  private propsStopped: THREE.Mesh;
  private blur: THREE.Mesh;
  private blurMat: THREE.MeshBasicMaterial;
  private pusher: THREE.Mesh;
  private pusherBlur: THREE.Mesh;
  private pusherBlurMat: THREE.MeshBasicMaterial;
  private strobe: THREE.Mesh;
  private strobeGlow: THREE.Sprite;
  private wash: THREE.Mesh;
  private washMat: THREE.MeshBasicMaterial;
  private rack: CrateRack;
  // flight state
  private alt = 0; private altV = 0;
  private lift = 0; private push = 0;
  private liftAngle = 0; private pushAngle = 0;
  private bank = 0; private pitch = 0;
  private stillT = 0;
  // death
  private fallV = 0; private tumble = new THREE.Vector3(); private crashed = false;
  private crashQ = new THREE.Quaternion();
  // winch
  private winch: Winch = 'stowed';
  private winchLen = 0;                    // model metres below the pod
  private winchStartCarry = 0;
  private hang = new THREE.Group();
  private cable: THREE.Line;
  private hangCrate: THREE.Mesh;
  private dropped: THREE.Mesh;
  private droppedT = -1;
  private droppedVY = 0;
  private droppedGround = 0;
  private lastCarry = 0;

  constructor(opts: ModelOptions = {}) {
    super(opts);
    const g = buildGeo(), m = sharedMats();
    this.boundR = 1.9;
    this.solid(g.body);
    for (const [x, z] of LIFT_ROTORS) {
      const p = new THREE.Mesh(g.prop, m.base);
      p.position.set(x, ROTOR_Y, z);
      p.castShadow = true;
      this.body.add(p);
      this.props.push(p);
      this.solids.push(p);
    }
    this.propsStopped = this.solid(g.propsStopped);
    this.blurMat = m.blur.clone();
    this.blur = new THREE.Mesh(g.blur, this.blurMat);
    this.blur.renderOrder = 2;
    this.body.add(this.blur);
    this.pusher = this.solid(g.pusher);
    this.pusher.position.set(PUSHER[0], PUSHER[1], 0);
    this.pusherBlurMat = m.blur.clone();
    this.pusherBlur = new THREE.Mesh(g.pusherBlur, this.pusherBlurMat);
    this.pusherBlur.position.set(PUSHER[0] - 0.01, PUSHER[1], 0);
    this.body.add(this.pusherBlur);
    this.strobe = new THREE.Mesh(sphere(0.03, 8, 6), m.strobe);
    this.strobe.position.set(-0.45, 0.8, 0);
    this.strobeGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(), color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.strobeGlow.position.copy(this.strobe.position);
    this.strobeGlow.scale.setScalar(0.32);
    this.body.add(this.strobe, this.strobeGlow);
    this.rack = new CrateRack([[0.12, CRATE_BASE_Y, 0], [-0.32, CRATE_BASE_Y, 0]]);
    this.body.add(this.rack.mesh);
    this.solids.push(this.rack.mesh);
    // rotor wash on the ground
    this.washMat = new THREE.MeshBasicMaterial({ map: washTexture(), color: 0xd9ccb0, transparent: true, depthWrite: false, opacity: 0 });
    this.wash = new THREE.Mesh(g.wash, this.washMat);
    this.wash.renderOrder = 1;
    this.object.add(this.wash);
    this.addShadow(3.4, 1.4);
    // winch: cable + the crate on it hang straight down from the pod (not tilted with the airframe)
    this.cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), m.line);
    this.cable.frustumCulled = false;
    this.hangCrate = new THREE.Mesh(crateGeometry(), m.base);
    this.hangCrate.castShadow = true;
    this.solids.push(this.hangCrate);
    this.hang.add(this.cable, this.hangCrate);
    this.hang.visible = false;
    this.object.add(this.hang);
    this.dropped = new THREE.Mesh(crateGeometry(), m.base);
    this.dropped.visible = false;
    this.solids.push(this.dropped);
    this.worldFx.add(this.dropped);
  }

  protected onAliveChange(alive: boolean): void {
    if (!alive) {
      this.fallV = 0; this.crashed = this.alt < 0.5;
      const r = (this.t0 * 7.3) % 1;
      this.tumble.set(2.2 + r * 2, 0.8 + r, 1.5 - r * 3);
      this.crashQ.setFromEuler(new THREE.Euler(1.05 * (r > 0.5 ? 1 : -1), this.yaw, -0.3, 'YXZ'));
    } else { this.crashed = false; }
  }

  update(st: ModelState, dt: number): void {
    dt = this.begin(st, dt);
    const ph = st.phase, v = st.speed;
    const slow = v < 3;
    this.stillT = v < 1 ? this.stillT + dt : 0;
    const altMul = (this.opts.altExaggeration ?? 1) * altitudeScale(this.k);

    if (!st.alive) { this.updateDead(st, dt, altMul); return; }

    // ---- target altitude and rotor modes from the phase (or from motion when no phase is sent)
    const parked = ph === 'charging' || (ph === 'idle' && slow) || (!ph && slow && this.stillT > 8);
    let target: number;
    if (st.alt !== undefined) target = st.alt;
    else if (parked || ph === 'landing') target = 0;
    else if (ph === 'handoff' || (!ph && slow)) target = DRONE_HANDOFF_ALT;
    else target = DRONE_CRUISE_ALT;
    const omega = st.alt !== undefined ? 3 : target > this.alt ? 0.6 : 0.9;    // ~8 s wall to climb out, ~5 s down
    [this.alt, this.altV] = springStep(this.alt, this.altV, target, omega, dt);
    if (this.alt < 0) { this.alt = 0; this.altV = 0; }
    const airborne = target > 0.5 || this.alt > 0.3;
    const vtol = ph === 'takeoff' || ph === 'landing' || ph === 'handoff';
    const liftWant = airborne && (vtol || v < 9 || this.alt < 25) && !(ph === 'cruise' && v > 9 && this.alt > 25) ? 1 : 0;
    const pushWant = airborne && (v > 2 || ph === 'cruise') ? 1 : 0;
    this.lift += (liftWant - this.lift) * damp(liftWant > this.lift ? 1.8 : 0.9, dt);
    this.push += (pushWant - this.push) * damp(pushWant > this.push ? 2 : 1, dt);

    // ---- attitude: bank with turn rate, pitch with acceleration and climb
    const wingBorne = 1 - this.lift;
    let bankT = -Math.atan((v * this.turn) / 9.81);
    bankT = clamp(bankT, -0.6, 0.6) * (0.3 + 0.7 * wingBorne);
    let pitchT = wingBorne * (0.035 + 0.5 * Math.atan2(this.altV, Math.max(v, 6))) - 0.035 * this.acc;
    pitchT = clamp(pitchT, -0.25, 0.25);
    if (!airborne && this.alt < 0.05) { bankT = 0; pitchT = 0; }
    this.bank += (bankT - this.bank) * damp(4, dt);
    this.pitch += (pitchT - this.pitch) * damp(3, dt);
    const hoverBob = this.lift * Math.min(1, this.alt / 3) * (Math.sin(this.time * 1.7 + this.t0) * 0.12 + Math.sin(this.time * 2.9 + this.t0 * 2) * 0.05);
    this.body.position.set(0, this.alt * altMul * this.upm + hoverBob * this.s, 0);
    this.orient(st, this.pitch + hoverBob * 0.05, this.bank, dt, false);

    this.animateRotors(dt);
    this.animateLights(true);
    this.updateGroundFx(true);
    this.updateWinch(st, dt, altMul);
    this.updateDropped(dt);
    this.smokeFrom(this.tmpLocal.set(0, 0.64, 0), false, dt);
  }

  private tmpLocal = new THREE.Vector3();

  private updateDead(st: ModelState, dt: number, altMul: number): void {
    if (!this.crashed) {
      this.fallV += 25 * dt;
      this.alt = Math.max(0, this.alt - this.fallV * dt);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.tumble.x * dt, this.tumble.y * dt, this.tumble.z * dt));
      this.body.quaternion.multiply(q);
      if (this.alt <= 0) this.crashed = true;
    } else {
      this.alt = 0;
      this.body.quaternion.slerp(this.crashQ, damp(6, dt));
    }
    this.body.position.set(0, this.alt * altMul * this.upm + (this.crashed ? 0.25 * this.s : 0), 0);
    this.lift += (0 - this.lift) * damp(3, dt);
    this.push += (0 - this.push) * damp(3, dt);
    this.animateRotors(dt);
    this.animateLights(false);
    this.updateGroundFx(false);
    this.hang.visible = false;
    this.winch = 'stowed'; this.winchLen = 0;
    this.rack.show(st.carrying);
    this.updateDropped(dt);
    this.smokeFrom(this.tmpLocal.set(-0.3, 0.7, 0), true, dt);
  }

  private animateRotors(dt: number): void {
    this.liftAngle += this.lift * 70 * dt;
    if (this.lift < 0.15) {                          // spinning down: settle blades fore-aft
      const tgt = Math.round(this.liftAngle / Math.PI) * Math.PI;
      this.liftAngle += (tgt - this.liftAngle) * damp(3, dt);
    }
    const spinning = this.lift > 0.03 && this.lift < 0.8;
    this.propsStopped.visible = this.lift <= 0.03;
    this.props.forEach((p, i) => { p.visible = spinning; p.rotation.y = this.liftAngle * (i === 0 || i === 3 ? 1 : -1); });
    this.blur.visible = this.lift > 0.45;
    this.blurMat.opacity = clamp((this.lift - 0.45) / 0.55, 0, 1) * 0.55;
    this.pushAngle += this.push * 80 * dt;
    this.pusher.visible = this.push < 0.85;
    this.pusher.rotation.x = this.pushAngle;
    this.pusherBlur.visible = this.push > 0.5;
    this.pusherBlurMat.opacity = clamp((this.push - 0.5) / 0.5, 0, 1) * 0.5;
  }

  private animateLights(on: boolean): void {
    const c = (this.time + this.t0) % 1.3;
    const flash = on && (c < 0.06 || (c > 0.18 && c < 0.24));
    this.strobe.visible = flash;
    this.strobeGlow.visible = flash;
  }

  private updateGroundFx(alive: boolean): void {
    const altM = this.alt;
    const washOn = alive && this.lift > 0.3 && altM < 45;
    this.wash.visible = washOn;
    if (washOn) {
      const pulse = (this.time * 0.8) % 1;
      this.wash.scale.setScalar((4.5 + 2.5 * pulse + altM * 0.05) * this.s);
      this.wash.rotation.y = this.time * 0.4;
      this.washMat.opacity = this.lift * (1 - altM / 45) * (0.55 - 0.35 * pulse);
    }
    if (this.shadow) {
      this.shadow.visible = true;
      this.shadow.rotation.y = this.yaw;
      this.shadow.scale.setScalar(this.s * (1 + altM / 150));
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.4 * (1 - Math.min(0.75, altM / 200));
    }
  }

  // ---- winch: lower the crate on a cable during hand-off, release when the box leaves the drone
  private updateWinch(st: ModelState, dt: number, altMul: number): void {
    const handoff = st.phase === 'handoff';
    const carry = st.carrying;
    // cable length that puts the crate base on the ground, in model metres
    const groundLen = (this.body.position.y / this.s) + CRATE_BASE_Y;
    if (this.winch === 'stowed') {
      // winch only once settled in the hover (cable stays short and vertical)
      const settled = this.alt > 5 && this.alt < (st.alt ?? DRONE_HANDOFF_ALT) + 6 && Math.abs(this.altV) < 3;
      if (handoff && carry > 0 && settled) { this.winch = 'lowering'; this.winchStartCarry = carry; }
      else if (carry < this.lastCarry && this.alt > 3 && this.alt < 60) { this.winch = 'lowering'; this.winchStartCarry = carry + 1; }
    }
    const lowered = this.winch !== 'stowed';
    const released = lowered && carry < this.winchStartCarry;
    if (this.winch === 'lowering' || this.winch === 'down') {
      if (released) { this.release(st); this.winch = 'retracting'; }
      else if (!handoff && this.winchStartCarry === carry && this.winch === 'down') this.winch = 'retracting';
      else if (this.winch === 'lowering') {
        const speed = Math.max(groundLen / 3.5, 0.5);
        this.winchLen = Math.min(groundLen, this.winchLen + speed * dt);
        if (this.winchLen >= groundLen - 1e-3) this.winch = 'down';
      } else this.winchLen = groundLen;
    }
    if (this.winch === 'retracting') {
      this.winchLen = Math.max(0, this.winchLen - Math.max(groundLen / 2.5, 0.6) * dt);
      if (this.winchLen <= 0) { this.winch = 'stowed'; this.winchStartCarry = 0; }
    }
    this.lastCarry = carry;
    // hang point in object space, upright, yawed with the drone
    const showHangCrate = this.winch === 'lowering' || this.winch === 'down' || (this.winch === 'retracting' && !released && carry >= this.winchStartCarry && carry > 0);
    this.hang.visible = this.winch !== 'stowed';
    this.body.updateMatrix();
    this.hang.position.set(-0.1, POD_BELLY_Y, 0).applyMatrix4(this.body.matrix);
    this.hang.rotation.set(0, this.yaw, 0);
    this.hang.scale.setScalar(this.s);
    const pos = this.cable.geometry.attributes.position as THREE.BufferAttribute;
    pos.setY(1, -Math.max(0.001, this.winchLen));
    pos.needsUpdate = true;
    this.hangCrate.visible = showHangCrate;
    this.hangCrate.position.set(0.1, -this.winchLen - CRATE.h, 0);
    this.rack.show(carry - (showHangCrate ? 1 : 0));
    void altMul;
  }

  private release(st: ModelState): void {
    this.hangCrate.updateMatrixWorld(true);
    this.object.updateMatrixWorld(true);
    // crate position in parent space = object position + hang-local offset
    const p = new THREE.Vector3(0.1, -this.winchLen - CRATE.h, 0).multiplyScalar(this.s).applyAxisAngle(UP, this.yaw).add(this.hang.position).add(this.object.position);
    this.dropped.position.copy(p);
    this.dropped.rotation.set(0, this.yaw, 0);
    this.dropped.scale.setScalar(this.s);
    this.dropped.visible = true;
    this.droppedT = 0;
    this.droppedVY = 0;
    this.droppedGround = st.pos3.y;
  }

  private updateDropped(dt: number): void {
    if (this.droppedT < 0) return;
    this.droppedT += dt;
    if (this.dropped.position.y > this.droppedGround) {
      this.droppedVY += 9.81 * this.s * dt;
      this.dropped.position.y = Math.max(this.droppedGround, this.dropped.position.y - this.droppedVY * dt);
    }
    // picked up by the receiver: shrink away after a moment (the box now shows on the receiving carrier)
    const k = clamp(1 - (this.droppedT - 1.4) / 0.4, 0, 1);
    this.dropped.scale.setScalar(this.s * k);
    if (k <= 0) { this.dropped.visible = false; this.droppedT = -1; }
  }

  anchor(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.object.position).add(this.body.position).addScaledVector(UP, 0.65 * this.s);
  }

  protected disposeOwn(): void {
    this.blurMat.dispose(); this.pusherBlurMat.dispose(); this.washMat.dispose();
    this.strobeGlow.material.dispose();
    this.strobe.geometry.dispose();
    this.cable.geometry.dispose();
  }
}
