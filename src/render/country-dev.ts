// Dev page for the country layer: the real district terrain + roads, the country layer, OrbitControls.
// Open /src/render/country-dev.html. window.__cdev.view(dist, tilt) jumps the camera for screenshots.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { WORLD_SIZE } from '../contracts/config';
import { SCALE, WATER_LEVEL, worldToScene } from './mapping';
import { buildRealRoads, buildRealTerrain, buildRealWater, makeRealField } from './realmap';
import { attachCountryLayer, styleDistrictRoads } from './country';
import { BACKDROP } from './look';

export function mountCountryDev(root: HTMLElement): void {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  root.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(BACKDROP, 1);
  const labels = new CSS2DRenderer();
  Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  root.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKDROP);
  scene.fog = new THREE.Fog(BACKDROP, 900, 2600);
  scene.add(new THREE.HemisphereLight(0xfff1d6, 0x6b6a3a, 1.25));
  const sun = new THREE.DirectionalLight(0xffe0b0, 2.6);
  sun.position.set(-180, 260, 140);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 3000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = 1.3;
  controls.minDistance = 0.8;
  controls.screenSpacePanning = false;

  const field = makeRealField();
  const terrain = buildRealTerrain(field, '/geo/', renderer.capabilities.getMaxAnisotropy());
  terrain.setLayer('sat');
  const water = buildRealWater();
  water.setLayer('sat');
  const roads = buildRealRoads(field);
  roads.setLayer('sat');
  styleDistrictRoads(roads.group);
  scene.add(terrain.mesh, water.group, roads.group);

  const groundAt = (x: number, y: number) => Math.max(field.heightAt({ x, y }), WATER_LEVEL);
  const country = attachCountryLayer({
    scene, camera, controls, renderer, unitsPerMetre: SCALE, districtSize: WORLD_SIZE,
    toScene: (x, y) => { const s = worldToScene({ x, y }); return new THREE.Vector3(s.x, groundAt(x, y), s.z); },
  });

  const view = (dist: number, tilt = 0.38, tx = 0, tz = 0) => {
    controls.target.set(tx, 5, tz);
    camera.position.set(tx, 5 + dist * Math.cos(tilt), tz + dist * Math.sin(tilt));
    controls.update();
  };
  view(620);
  (window as unknown as { __cdev: unknown }).__cdev = { view, camera, controls, scene, country };

  const resize = () => {
    const w = root.clientWidth || window.innerWidth, h = root.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    labels.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();
  const frame = () => {
    requestAnimationFrame(frame);
    country.update();
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
  };
  frame();
}
