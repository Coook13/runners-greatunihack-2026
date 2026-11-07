// Mouse picking: click a node, click the ground, or (dead-zone tool) drag out a zone radius.
// A click is a press and release that moved less than CLICK_PX, so orbiting never fires a click.
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { NodeId, Tool, Vec2 } from '../contracts/types';
import { sceneToWorld } from './mapping';

const CLICK_PX = 6;
export const MIN_ZONE_M = 300;                          // drags shorter than this count as a plain click

export interface PickHost {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  terrain: THREE.Object3D;
  pickables(): THREE.Object3D[];                       // invisible pick spheres; userData.nodeId set
  tool(): Tool;
  nodeClick(id: NodeId): void;
  groundClick(pos: Vec2): void;
  zoneDraw(pos: Vec2, radiusM: number): boolean;        // false = nobody listens, fall back to groundClick
  zonePreview(centre: THREE.Vector3 | null, radiusScene: number): void;
}

export class Picker {
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private down: { x: number; y: number } | null = null;
  private zone: { centre: THREE.Vector3; plane: THREE.Plane; radius: number } | null = null;
  private hoverId: NodeId | null = null;

  constructor(private readonly h: PickHost) {
    h.canvas.addEventListener('pointerdown', this.onDown);
    h.canvas.addEventListener('pointermove', this.onMove);
    h.canvas.addEventListener('pointerup', this.onUp);
  }

  dispose(): void {
    this.h.canvas.removeEventListener('pointerdown', this.onDown);
    this.h.canvas.removeEventListener('pointermove', this.onMove);
    this.h.canvas.removeEventListener('pointerup', this.onUp);
  }

  private setRay(e: PointerEvent): void {
    const r = this.h.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.h.camera);
  }

  private nodeAt(e: PointerEvent): NodeId | null {
    this.setRay(e);
    const hit = this.ray.intersectObjects(this.h.pickables(), false)[0];
    return hit ? (hit.object.userData.nodeId as NodeId) : null;
  }

  private groundAt(e: PointerEvent): THREE.Vector3 | null {
    this.setRay(e);
    const hit = this.ray.intersectObject(this.h.terrain, false)[0];
    return hit ? hit.point.clone() : null;
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.down = { x: e.clientX, y: e.clientY };
    if (this.h.tool() === 'deadZone') {
      const g = this.groundAt(e);
      if (!g) return;
      // drag on a flat plane at the centre's height: cheap and steady
      this.zone = { centre: g, plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -g.y), radius: 0 };
      this.h.controls.enabled = false;
      this.h.canvas.setPointerCapture(e.pointerId);
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (this.zone) {
      this.setRay(e);
      const p = new THREE.Vector3();
      if (this.ray.ray.intersectPlane(this.zone.plane, p)) {
        this.zone.radius = Math.hypot(p.x - this.zone.centre.x, p.z - this.zone.centre.z);
        this.h.zonePreview(this.zone.centre, this.zone.radius);
      }
      return;
    }
    if (e.buttons !== 0) return;                        // orbiting: skip hover work
    const id = this.nodeAt(e);
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.h.canvas.style.cursor = id ? 'pointer' : this.h.tool() === 'select' ? '' : 'crosshair';
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.down) return;
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    this.down = null;
    if (this.zone) {
      const z = this.zone;
      this.zone = null;
      this.h.controls.enabled = true;
      this.h.zonePreview(null, 0);
      const centre = sceneToWorld(z.centre.x, z.centre.z);
      const radiusM = sceneToWorld(z.radius, 0).x - sceneToWorld(0, 0).x;
      if (radiusM >= MIN_ZONE_M && this.h.zoneDraw(centre, radiusM)) return;
      this.h.groundClick(centre);
      return;
    }
    if (moved > CLICK_PX) return;
    const id = this.nodeAt(e);
    if (id) return this.h.nodeClick(id);
    const g = this.groundAt(e);
    if (g) this.h.groundClick(sceneToWorld(g.x, g.z));
  };
}
