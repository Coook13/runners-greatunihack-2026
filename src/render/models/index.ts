// Carrier models for the 3D renderer: real-looking procedural drone, motorbike, van, boat and the one
// plain crate, each with an animation controller, plus the motion smoother and readable-size scaling.
//
// Typical use per carrier (see the WP5 note in the report):
//   const model = createCarrierModel(n.kind, { unitsPerMetre: SCALE, seed: hashString(n.id) });
//   layer.add(model.object);
//   smoother.push(snapshot.t, now / 1000, n.pos.x, n.pos.y, n.alt ?? 0, n.heading);      // on each snapshot
//   const m = smoother.sample(now / 1000);                                               // every frame
//   model.update({ pos3, heading: m.heading, speed: m.speed, turnRate: m.turnRate, accel: m.accel,
//                  alt: n.alt, phase: n.phase, carrying: n.boxes.length, alive: n.alive,
//                  groundNormal, scale: scaleForDistance(camDist, n.kind, { unitsPerMetre: SCALE }) }, dt);
import * as THREE from 'three';
import type { CarrierKind } from '../../contracts/types';
import { radialTexture, sharedMats } from './assets';
import { BoatModel } from './boat';
import { Base, type CarrierModel, type ModelOptions, type ModelState, crateGeometry } from './common';
import { DroneModel } from './drone';
import { MotorbikeModel } from './motorbike';
import type { ModelKind } from './motion';
import { VanModel } from './van';

export type { CarrierModel, ModelOptions, ModelState } from './common';
export { CRATE, crateGeometry } from './common';
export { applyModelEnvironment, sharedMats } from './assets';
export { DRONE_CRUISE_ALT, DRONE_HANDOFF_ALT } from './drone';
export {
  MIN_SCREEN_PX, MODEL_LENGTH_M, altitudeScale, angleDiff, createMotionSmoother, damp, scaleForDistance, springStep,
  type ModelKind, type MotionSmoother, type MotionSmootherOptions, type MotionState, type ScaleOptions,
} from './motion';

/** The plain sealed crate on its own (on the ground at a hub or clinic). Same mesh as on every carrier. */
class CrateModel extends Base {
  readonly kind = 'crate' as const;
  private glow: THREE.Sprite | null = null;
  constructor(opts: ModelOptions = {}) {
    super(opts);
    this.boundR = 0.35;
    this.solid(crateGeometry());
    if (opts.crateGlow) {
      this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(), color: 0xffc070, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.45 }));
      this.glow.position.set(0, 0.14, 0);
      this.glow.scale.setScalar(1.1);
      this.body.add(this.glow);
    }
    this.addShadow(0.6, 0.5);
  }
  update(st: ModelState, dt: number): void {
    this.begin(st, dt);
    this.orient(st, 0, 0, dt);
    if (this.glow) { this.glow.visible = st.alive; this.glow.material.opacity = 0.35 + 0.12 * Math.sin(this.time * 2.4 + this.t0); }
    if (this.shadow) { this.shadow.rotation.y = this.yaw; this.shadow.scale.setScalar(this.s); }
  }
  protected disposeOwn(): void { this.glow?.material.dispose(); }
}

/** Build one model with its animation controller. Geometry and materials are shared across instances. */
export function createCarrierModel(kind: CarrierKind | 'crate', opts: ModelOptions = {}): CarrierModel {
  switch (kind) {
    case 'drone': return new DroneModel(opts);
    case 'motorbike': return new MotorbikeModel(opts);
    case 'van': return new VanModel(opts);
    case 'boat': return new BoatModel(opts);
    default: return new CrateModel(opts);
  }
}

export const MODEL_KINDS: ModelKind[] = ['drone', 'motorbike', 'van', 'boat', 'crate'];

/** Frees the shared geometries/materials (only on full teardown, after every model is disposed). */
export function disposeModelAssets(): void {
  const m = sharedMats();
  for (const mat of Object.values(m)) { (mat as THREE.Material & { map?: THREE.Texture | null }).map?.dispose(); (mat as THREE.Material).dispose(); }
}
