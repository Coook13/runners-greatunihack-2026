// Dead zones drawn as dark storm columns with falling rain, plus a preview for drag-to-place.
import * as THREE from 'three';
import type { Vec2 } from '../contracts/types';
import { SCALE, worldToScene } from './mapping';

const HEIGHT = 32;

/** Rain streaks (one per StormLayer, so renderers never share a texture). */
export function rainTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(52,62,78,0.42)';
  ctx.fillRect(0, 0, 128, 256);
  // deterministic streaks so the texture is identical every load
  let s = 12345;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  ctx.strokeStyle = 'rgba(225,235,250,0.55)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 70; i++) {
    const x = r() * 128, y = r() * 256, l = 12 + r() * 26;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 3, y + l); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** One storm column. Radius is in world metres. */
export function buildStorm(radiusM: number, rain: THREE.Texture = rainTexture()): THREE.Group {
  const g = new THREE.Group();
  const r = radiusM * SCALE;
  const tex = rain.clone();
  tex.repeat.set(Math.max(2, Math.round(r / 3)), 2);
  tex.needsUpdate = true;
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r * 1.08, HEIGHT, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, fog: true }),
  );
  wall.position.y = HEIGHT / 2;
  wall.name = 'wall';
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 0.98, r * 1.05, HEIGHT, 48, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x1d232c, transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false }),
  );
  core.position.y = HEIGHT / 2;
  // cloud cap: a squashed dark dome
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(r * 1.15, 20, 8),
    new THREE.MeshStandardMaterial({ color: 0x5d6673, flatShading: true, transparent: true, opacity: 0.72, roughness: 1, depthWrite: false }),
  );
  cap.scale.y = 0.16;
  cap.position.y = HEIGHT;
  cap.name = 'cap';
  // dark footprint on the ground
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(r, 48),
    new THREE.MeshBasicMaterial({ color: 0x10151c, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.1;
  shadow.name = 'shadow';
  g.add(wall, core, cap, shadow);
  g.userData.radiusM = radiusM;
  return g;
}

/** Keep storm meshes in sync with the snapshot's dead zones (matched by index). */
export class StormLayer {
  readonly group = new THREE.Group();
  private storms: THREE.Group[] = [];
  private readonly rain = rainTexture();

  sync(zones: { pos: Vec2; radius: number }[], groundAt: (p: Vec2) => number): void {
    while (this.storms.length > zones.length) disposeGroup(this.group, this.storms.pop()!);
    zones.forEach((z, i) => {
      let s = this.storms[i];
      if (!s || Math.abs((s.userData.radiusM as number) - z.radius) > 1) {
        if (s) disposeGroup(this.group, s);
        s = buildStorm(z.radius, this.rain);
        this.storms[i] = s;
        this.group.add(s);
      }
      const sc = worldToScene(z.pos);
      s.position.set(sc.x, 0, sc.z);
      (s.getObjectByName('shadow') as THREE.Mesh).position.y = groundAt(z.pos) + 0.4;
    });
  }

  /** Animate rain and slowly churn the clouds. */
  animate(timeSec: number): void {
    for (const s of this.storms) {
      const wall = s.getObjectByName('wall') as THREE.Mesh;
      const map = (wall.material as THREE.MeshBasicMaterial).map!;
      map.offset.y = timeSec * 0.9;
      map.offset.x = timeSec * 0.02;
      s.getObjectByName('cap')!.rotation.y = timeSec * 0.05;
    }
  }
}

/** Translucent ring shown while dragging out a new dead zone. */
export function buildZonePreview(): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 30, 48, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x2c3440, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
  );
  m.visible = false;
  return m;
}

function disposeGroup(parent: THREE.Object3D, g: THREE.Group): void {
  parent.remove(g);
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | undefined;
    if (mat) {
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    }
  });
}
