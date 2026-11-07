// Scene look: the backdrop colour behind the map, and the shared environment the carrier materials reflect.
import * as THREE from 'three';

export const BACKDROP = 0x0d1210;

let envTex: THREE.DataTexture | null = null;
/**
 * A soft sky-over-ground environment for the carrier materials, so paint, glass and metal read as PBR.
 * It is a plain equirect DataTexture (not a render target): every renderer runs its own PMREM on it,
 * so two renderers on one page can share the materials safely. Idempotent.
 */
export function ensureModelEnvironment(mats: THREE.MeshStandardMaterial[], intensity = 0.7): void {
  if (!envTex) {
    const w = 64, h = 32, data = new Uint8Array(w * h * 4);
    const sky = new THREE.Color(0xa9c4dc), horizon = new THREE.Color(0xf1e7d4), soil = new THREE.Color(0x4e4a38), c = new THREE.Color();
    for (let y = 0; y < h; y++) {
      const e = (y / (h - 1)) * 2 - 1;                    // -1 straight down .. +1 straight up
      if (e >= 0) c.copy(horizon).lerp(sky, Math.pow(e, 0.6)); else c.copy(horizon).lerp(soil, Math.min(1, -e * 4));
      for (let x = 0; x < w; x++) data.set([c.r * 255, c.g * 255, c.b * 255, 255], (y * w + x) * 4);
    }
    envTex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.SRGBColorSpace;
    envTex.magFilter = envTex.minFilter = THREE.LinearFilter;
    envTex.needsUpdate = true;
  }
  for (const m of mats) {
    if (m.envMap === envTex) continue;
    m.envMap = envTex;
    m.envMapIntensity = intensity;
    m.needsUpdate = true;
  }
}
