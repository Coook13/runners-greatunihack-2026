// What every carrier model shares: the controller interface, the root/body hierarchy, material looks
// (normal, highlight, dead, intruder), terrain-normal alignment, the crate rack, a contact shadow and smoke.
import * as THREE from 'three';
import type { NodeState } from '../../contracts/types';
import { GeoBuilder, box, radialTexture, sharedMats, smokeTexture } from './assets';
import { clamp, damp, type ModelKind } from './motion';

export interface ModelState {
  pos3: THREE.Vector3;            // ground (or water) point under the carrier, scene units
  heading: number;                // radians, 0 = east, counter-clockwise (NodeState.heading convention)
  speed: number;                  // m/s (sim time), e.g. MotionSmoother.speed
  alt?: number;                   // metres above ground (drones). Absent = derived from phase
  phase?: NodeState['phase'];
  carrying: number;               // boxes on board
  alive: boolean;
  groundNormal?: THREE.Vector3;   // scene-space terrain normal; absent = upright
  turnRate?: number;              // rad per sim second (+ = left); absent = estimated from heading
  accel?: number;                 // m/s^2 along track; absent = estimated from speed
  scale?: number;                 // display multiplier from scaleForDistance; absent = 1 (true size)
}

export interface ModelOptions {
  unitsPerMetre?: number;         // scene units per metre (default 1). Current renderer: SCALE = 0.01
  altExaggeration?: number;       // extra multiplier on drone altitude (default 1)
  seed?: number;                  // per-instance animation offset (e.g. hashString(id))
  contactShadow?: boolean;        // soft shadow blob under the model (default true)
  crateGlow?: boolean;            // standalone crate only: faint glow sprite
  yawFromHeading?: (h: number) => number;  // default: identity (world north = scene -z)
}

export interface CarrierModel {
  readonly kind: ModelKind;
  readonly object: THREE.Object3D;
  update(state: ModelState, dt: number): void;
  setHighlight(on: boolean): void;
  setIntruder(on: boolean): void;
  /** Where links, labels and selection rings should attach: the body centre, in the object's parent space. */
  anchor(out: THREE.Vector3): THREE.Vector3;
  /** Current bounding radius in scene units (for pick spheres). */
  radius(): number;
  dispose(): void;
}

export const UP = new THREE.Vector3(0, 1, 0);
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();
const ea = new THREE.Euler();
const va = new THREE.Vector3();

// ---------- the one crate ----------
export const CRATE = { l: 0.4, h: 0.28, w: 0.3 };
let crateGeo: THREE.BufferGeometry | null = null;
/** The plain sealed crate every box uses: tan carton, two straps, a blank seal label. Origin at its base. */
export function crateGeometry(): THREE.BufferGeometry {
  if (crateGeo) return crateGeo;
  const b = new GeoBuilder();
  const { l, h, w } = CRATE;
  b.add(box(l, h, w), 'crate', { p: [0, h / 2, 0] });
  for (const x of [-l * 0.27, l * 0.27]) b.add(box(0.035, h + 0.008, w + 0.008), 'strap', { p: [x, h / 2, 0] });
  b.add(box(0.12, 0.004, 0.08), 'seal', { p: [0, h + 0.004, 0] });
  return (crateGeo = b.build());
}

/** Several crates as one instanced draw call; show the first `n` slots. */
export class CrateRack {
  readonly mesh: THREE.InstancedMesh;
  constructor(slots: [number, number, number][], rotY = 0) {
    this.mesh = new THREE.InstancedMesh(crateGeometry(), sharedMats().base, slots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(UP, rotY), s = new THREE.Vector3(1, 1, 1);
    slots.forEach((p, i) => this.mesh.setMatrixAt(i, m.compose(new THREE.Vector3(...p), q, s)));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.mesh.castShadow = true;
    this.mesh.count = 0;
  }
  show(n: number): void { this.mesh.count = clamp(Math.floor(n), 0, this.mesh.instanceMatrix.count); }
}

// ---------- smoke ----------
const SMOKE_N = 14;
export class Smoke {
  readonly group = new THREE.Group();          // lives in parent space (see Base.worldFx)
  private sprites: THREE.Sprite[] = [];
  private age: number[] = [];
  private vel: THREE.Vector3[] = [];
  private acc = 0;
  private next = 0;
  constructor() {
    const tex = smokeTexture();
    for (let i = 0; i < SMOKE_N; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x2a2a2a, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      this.sprites.push(s); this.age.push(99); this.vel.push(new THREE.Vector3());
      this.group.add(s);
    }
  }
  /** Emit from `at` (parent space) while `on`; size = puff size in scene units. */
  update(on: boolean, at: THREE.Vector3, size: number, dt: number): void {
    if (on) {
      this.acc += dt * 5;
      while (this.acc >= 1) {
        this.acc -= 1;
        const i = this.next++ % SMOKE_N, s = this.sprites[i];
        s.position.copy(at);
        this.age[i] = 0;
        this.vel[i].set((Math.random() - 0.3) * 0.25 * size, (0.7 + Math.random() * 0.3) * size, (Math.random() - 0.5) * 0.25 * size);
        s.visible = true;
      }
    }
    const life = 3.2;
    for (let i = 0; i < SMOKE_N; i++) {
      const s = this.sprites[i];
      if (!s.visible) continue;
      const a = (this.age[i] += dt);
      if (a > life) { s.visible = false; continue; }
      const k = a / life;
      s.position.addScaledVector(this.vel[i], dt);
      s.scale.setScalar(size * (0.6 + 2.6 * k));
      const m = s.material;
      m.opacity = 0.6 * (1 - k) * Math.min(1, a * 6);
      m.color.setScalar(0.16 + 0.3 * k);
    }
  }
  dispose(): void { for (const s of this.sprites) s.material.dispose(); }
}

// ---------- base controller ----------
export abstract class Base implements CarrierModel {
  abstract readonly kind: ModelKind;
  readonly object = new THREE.Group();          // translated to pos3 only (never rotated or scaled)
  readonly body = new THREE.Group();             // oriented + scaled vehicle
  readonly worldFx = new THREE.Group();          // children in the object's parent space (smoke, dropped crates)
  protected readonly upm: number;
  protected readonly opts: ModelOptions;
  protected readonly t0: number;
  protected time = 0;
  protected s = 1;                               // scene units per model metre right now
  protected k = 1;                               // display scale
  protected yaw = 0;
  protected yawInit = false;
  protected turn = 0;
  protected acc = 0;
  protected lastSpeed = 0;
  protected normal = new THREE.Vector3(0, 1, 0);
  protected wasAlive = true;
  protected deadT = 0;
  protected look: 'base' | 'dead' | 'highlight' | 'intruder' = 'base';
  private hl = false;
  private intr = false;
  protected solids: THREE.Mesh[] = [];
  protected shadow: THREE.Mesh | null = null;
  protected smoke: Smoke | null = null;
  protected boundR = 3;                          // model metres

  constructor(opts: ModelOptions = {}) {
    this.opts = opts;
    this.upm = opts.unitsPerMetre ?? 1;
    this.t0 = ((opts.seed ?? 0) % 1000) / 37;
    this.body.rotation.order = 'YXZ';
    this.object.add(this.body, this.worldFx);
    this.worldFx.matrixAutoUpdate = true;
  }

  protected solid(geo: THREE.BufferGeometry, parent: THREE.Object3D = this.body): THREE.Mesh {
    const m = new THREE.Mesh(geo, sharedMats().base);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    this.solids.push(m);
    return m;
  }

  protected addShadow(lenM: number, widM: number): void {
    if (this.opts.contactShadow === false) return;
    const mat = new THREE.MeshBasicMaterial({ map: radialTexture(), color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false });
    const g = new THREE.PlaneGeometry(lenM, widM);
    g.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(g, mat);
    this.shadow.renderOrder = 1;
    this.object.add(this.shadow);
  }

  /** Common per-frame bookkeeping. Returns dt clamped. */
  protected begin(st: ModelState, dt: number): number {
    dt = Math.min(0.1, Math.max(0, dt));
    this.time += dt;
    this.object.position.copy(st.pos3);
    this.worldFx.position.copy(st.pos3).multiplyScalar(-1);
    this.k = st.scale ?? 1;
    this.s = this.upm * this.k;
    this.body.scale.setScalar(this.s);
    // heading + turn rate + accel (estimated if the caller did not pass them)
    const yawT = (this.opts.yawFromHeading ?? ((h: number) => h))(st.heading);
    if (!this.yawInit) { this.yaw = yawT; this.yawInit = true; }
    let d = (yawT - this.yaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
    const before = this.yaw;
    if (st.alive) this.yaw += d * damp(18, dt);
    const est = dt > 0 ? (this.yaw - before) / dt : 0;
    this.turn += ((st.turnRate ?? est) - this.turn) * damp(8, dt);
    const accEst = dt > 0 ? (st.speed - this.lastSpeed) / dt : 0;
    this.acc += ((st.accel ?? clamp(accEst, -8, 8)) - this.acc) * damp(5, dt);
    this.lastSpeed = st.speed;
    if (st.alive !== this.wasAlive) { this.deadT = 0; this.wasAlive = st.alive; this.onAliveChange(st.alive); }
    if (!st.alive) this.deadT += dt;
    this.refreshLook(st.alive);
    if (this.opts.yawFromHeading === undefined && this.shadow) this.shadow.rotation.y = this.yaw;
    return dt;
  }

  protected onAliveChange(_alive: boolean): void { /* per kind */ }

  /** Orient the body: align to the (smoothed) ground normal, yaw, then pitch (about z) and roll (about x). */
  protected orient(st: ModelState, pitch: number, roll: number, dt: number, followGround = true): void {
    const n = followGround && st.groundNormal ? st.groundNormal : UP;
    this.normal.lerp(n, damp(8, dt)).normalize();
    qa.setFromUnitVectors(UP, this.normal);
    qb.setFromAxisAngle(UP, this.yaw);
    qc.setFromEuler(ea.set(roll, 0, pitch, 'ZXY'));
    this.body.quaternion.copy(qa).multiply(qb).multiply(qc);
  }

  /** Smoke from a point in body space while dead. */
  protected smokeFrom(local: THREE.Vector3, on: boolean, dt: number): void {
    if (!on && !this.smoke) return;
    if (!this.smoke) { this.smoke = new Smoke(); this.worldFx.add(this.smoke.group); }
    this.body.updateMatrix();
    va.copy(local).applyMatrix4(this.body.matrix).add(this.object.position);
    this.smoke.update(on, va, 1.4 * this.s, dt);
  }

  private refreshLook(alive: boolean): void {
    const want = !alive ? 'dead' : this.intr ? 'intruder' : this.hl ? 'highlight' : 'base';
    if (want === 'highlight') sharedMats().highlight.emissiveIntensity = 0.3 + 0.2 * Math.sin(this.time * 5);
    if (want === this.look) return;
    this.look = want;
    const m = sharedMats()[want];
    for (const s of this.solids) s.material = m;
    this.onLook(want);
  }
  protected onLook(_l: Base['look']): void { /* per kind */ }

  setHighlight(on: boolean): void { this.hl = on; }
  setIntruder(on: boolean): void { this.intr = on; }
  anchor(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.object.position).add(this.body.position).addScaledVector(UP, 0.6 * this.s);
  }
  radius(): number { return this.boundR * this.s; }
  abstract update(st: ModelState, dt: number): void;
  dispose(): void {
    this.object.removeFromParent();
    this.smoke?.dispose();
    if (this.shadow) { this.shadow.geometry.dispose(); (this.shadow.material as THREE.Material).dispose(); }
    this.object.traverse((o) => { const im = o as THREE.InstancedMesh; if (im.isInstancedMesh) im.dispose(); });
    this.disposeOwn();
  }
  protected disposeOwn(): void { /* per kind */ }
}
