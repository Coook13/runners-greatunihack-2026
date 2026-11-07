// Height and slope of the terrain exactly as it is drawn: reads the terrain mesh's vertex grid and
// interpolates over the same two triangles per cell that three.js PlaneGeometry uses, so wheels sit
// on the visible surface (the analytic height field can float above or sink below the coarse mesh).
import * as THREE from 'three';
import { SCENE_SIZE } from './mapping';

export interface GroundSampler {
  /** Terrain height (scene units) at scene x, z. */
  height(x: number, z: number): number;
  /** Upward unit normal of the drawn triangle at scene x, z. */
  normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
}

/** `mesh` must be a PlaneGeometry(SCENE_SIZE, SCENE_SIZE, n, n) rotated flat, heights written into y. */
export function createGroundSampler(mesh: THREE.Mesh, size = SCENE_SIZE): GroundSampler {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const side = Math.round(Math.sqrt(pos.count));
  const n = side - 1;
  const cell = size / n;
  const hs = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) hs[i] = pos.getY(i);

  // locate (x, z) in the grid: cell index, fraction, and the four corner heights
  // corners: a = (ix, iz), b = (ix, iz+1), c = (ix+1, iz+1), d = (ix+1, iz); triangles (a,b,d) and (b,c,d)
  const q = { u: 0, v: 0, a: 0, b: 0, c: 0, d: 0 };
  function locate(x: number, z: number): typeof q {
    let u = (x + size / 2) / cell, v = (z + size / 2) / cell;
    u = Math.min(n - 1e-6, Math.max(0, u));
    v = Math.min(n - 1e-6, Math.max(0, v));
    const ix = Math.floor(u), iz = Math.floor(v);
    q.u = u - ix; q.v = v - iz;
    const i0 = ix + side * iz;
    q.a = hs[i0]; q.b = hs[i0 + side]; q.c = hs[i0 + side + 1]; q.d = hs[i0 + 1];
    return q;
  }

  return {
    height(x, z) {
      const { u, v, a, b, c, d } = locate(x, z);
      return u + v <= 1 ? a + (d - a) * u + (b - a) * v : c + (b - c) * (1 - u) + (d - c) * (1 - v);
    },
    normal(x, z, out) {
      const { u, v, a, b, c, d } = locate(x, z);
      const lower = u + v <= 1;
      const dhdx = (lower ? d - a : c - b) / cell;
      const dhdz = (lower ? b - a : c - d) / cell;
      return out.set(-dhdx, 1, -dhdz).normalize();
    },
  };
}
