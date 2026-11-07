// Overlays for nodes: selection / highlight rings and fading trails. The carriers themselves are the
// procedural models in ./models.
import * as THREE from 'three';
import type { CarrierKind } from '../contracts/types';

/** Flat ring under a node: white for selection, amber for highlight, red for intruders. */
export function buildRing(color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 1.85, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  return m;
}

// ---------- trails ----------
export const TRAIL_COLORS: Record<CarrierKind, number> = { drone: 0x7fdcff, motorbike: 0xff7a2f, van: 0x3d6fe0, boat: 0x00b39b };

/** A fading line behind a carrier: newest point is bright, oldest fades out. */
export class Trail {
  readonly line: THREE.Line;
  private pts: THREE.Vector3[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly base: THREE.Color;
  bright = 1;                                            // >1 when highlighted

  constructor(color: number, private readonly max = 90, private readonly minStep = 0.6) {
    this.base = new THREE.Color(color);
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.line.frustumCulled = false;
  }

  /** Add the carrier's current position if it moved far enough, then refresh the buffers. */
  push(p: THREE.Vector3): void {
    const last = this.pts[this.pts.length - 1];
    if (last && last.distanceToSquared(p) < this.minStep * this.minStep) {
      last.copy(p);                                    // keep the head glued to the carrier
    } else {
      this.pts.push(p.clone());
      if (this.pts.length > this.max) this.pts.shift();
    }
    this.refresh();
  }

  clear(): void { this.pts = []; this.refresh(); }

  private refresh(): void {
    const n = this.pts.length;
    for (let i = 0; i < n; i++) {
      const p = this.pts[i];
      this.pos.set([p.x, p.y, p.z], i * 3);
      const a = Math.pow(i / Math.max(1, n - 1), 1.6) * 0.9 * this.bright;
      this.col.set([this.base.r, this.base.g, this.base.b, Math.min(1, a)], i * 4);
    }
    const geo = this.line.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, n);
  }
}
