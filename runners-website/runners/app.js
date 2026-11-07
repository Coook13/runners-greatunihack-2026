import * as THREE from './vendor/three.module.js';

/* The SVG is the single source of truth for the route. MotionPathPlugin moves a
   plain coordinate object; the same path is sampled into a lit 3D road ribbon.
   No coordinate comes from the SVG's responsive CSS dimensions. */
const ROAD = 'M 480 60 C 910 90 960 430 730 610 C 490 800 90 660 165 1010 C 215 1270 940 1130 855 1490 C 790 1770 95 1650 145 2010 C 190 2310 950 2130 885 2510 C 830 2810 110 2670 170 3030 C 225 3330 950 3140 850 3510 C 770 3800 150 3660 200 4000 C 245 4300 820 4190 735 4520 C 690 4700 485 4780 485 4910';
const { gsap, ScrollTrigger, MotionPathPlugin } = window;
const chapters = [...document.querySelectorAll('.chapter')];
const canvas = document.querySelector('#scene');
const routeElement = document.querySelector('#route-path');
routeElement.setAttribute('d', ROAD);
document.querySelector('.route-edge')?.setAttribute('d', ROAD);
gsap.registerPlugin(ScrollTrigger, MotionPathPlugin);

const rawPath = MotionPathPlugin.getRawPath(ROAD);
MotionPathPlugin.cacheRawPathMeasurements(rawPath);
const routeLength = routeElement.getTotalLength();
const routePoint = { x: 480, y: 60 };
const routeTween = gsap.to(routePoint, {
  duration: 1, paused: true, ease: 'none', motionPath: { path: ROAD },
});
let progress = 0;
let networkDown = false;
let reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let currentChapter = -1;
let renderer, scene, camera, van, keyLight, vanShadow, meshLines;
let frame = 0;
const wheels = [], drones = [], dust = [];
const up = new THREE.Vector3(0, 1, 0);
const dummy = new THREE.Object3D();
const clock = new THREE.Clock();

function rng(seed = 60423) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const random = rng();
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);
const heightAt = (x, z) => Math.sin(z * .023) * 1.3 + Math.cos(x * .046 + z * .009) * 1.35 + Math.sin(x * .1 - z * .018) * .34;

function svgAt(t) {
  return MotionPathPlugin.getPositionOnPath(rawPath, clamp(t, 0, 1), true);
}
function worldAt(t) {
  const p = svgAt(t);
  const x = (p.x - 500) * .112, z = (p.y - 60) * .105;
  return new THREE.Vector3(x, heightAt(x, z) + .13, z);
}
function headingAt(t, radius = .0015) {
  return worldAt(Math.min(1, t + radius)).sub(worldAt(Math.max(0, t - radius))).normalize();
}

const roadSamples = Array.from({ length: 701 }, (_, i) => worldAt(i / 700));
function distanceFromRoad(x, z) {
  let min = Infinity;
  for (let i = 0; i < roadSamples.length; i += 3) {
    const p = roadSamples[i], d = (x - p.x) ** 2 + (z - p.z) ** 2;
    if (d < min) min = d;
  }
  return Math.sqrt(min);
}

function texture(size, painter) {
  const element = document.createElement('canvas');
  element.width = element.height = size;
  painter(element.getContext('2d'), size);
  const result = new THREE.CanvasTexture(element);
  result.colorSpace = THREE.SRGBColorSpace;
  result.anisotropy = 8;
  return result;
}
function groundTexture(road = false) {
  const t = texture(512, (ctx, n) => {
    ctx.fillStyle = road ? '#ad9771' : '#b7b18a'; ctx.fillRect(0, 0, n, n);
    const r = rng(road ? 240 : 81);
    for (let i = 0; i < 31000; i++) {
      const shade = Math.floor(80 + r() * 110);
      ctx.fillStyle = `rgba(${shade + 15},${shade + 4},${shade - 18},${r() * .22})`;
      const s = r() * (road ? 2 : 4) + .5;
      ctx.fillRect(r() * n, r() * n, s, s);
    }
    if (road) {
      for (const x of [.29, .71]) {
        const g = ctx.createLinearGradient((x - .11) * n, 0, (x + .11) * n, 0);
        g.addColorStop(0, 'rgba(75,58,40,0)'); g.addColorStop(.5, 'rgba(75,58,40,.19)'); g.addColorStop(1, 'rgba(75,58,40,0)');
        ctx.fillStyle = g; ctx.fillRect((x - .11) * n, 0, n * .22, n);
      }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (!road) t.repeat.set(35, 100);
  return t;
}

function material(color, roughness = .8, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, ...extra });
}
const mats = {
  white: material('#f3f1e8', .34, { metalness: .18 }),
  trim: material('#252c28', .65), glass: material('#233d43', .14, { metalness: .38 }),
  tire: material('#242824', .97), metal: material('#89918b', .35, { metalness: .75 }),
  orange: material('#e26435', .5), red: material('#a13023', .4),
  leaf: material('#697151', 1), trunk: material('#6e624c', 1),
  carton: material('#b7a07a', 1), wall: material('#d5cfb7', .95),
};
function box(parent, w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}
function cylinder(parent, radius, length, mat, x, y, z, axis = 'y', segments = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), mat);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
}
function panel(parent, coords, mat) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat); parent.add(m); return m;
}
function labelMap(text, background = '#f3f1e8', color = '#354334') {
  return texture(512, (ctx, n) => {
    ctx.fillStyle = background; ctx.fillRect(0, 0, n, n);
    ctx.fillStyle = color; ctx.font = 'bold 76px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, n / 2, n / 2);
    ctx.fillStyle = '#df6338'; ctx.fillRect(n * .12, n * .68, n * .76, 9);
  });
}

function makeVan() {
  const car = new THREE.Group();
  box(car, 1.88, 1.55, 2.8, mats.white, 0, 1.18, -.62);
  box(car, 1.87, .91, 1.4, mats.white, 0, .93, 1.18);
  box(car, 1.77, .11, 1.16, mats.white, 0, 1.92, .82);
  panel(car, [-.875, 1.34, 1.94, .875, 1.34, 1.94, .875, 1.87, 1.32, -.875, 1.87, 1.32], mats.glass);
  // Window glass is double sided so both side camera angles remain convincing.
  const sideGlass = mats.glass.clone(); sideGlass.side = THREE.DoubleSide;
  for (const side of [-1, 1]) {
    panel(car, [side * .944, 1.29, .44, side * .944, 1.29, 1.83, side * .944, 1.83, 1.26, side * .944, 1.83, .44], sideGlass);
    box(car, .025, .59, .045, mats.white, side * .96, 1.56, .51);
    box(car, .038, .045, .23, mats.trim, side * .96, 1.06, .66);
    box(car, .16, .18, .32, mats.trim, side * 1.06, 1.36, 1.15);
    box(car, .04, .12, 2.78, mats.trim, side * .95, .65, -.62);
    const branding = new THREE.Mesh(new THREE.PlaneGeometry(1.93, .95), new THREE.MeshStandardMaterial({ map: labelMap('RUNNERS'), roughness: .6, side: THREE.DoubleSide }));
    branding.rotation.y = side * Math.PI / 2;
    branding.position.set(side * .947, 1.27, -.66); car.add(branding);
    box(car, .03, 1.2, .018, mats.wall, side * .955, 1.24, -.07);
  }
  box(car, 1.93, .19, .16, mats.trim, 0, .52, 1.98);
  box(car, 1.92, .15, .14, mats.trim, 0, .48, -2.08);
  box(car, .72, .15, .04, mats.trim, 0, .86, 1.9);
  for (let i = 0; i < 4; i++) box(car, .64, .012, .035, mats.metal, 0, .81 + i * .037, 1.925);
  for (const side of [-1, 1]) {
    box(car, .41, .16, .045, material('#eee9cf', .15, { emissive: '#e1c995', emissiveIntensity: .22 }), side * .67, 1.02, 1.92);
    box(car, .17, .4, .035, mats.red, side * .75, .99, -2.035);
    for (const z of [-1.32, 1.31]) {
      const wheel = new THREE.Group(); wheel.position.set(side * .96, .39, z);
      cylinder(wheel, .375, .24, mats.tire, 0, 0, 0, 'x', 32);
      cylinder(wheel, .215, .257, mats.metal, 0, 0, 0, 'x', 24);
      cylinder(wheel, .085, .27, mats.trim, 0, 0, 0, 'x');
      for (let i = 0; i < 6; i++) {
        const lug = new THREE.Mesh(new THREE.SphereGeometry(.022, 5, 4), mats.trim);
        lug.position.set(side * .14, Math.sin(i * Math.PI / 3) * .14, Math.cos(i * Math.PI / 3) * .14); wheel.add(lug);
      }
      car.add(wheel); wheels.push(wheel);
    }
  }
  box(car, .025, 1.38, .025, mats.wall, 0, 1.21, -2.033);
  box(car, .18, .045, .04, mats.trim, .12, 1.11, -2.06);
  box(car, .38, .13, .03, mats.white, 0, .65, -2.065);
  box(car, 1.5, .07, 2.4, mats.metal, 0, 2.0, -.6);
  box(car, 1.53, .06, .09, mats.trim, 0, 2.08, -1.45);
  box(car, 1.53, .06, .09, mats.trim, 0, 2.08, .18);
  return car;
}

function ribbon(width, offset = 0, lift = .02) {
  const vertices = [], uv = [], indices = [];
  let distance = 0;
  for (let i = 0; i < roadSamples.length; i++) {
    const p = roadSamples[i];
    if (i) distance += p.distanceTo(roadSamples[i - 1]);
    const a = roadSamples[Math.max(0, i - 1)], b = roadSamples[Math.min(roadSamples.length - 1, i + 1)];
    const tangent = b.clone().sub(a).normalize(), side = new THREE.Vector3(tangent.z, 0, -tangent.x);
    for (const edge of [-.5, .5]) {
      const q = p.clone().addScaledVector(side, edge * width + offset);
      vertices.push(q.x, heightAt(q.x, q.z) + lift, q.z); uv.push(edge + .5, distance / 7);
    }
    if (i < roadSamples.length - 1) {
      const j = i * 2; indices.push(j, j + 2, j + 1, j + 1, j + 2, j + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(indices); geo.computeVertexNormals(); return geo;
}

function makeTerrain() {
  const geo = new THREE.PlaneGeometry(235, 650, 112, 260);
  geo.rotateX(-Math.PI / 2); geo.translate(0, 0, 245);
  const pos = geo.attributes.position, colors = [], c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i); pos.setY(i, heightAt(x, z));
    const blend = (Math.sin(x * .08 + z * .022) + Math.cos(z * .048)) * .045;
    c.setHSL(.155 + blend * .15, .15, .64 + blend); colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, material('#e4d9b8', 1, { map: groundTexture(), vertexColors: true }));
  ground.receiveShadow = true; scene.add(ground);
  const dirtMap = groundTexture(true);
  const shoulder = new THREE.Mesh(ribbon(6.3, 0, .052), material('#b4a17c', 1)); shoulder.receiveShadow = true; scene.add(shoulder);
  const road = new THREE.Mesh(ribbon(5.15, 0, .09), material('#c2ab86', 1, { map: dirtMap, bumpMap: dirtMap, bumpScale: .06 }));
  road.receiveShadow = true; scene.add(road);
  const start = worldAt(0), end = worldAt(1);
  for (const point of [start, end]) {
    const cap = new THREE.Mesh(new THREE.CircleGeometry(2.65, 40), material('#b3a07b', 1, { map: dirtMap }));
    cap.rotation.x = -Math.PI / 2; cap.position.copy(point); cap.position.y += .015; cap.receiveShadow = true; scene.add(cap);
  }
  const stop = new THREE.Group(); stop.position.copy(end); stop.rotation.y = Math.atan2(headingAt(1).x, headingAt(1).z);
  box(stop, 4.7, .025, .18, mats.white, 0, .025, 2.1); scene.add(stop);
}

function makeScenery() {
  const shrubGeo = new THREE.IcosahedronGeometry(1, 1);
  const shrubs = new THREE.InstancedMesh(shrubGeo, mats.leaf, 650);
  const rockMat = material('#9b9988', .99);
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMat, 300);
  let count = 0;
  while (count < 650) {
    const x = (random() - .5) * 198, z = random() * 590 - 45;
    if (distanceFromRoad(x, z) < 4.4) continue;
    const scale = .3 + random() * 1.15;
    dummy.position.set(x, heightAt(x, z) + scale * .3, z);
    dummy.scale.set(scale, scale * (.25 + random() * .35), scale * .8);
    dummy.rotation.set(0, random() * 6.28, 0); dummy.updateMatrix();
    shrubs.setMatrixAt(count, dummy.matrix); shrubs.setColorAt(count, new THREE.Color().setHSL(.19 + random() * .035, .16 + random() * .1, .26 + random() * .13)); count++;
  }
  count = 0;
  while (count < 300) {
    const x = (random() - .5) * 180, z = random() * 565 - 35;
    if (distanceFromRoad(x, z) < 3.25) continue;
    const s = .12 + random() * .62;
    dummy.position.set(x, heightAt(x, z) + s * .15, z); dummy.scale.set(s * 1.4, s * .55, s);
    dummy.rotation.set(random(), random() * 6.28, random()); dummy.updateMatrix(); rocks.setMatrixAt(count++, dummy.matrix);
  }
  shrubs.receiveShadow = true; rocks.receiveShadow = true; scene.add(shrubs, rocks);

  for (let i = 0; i < 32; i++) {
    const p = worldAt((i + .3) / 33), side = i % 2 ? 1 : -1;
    p.x += side * (13 + random() * 38); p.y = heightAt(p.x, p.z);
    if (distanceFromRoad(p.x, p.z) < 8) continue;
    const tree = new THREE.Group(); tree.position.copy(p);
    cylinder(tree, .12, 3.8, mats.trunk, 0, 1.9, 0, 'y', 7);
    const branch = cylinder(tree, .07, 1.7, mats.trunk, .45, 3.2, 0, 'y', 6); branch.rotation.z = -.75;
    for (const [x, y, z, s] of [[0, 4.1, 0, 2.8], [1.7, 3.7, .4, 1.6], [-1.5, 3.9, -.3, 1.9]]) {
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), mats.leaf);
      crown.position.set(x, y, z); crown.scale.set(s, s * .3, s * .8); crown.castShadow = true; tree.add(crown);
    }
    const s = .7 + random() * .5; tree.scale.setScalar(s); scene.add(tree);
  }
  // Waypoint posts are placed at the exact same five MotionPath progress stops.
  for (let i = 0; i < 5; i++) {
    const p = worldAt(i / 4), tangent = headingAt(i / 4), side = new THREE.Vector3(tangent.z, 0, -tangent.x);
    p.addScaledVector(side, 4.0); p.y = heightAt(p.x, p.z);
    const post = new THREE.Group(); post.position.copy(p);
    cylinder(post, .055, 1.6, mats.metal, 0, .8, 0);
    const plate = box(post, .7, .7, .08, mats.orange, 0, 1.6, 0);
    plate.rotation.y = Math.atan2(tangent.x, tangent.z);
    scene.add(post);
  }
  makeClinic(); makeRelay();
}

function makeClinic() {
  const p = worldAt(1); p.x += 10; p.z += 1; p.y = heightAt(p.x, p.z);
  const clinic = new THREE.Group(); clinic.position.copy(p);
  box(clinic, 8, 3.4, 5.8, mats.wall, 0, 1.7, 0);
  const roof = box(clinic, 9, .23, 6.7, mats.leaf, 0, 3.6, 0); roof.rotation.z = .035;
  box(clinic, 1.2, 2.3, .06, mats.trim, -.6, 1.15, 2.94);
  for (const x of [-2.7, 2.1]) {
    box(clinic, 1.35, 1.1, .07, mats.glass, x, 1.85, 2.96);
    box(clinic, .045, 1.1, .09, mats.white, x, 1.85, 2.98);
  }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.0), new THREE.MeshStandardMaterial({ map: labelMap('CLINIC') }));
  sign.position.set(-.4, 2.97, 2.99); clinic.add(sign);
  box(clinic, 8.9, .2, 2.1, mats.wall, 0, .1, 3.7);
  scene.add(clinic);
}
function makeRelay() {
  const p = worldAt(.51); p.x += 8; p.y = heightAt(p.x, p.z);
  const hub = new THREE.Group(); hub.position.copy(p);
  const roof = box(hub, 5.5, .14, 4.0, mats.leaf, 0, 3.1, 0); roof.rotation.z = -.08;
  for (const x of [-2.45, 2.45]) for (const z of [-1.65, 1.65]) cylinder(hub, .075, 3.0, mats.metal, x, 1.5, z);
  for (const [x, y, z] of [[-.8, .4, .2], [.25, .4, .2], [-.2, 1.1, .2]]) {
    box(hub, .94, .64, .8, mats.carton, x, y, z); box(hub, .1, .65, .81, mats.orange, x, y, z);
  }
  // A parked relay motorbike adds the second ground carrier to the scene.
  const bike = new THREE.Group(); bike.position.set(3.8, 0, .6);
  for (const z of [-.72, .72]) {
    cylinder(bike, .36, .15, mats.tire, 0, .36, z, 'x');
    cylinder(bike, .24, .16, mats.metal, 0, .36, z, 'x');
  }
  const frame = cylinder(bike, .06, 1.65, mats.metal, 0, .56, 0, 'z'); frame.rotation.x = .2;
  box(bike, .48, .22, .72, mats.trim, 0, .95, -.17);
  box(bike, .55, .46, .55, mats.carton, 0, 1.28, -.63);
  cylinder(bike, .025, .8, mats.metal, 0, 1.18, .66, 'x');
  hub.add(bike); scene.add(hub);
}

function makeDrone() {
  const drone = new THREE.Group();
  box(drone, .8, .23, .75, mats.white);
  for (const angle of [-Math.PI / 4, Math.PI / 4]) {
    const arm = box(drone, 2.9, .08, .1, mats.trim); arm.rotation.y = angle;
  }
  const rotors = [];
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    cylinder(drone, .13, .2, mats.metal, x, .1, z);
    const rotor = box(drone, .92, .015, .07, mats.trim, x, .23, z); rotors.push(rotor);
  }
  box(drone, .62, .42, .62, mats.carton, 0, -.42, 0);
  box(drone, .08, .43, .63, mats.orange, 0, -.42, 0);
  drone.userData.rotors = rotors; return drone;
}

function makeMesh() {
  for (let i = 0; i < 3; i++) {
    const drone = makeDrone(); drone.userData.index = i; scene.add(drone); drones.push(drone);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(18), 3));
  meshLines = new THREE.LineSegments(geometry, new THREE.LineDashedMaterial({ color: '#a9b483', transparent: true, opacity: .65, dashSize: .35, gapSize: .25 }));
  meshLines.frustumCulled = false; scene.add(meshLines);
}

function createMap() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const map = document.createElementNS(svgNS, 'svg');
  map.setAttribute('viewBox', '0 0 1000 5000'); map.setAttribute('aria-hidden', 'true'); map.classList.add('journey-map');
  const road = document.createElementNS(svgNS, 'path'); road.setAttribute('d', ROAD); road.setAttribute('fill', 'none'); road.setAttribute('stroke', 'currentColor'); road.setAttribute('stroke-width', '32'); road.setAttribute('opacity', '.28');
  map.append(road);
  for (let i = 0; i < 5; i++) {
    const p = svgAt(i / 4), point = document.createElementNS(svgNS, 'circle');
    point.setAttribute('cx', p.x); point.setAttribute('cy', p.y); point.setAttribute('r', '40'); point.setAttribute('fill', 'currentColor'); map.append(point);
  }
  const cursor = document.createElementNS(svgNS, 'circle'); cursor.setAttribute('r', '65'); cursor.setAttribute('fill', '#df6338'); map.append(cursor);
  document.body.append(map); return cursor;
}
const mapCursor = createMap();

function initScene() {
  scene = new THREE.Scene(); scene.background = new THREE.Color('#e7e3d5');
  scene.fog = new THREE.FogExp2('#e7e3d5', .0052);
  camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .15, 700);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65)); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  scene.add(new THREE.HemisphereLight('#fff8e7', '#71755c', 2.6));
  keyLight = new THREE.DirectionalLight('#fff1d7', 3.2); keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048); keyLight.shadow.camera.left = -45; keyLight.shadow.camera.right = 45;
  keyLight.shadow.camera.top = 45; keyLight.shadow.camera.bottom = -45; keyLight.shadow.camera.near = 1; keyLight.shadow.camera.far = 140;
  keyLight.shadow.normalBias = .04; keyLight.shadow.bias = -.00015; scene.add(keyLight, keyLight.target);
  makeTerrain(); makeScenery(); makeMesh();
  van = makeVan(); scene.add(van);
  const shadowTexture = texture(128, (ctx, n) => {
    const g = ctx.createRadialGradient(n / 2, n / 2, 3, n / 2, n / 2, n / 2);
    g.addColorStop(0, 'rgba(36,32,22,.48)'); g.addColorStop(1, 'rgba(36,32,22,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, n, n);
  });
  vanShadow = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 5.6), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }));
  vanShadow.rotation.x = -Math.PI / 2; scene.add(vanShadow);
  const dustTexture = texture(64, (ctx, n) => {
    const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, 'rgba(202,182,142,.5)'); g.addColorStop(1, 'rgba(202,182,142,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, n, n);
  });
  for (let i = 0; i < 10; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTexture, transparent: true, opacity: 0, depthWrite: false }));
    scene.add(sprite); dust.push(sprite);
  }
  renderer.setAnimationLoop(render);
}

const CAMERAS = [
  { side: 17, height: 19, back: -23, fov: 43, x: .67, y: .58, label: '01 / FOLLOW' },
  { side: 12.2, height: 4.5, back: -1.6, fov: 40, x: .67, y: .59, label: '02 / SIDE PROFILE' },
  { side: 23, height: 30, back: -25, fov: 45, x: .66, y: .59, label: '03 / MESH OVERVIEW' },
  { side: 15, height: 21, back: -16, fov: 42, x: .68, y: .59, label: '04 / CHAIN OF CUSTODY' },
  { side: 9.3, height: 9.5, back: -15, fov: 39, x: .5, y: .35, label: '05 / ARRIVAL' },
];
const cameraPosition = new THREE.Vector3(), lookPosition = new THREE.Vector3();
let previousProgress = 0;
function cameraSettings() {
  const phase = progress * 4, index = Math.min(3, Math.floor(phase));
  const t = smoother(clamp(phase - index, 0, 1));
  const a = CAMERAS[index], b = CAMERAS[index + 1];
  const result = {};
  for (const key of ['side', 'height', 'back', 'fov', 'x', 'y']) result[key] = lerp(a[key], b[key], t);
  if (reducedMotion) Object.assign(result, { side: 19, height: 23, back: -24, fov: 43 });
  if (innerWidth < 760) { result.x = .5; result.y = lerp(.67, .34, smoother(clamp((progress - .77) / .23, 0, 1))); result.side *= 1.2; result.height *= 1.2; result.back *= 1.2; }
  return result;
}
function render() {
  const elapsed = clock.getElapsedTime();
  const p = new THREE.Vector3((routePoint.x - 500) * .112, 0, (routePoint.y - 60) * .105);
  p.y = heightAt(p.x, p.z) + .13;
  const forward = headingAt(progress), cameraForward = headingAt(progress, .027);
  const right = new THREE.Vector3().crossVectors(up, cameraForward).normalize();
  van.position.copy(p); van.rotation.set(-Math.asin(forward.y), Math.atan2(forward.x, forward.z), 0, 'YXZ');
  wheels.forEach(wheel => { wheel.rotation.x = progress * routeLength * .108 / .375; });
  vanShadow.position.set(p.x, p.y + .012, p.z); vanShadow.rotation.z = -van.rotation.y;
  const c = cameraSettings();
  lookPosition.copy(p).addScaledVector(up, 1.0);
  cameraPosition.copy(lookPosition).addScaledVector(right, c.side).addScaledVector(cameraForward, c.back).addScaledVector(up, c.height);
  camera.position.copy(cameraPosition); camera.fov = c.fov;
  camera.setViewOffset(innerWidth, innerHeight, (.5 - c.x) * innerWidth, (.5 - c.y) * innerHeight, innerWidth, innerHeight);
  camera.lookAt(lookPosition); camera.updateProjectionMatrix();
  keyLight.position.copy(p).add(new THREE.Vector3(-28, 52, 24)); keyLight.target.position.copy(p);
  const fleetVisibility = smoother(clamp((progress - .28) / .12, 0, 1)) * (1 - smoother(clamp((progress - .76) / .13, 0, 1)));
  const linePositions = meshLines.geometry.attributes.position;
  drones.forEach((drone, i) => {
    drone.visible = fleetVisibility > .001;
    drone.scale.setScalar(Math.max(.001, fleetVisibility));
    drone.position.copy(p).addScaledVector(right, [-7, 7, 2][i]).addScaledVector(cameraForward, [5, 9, 16][i]);
    drone.position.y += [6, 9, 7][i] + (reducedMotion ? 0 : Math.sin(elapsed * 1.4 + i * 2) * .18);
    drone.rotation.y = van.rotation.y + i * .4;
    drone.userData.rotors.forEach(rotor => { rotor.rotation.y = reducedMotion ? 0 : elapsed * 35; });
    linePositions.setXYZ(i * 2, p.x, p.y + 2, p.z);
    linePositions.setXYZ(i * 2 + 1, drone.position.x, drone.position.y - .5, drone.position.z);
  });
  linePositions.needsUpdate = true; meshLines.computeLineDistances();
  meshLines.visible = fleetVisibility > .01; meshLines.material.opacity = fleetVisibility * .6;
  meshLines.material.color.set(networkDown ? '#6f805c' : '#dc8258');
  const movement = Math.min(1, Math.abs(progress - previousProgress) * 1400);
  dust.forEach((sprite, i) => {
    const d = (i + 1) * .43;
    sprite.position.copy(p).addScaledVector(forward, -2 - d).addScaledVector(right, Math.sin(i * 4) * .65);
    sprite.position.y += .3 + i * .08;
    sprite.scale.setScalar(1.5 + i * .25); sprite.material.opacity = reducedMotion ? 0 : movement * .18 * (1 - i / 11);
  });
  previousProgress = progress;
  renderer.render(scene, camera); frame++;
  if (frame === 2) finishLoading();
}

function finishLoading() {
  document.body.classList.add('scene-ready');
  const loader = document.querySelector('#scene-loader');
  if (loader) { loader.classList.add('is-loaded'); loader.setAttribute('aria-hidden', 'true'); setTimeout(() => loader.remove(), 650); }
}

const chapterNames = ['THE MISSION', 'THE PROBLEM', 'THE MESH', 'THE GUARANTEES', 'THE DEMO'];
const chapterCaptions = ['A shared goal. A road that keeps going.', 'What a carrier knows can put a shipment at risk.', 'The signal drops. The mission continues.', 'Sealed boxes. Signed hand-offs. An accountable journey.', 'The road ends. The story is ready to play.'];
function updateUI(value) {
  progress = clamp(value, 0, 1); routeTween.progress(progress);
  const index = Math.min(4, Math.floor(progress * 4 + .5));
  document.querySelector('#scroll-progress')?.style.setProperty('transform', `scaleX(${progress})`);
  mapCursor.setAttribute('cx', routePoint.x); mapCursor.setAttribute('cy', routePoint.y);
  document.body.dataset.parked = String(progress > .998);
  document.body.classList.toggle('at-destination', progress > .87);
  if (index !== currentChapter) {
    currentChapter = index; document.body.dataset.chapter = String(index);
    const number = document.querySelector('#chapter-number'), name = document.querySelector('#chapter-name');
    if (number) number.textContent = String(index + 1).padStart(2, '0');
    if (name) name.textContent = chapterNames[index];
    const mode = document.querySelector('#camera-mode'); if (mode) mode.textContent = CAMERAS[index].label;
    const caption = document.querySelector('#scene-caption'); if (caption) caption.textContent = chapterCaptions[index];
    document.querySelectorAll('.chapter-link').forEach(link => {
      const active = Number(link.dataset.index) === index;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'step'); else link.removeAttribute('aria-current');
    });
  }
  if (!renderer) updateFallback();
}

let navigating = false, navTimer;
function sectionScroll(index) {
  index = clamp(index, 0, 4); navigating = true;
  clearTimeout(navTimer);
  window.scrollTo({ top: chapters[index].offsetTop, behavior: reducedMotion ? 'instant' : 'smooth' });
  navTimer = setTimeout(() => { navigating = false; }, 1300);
}
let stops = [];
function refreshStops() {
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  stops = chapters.map(chapter => Math.min(1, chapter.offsetTop / max));
}
function mapProgress(scrollProgress) {
  for (let i = 0; i < stops.length - 1; i++) {
    if (scrollProgress <= stops[i + 1]) return (i + clamp((scrollProgress - stops[i]) / Math.max(.00001, stops[i + 1] - stops[i]), 0, 1)) / 4;
  }
  return 1;
}
refreshStops();
ScrollTrigger.create({
  start: 0, end: () => ScrollTrigger.maxScroll(window), invalidateOnRefresh: true,
  onRefresh: () => refreshStops(),
  onUpdate: self => updateUI(mapProgress(self.progress)),
  snap: {
    snapTo: value => navigating || reducedMotion ? value : gsap.utils.snap(stops, value),
    duration: { min: .55, max: 1.15 }, delay: .2, ease: 'power3.inOut', inertia: false,
  },
});
document.querySelectorAll('a[href^="#"]').forEach(link => {
  const index = chapters.findIndex(chapter => `#${chapter.id}` === link.getAttribute('href'));
  if (index >= 0) link.addEventListener('click', event => { event.preventDefault(); sectionScroll(index); });
});
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.target.closest('input, textarea, button, video, [contenteditable]')) return;
  const position = Math.round(progress * 4);
  if (['ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); sectionScroll(position + 1); }
  if (['ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); sectionScroll(position - 1); }
  if (event.key === 'Home') { event.preventDefault(); sectionScroll(0); }
  if (event.key === 'End') { event.preventDefault(); sectionScroll(4); }
});
document.querySelector('#network-toggle')?.addEventListener('click', event => {
  networkDown = !networkDown; document.body.dataset.network = networkDown ? 'offline' : 'online';
  event.currentTarget.setAttribute('aria-pressed', String(networkDown));
  const label = event.currentTarget.querySelector('[data-network-label]');
  (label || event.currentTarget).textContent = networkDown ? 'Restore cell signal' : 'Cut the cell signal';
  const status = document.querySelector('#connection-status'); if (status) status.textContent = networkDown ? 'CELL OFF · MESH ACTIVE' : 'LOCAL MESH · READY';
  const caption = document.querySelector('#scene-caption'); if (caption) caption.textContent = networkDown ? 'Illustration: cell signal is off. Local relays keep going.' : chapterCaptions[currentChapter];
});
document.querySelector('#motion-toggle')?.addEventListener('click', event => {
  reducedMotion = !reducedMotion; event.currentTarget.setAttribute('aria-pressed', String(reducedMotion));
  event.currentTarget.textContent = reducedMotion ? 'Full motion' : 'Reduce motion';
  document.body.classList.toggle('motion-reduced', reducedMotion);
});

let localVideoURL;
const video = document.querySelector('#demo-video'), fileInput = document.querySelector('#video-file');
const videoPlaceholder = document.querySelector('#demo-placeholder');
function showDemoVideo(source) {
  video.src = source; video.hidden = false; video.controls = true;
  videoPlaceholder.hidden = true;
  const replace = document.querySelector('#replace-video'); if (replace) replace.hidden = false;
  video.load();
}
video?.addEventListener('error', () => {
  video.hidden = true; videoPlaceholder.hidden = false;
  const message = videoPlaceholder.querySelector('div > span');
  if (message) message.textContent = 'The recording could not be opened. Choose a local MP4 or WebM.';
});
document.querySelector('#choose-video')?.addEventListener('click', () => fileInput.click());
fileInput?.addEventListener('change', () => {
  const file = fileInput.files[0]; if (!file) return;
  if (localVideoURL) URL.revokeObjectURL(localVideoURL);
  localVideoURL = URL.createObjectURL(file); showDemoVideo(localVideoURL);
});
document.querySelector('#replace-video')?.addEventListener('click', () => fileInput.click());
window.addEventListener('beforeunload', () => { if (localVideoURL) URL.revokeObjectURL(localVideoURL); });
if (video?.getAttribute('src')) showDemoVideo(video.getAttribute('src'));

let fallbackVan;
function updateFallback() {
  if (!fallbackVan) return;
  const angle = svgAt(progress).angle;
  fallbackVan.style.left = `${routePoint.x / 10}%`;
  fallbackVan.style.top = `${lerp(34, 59, progress < .98 ? 1 : 0)}vh`;
  fallbackVan.style.transform = `translate(-50%,-50%) rotate(${angle - 90}deg)`;
}
try { initScene(); }
catch (error) {
  console.warn('3D rendering unavailable; using the SVG route.', error);
  document.body.classList.add('no-webgl');
  fallbackVan = document.createElement('div'); fallbackVan.className = 'fallback-van';
  fallbackVan.innerHTML = '<span>R</span>'; fallbackVan.setAttribute('aria-hidden', 'true'); document.body.append(fallbackVan);
  finishLoading(); updateFallback();
}
window.addEventListener('resize', () => {
  if (renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65)); renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  }
  ScrollTrigger.refresh();
});
updateUI(mapProgress(ScrollTrigger.maxScroll(window) ? scrollY / ScrollTrigger.maxScroll(window) : 0));
document.body.classList.toggle('motion-reduced', reducedMotion);
window.runnersExperience = Object.freeze({
  goToChapter: sectionScroll,
  getState: () => ({ progress, chapter: currentChapter + 1, parked: progress > .998, networkDown, reducedMotion, webgl: !!renderer }),
});
