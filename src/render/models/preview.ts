// Dev page for the carrier models (/?dev=models). Each model runs a scripted loop through its phases
// on a simple ground with a pond. A fake sim ticks every 0.5 sim-seconds and the motion smoother turns
// those ticks into 60 fps motion, exactly like the real renderer should. Buttons: break/repair,
// highlight, sim speed, and a 40-carrier stress test with a live draw-call counter.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CarrierKind, NodeState } from '../../contracts/types';
import { applyModelEnvironment, createCarrierModel, createMotionSmoother, scaleForDistance, type CarrierModel, type MotionSmoother } from './index';

type Phase = NonNullable<NodeState['phase']>;
type Seg = { move?: [number, number][]; speed?: number; hold?: number; phase: Phase; carry?: number };
interface Actor { kind: CarrierKind | 'crate'; model: CarrierModel; sm: MotionSmoother; plan: Seg[]; total: number; offset: number; alive: boolean }

const POND = { x: 130, z: 100, r: 38 };
const height = (x: number, z: number): number => {
  const d = Math.hypot(x - POND.x, z - POND.z);
  const hill = 2.2 * Math.sin(x / 38) * Math.cos(z / 46) + 1.2 * Math.sin((x + z) / 23);
  return d < POND.r + 12 ? hill * Math.min(1, Math.max(0, (d - POND.r) / 12)) - (d < POND.r ? 0.6 : 0) : hill;
};

function loop(cx: number, cz: number, rx: number, rz: number, n = 24, start = 0): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) { const a = start + (i / n) * Math.PI * 2; out.push([cx + Math.cos(a) * rx, cz + Math.sin(a) * rz]); }
  return out;
}
const segLen = (p: [number, number][]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
const segDur = (s: Seg) => s.hold ?? segLen(s.move!) / s.speed!;

/** Where a scripted actor is at sim time t: world metres (x east, y north), phase, boxes. */
function planAt(a: Actor, tSim: number): { x: number; y: number; phase: Phase; carry: number; heading?: number } {
  let t = (tSim + a.offset) % a.total;
  let last: [number, number] = a.plan.find((s) => s.move)?.move![0] ?? [0, 0], carry = 0;
  for (const s of a.plan) {
    const d = segDur(s);
    if (s.carry !== undefined) carry = s.carry;
    if (s.move) {
      if (t <= d) {
        let rem = t * s.speed!;
        for (let i = 1; i < s.move.length; i++) {
          const p = s.move[i - 1], q = s.move[i], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (rem <= l) { const k = rem / l; return { x: p[0] + (q[0] - p[0]) * k, y: -(p[1] + (q[1] - p[1]) * k), phase: s.phase, carry }; }
          rem -= l;
        }
      }
      last = s.move[s.move.length - 1];
    } else if (t <= d) {
      // a hand-off hands the box over half way through the hold
      const c = s.phase === 'handoff' && s.carry !== undefined && t > d * 0.55 ? Math.max(0, carry - 1) : carry;
      return { x: last[0], y: -last[1], phase: s.phase, carry: c };
    }
    t -= d;
  }
  return { x: last[0], y: -last[1], phase: 'idle', carry };
}

export function mountModelsPreview(root: HTMLElement): () => void {
  root.innerHTML = '';
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  root.appendChild(canvas);
  const hud = document.createElement('div');
  Object.assign(hud.style, { position: 'absolute', left: '12px', top: '12px', font: '13px system-ui, sans-serif', color: '#1d2320', background: 'rgba(255,255,255,0.82)', padding: '8px 10px', borderRadius: '8px', maxWidth: '360px', zIndex: '2' });
  root.appendChild(hud);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  void applyModelEnvironment(renderer);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfdce6);
  scene.fog = new THREE.Fog(0xcfdce6, 400, 2600);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 8000);
  camera.position.set(-30, 32, 58);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 4, 0);
  controls.enableDamping = true;
  controls.maxDistance = 4000;
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x6b5a3a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
  sun.position.set(-80, 120, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 1, far: 500 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  // ground: dry savanna with a dirt road ring and a pond
  const gGeo = new THREE.PlaneGeometry(1400, 1400, 140, 140).rotateX(-Math.PI / 2);
  const gp = gGeo.attributes.position, gc = new Float32Array(gp.count * 3);
  const dry = new THREE.Color(0xa89a68), green = new THREE.Color(0x6f7d45), dirt = new THREE.Color(0xb08a62), c = new THREE.Color();
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i), z = gp.getZ(i);
    gp.setY(i, height(x, z));
    const road = Math.abs(Math.hypot(x / 80, z / 55) - 1) * 60 < 3;
    c.copy(dry).lerp(green, 0.5 + 0.5 * Math.sin(x / 17) * Math.cos(z / 23));
    if (road) c.copy(dirt);
    c.toArray(gc, i * 3);
  }
  gGeo.setAttribute('color', new THREE.BufferAttribute(gc, 3));
  gGeo.computeVertexNormals();
  const ground = new THREE.Mesh(gGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
  const water = new THREE.Mesh(new THREE.CircleGeometry(POND.r + 4, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3b6a73, roughness: 0.15, metalness: 0.1 }));
  water.position.set(POND.x, 0, POND.z);
  scene.add(water);
  const pad = new THREE.Mesh(new THREE.CircleGeometry(3, 32).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5a5a58, roughness: 0.8 }));
  pad.position.set(-40, height(-40, -20) + 0.03, -20);
  scene.add(pad);

  const layer = new THREE.Group();
  scene.add(layer);
  const actors: Actor[] = [];
  const add = (kind: Actor['kind'], plan: Seg[], offset = 0): Actor => {
    const model = createCarrierModel(kind, { seed: actors.length * 977, crateGlow: kind === 'crate' });
    layer.add(model.object);
    const a: Actor = { kind, model, sm: createMotionSmoother(), plan, total: plan.reduce((s, p) => s + segDur(p), 0), offset, alive: true };
    actors.push(a);
    return a;
  };
  const roadLoop = loop(0, 0, 80, 55, 40);
  const handoffPt: [number, number] = [roadLoop[10][0], roadLoop[10][1]];
  const padPt: [number, number] = [-40, -20];
  const droneOut: [number, number][] = [padPt, [-10, -60], [30, -40], [handoffPt[0], handoffPt[1] - 30], handoffPt];
  const droneBack: [number, number][] = [handoffPt, [60, 10], [10, 30], [-50, 10], padPt];
  add('drone', [
    { hold: 4, phase: 'charging', carry: 1 }, { hold: 7, phase: 'takeoff' },
    { move: droneOut, speed: 20, phase: 'cruise' }, { hold: 12, phase: 'handoff', carry: 1 }, { hold: 0.5, phase: 'cruise', carry: 0 },
    { move: droneBack, speed: 20, phase: 'cruise' }, { hold: 8, phase: 'landing' }, { hold: 3, phase: 'idle', carry: 1 },
  ]);
  add('motorbike', [{ move: roadLoop.slice(0, 11), speed: 12, phase: 'relay', carry: 1 }, { hold: 9, phase: 'handoff' }, { move: roadLoop.slice(10), speed: 12, phase: 'relay', carry: 2 }], 0);
  add('van', [{ move: roadLoop, speed: 9, phase: 'relay', carry: 9 }, { hold: 5, phase: 'handoff' }], 18);
  add('boat', [{ move: loop(POND.x, POND.z, 30, 22, 30), speed: 5, phase: 'relay', carry: 4 }, { hold: 6, phase: 'handoff' }]);
  add('crate', [{ hold: 10, phase: 'idle', carry: 1 }]).model.object.position.set(handoffPt[0] + 3, 0, handoffPt[1]);
  const crateActor = actors[actors.length - 1];
  const scripted = actors.length;

  // ---------- controls ----------
  let simRate = 1, simT = 0, nextTick = 0, highlight = false;
  const bar = document.createElement('div');
  Object.assign(bar.style, { position: 'absolute', left: '12px', bottom: '12px', display: 'flex', gap: '6px', flexWrap: 'wrap', zIndex: '2' });
  root.appendChild(bar);
  const btn = (label: string, fn: (b: HTMLButtonElement) => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, { font: '13px system-ui', padding: '6px 10px', borderRadius: '6px', border: '1px solid #8a948f', background: '#fff', cursor: 'pointer' });
    b.onclick = () => fn(b);
    bar.appendChild(b);
  };
  btn('Break / repair', () => { for (const a of actors.slice(0, scripted)) a.alive = !a.alive; });
  btn('Highlight', () => { highlight = !highlight; actors.forEach((a) => a.model.setHighlight(highlight)); });
  for (const r of [1, 10, 60]) btn(`Sim ${r}x`, () => { simRate = r; });
  btn('40 carriers', (b) => {
    if (actors.length > scripted) {
      for (const a of actors.splice(scripted)) a.model.dispose();
      b.textContent = '40 carriers';
      return;
    }
    const kinds: CarrierKind[] = ['drone', 'motorbike', 'van', 'boat'];
    for (let i = 0; i < 36; i++) {
      const k = kinds[i % 4];
      const plan: Seg[] = k === 'boat' ? [{ move: loop(POND.x, POND.z, 20 + (i % 3) * 7, 15 + (i % 3) * 5, 30, i), speed: 5, phase: 'relay', carry: 3 }]
        : k === 'drone' ? [{ move: loop(0, 0, 120 + i * 4, 90 + i * 3, 30, i), speed: 22, phase: 'cruise', carry: 1 }]
          : [{ move: roadLoop, speed: k === 'van' ? 9 : 12, phase: 'relay', carry: 2 + (i % 5) }];
      add(k, plan, i * 5.3);
    }
    b.textContent = 'Remove extra';
  });

  // ---------- loop ----------
  const pos3 = new THREE.Vector3(), nrm = new THREE.Vector3();
  const normalAt = (x: number, z: number, out: THREE.Vector3) => {
    const e = 0.8;
    return out.set(height(x - e, z) - height(x + e, z), 2 * e, height(x, z - e) - height(x, z + e)).normalize();
  };
  let last = performance.now(), raf = 0, fpsAcc = 0, fpsN = 0, fps = 0;
  let virt = 0;                                        // debug: advance() fast-forwards a hidden page
  const frame = () => {
    raf = requestAnimationFrame(frame);
    tick(performance.now() + virt);
  };
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const wall = now / 1000;
    simT += dt * simRate;
    while (nextTick <= simT) {                         // the fake sim: one tick every 0.5 sim seconds
      for (const a of actors) {
        if (a === crateActor) continue;
        const p = planAt(a, nextTick);
        a.sm.push(nextTick, wall, p.x, p.y);
        (a as Actor & { cur?: ReturnType<typeof planAt> }).cur = p;
      }
      nextTick += 0.5;
    }
    const camDist = camera.position.distanceTo(controls.target);
    for (const a of actors) {
      if (a === crateActor) {
        const o = a.model.object.position;
        a.model.update({ pos3: pos3.set(o.x, height(o.x, o.z), o.z), heading: 0.4, speed: 0, carrying: 1, alive: true, groundNormal: normalAt(o.x, o.z, nrm), scale: scaleForDistance(camDist, 'crate', { viewportPx: canvas.clientHeight }) }, dt);
        continue;
      }
      const m = a.sm.sample(wall);
      const cur = (a as Actor & { cur?: ReturnType<typeof planAt> }).cur;
      const x = m.x, z = -m.y;
      const onWater = a.kind === 'boat';
      pos3.set(x, onWater ? 0.02 : height(x, z), z);
      a.model.update({
        pos3, heading: m.heading, speed: a.alive ? m.speed : 0, turnRate: m.turnRate, accel: m.accel,
        phase: cur?.phase, carrying: cur?.carry ?? 0, alive: a.alive,
        groundNormal: onWater ? undefined : normalAt(x, z, nrm),
        scale: scaleForDistance(camDist, a.kind, { viewportPx: canvas.clientHeight }),
      }, dt);
    }
    controls.update();
    renderer.render(scene, camera);
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    const d = actors[0], dc = (d as Actor & { cur?: ReturnType<typeof planAt> }).cur;
    hud.innerHTML = `<b>Carrier models</b> &middot; ${fps.toFixed(0)} fps &middot; ${renderer.info.render.calls} draw calls &middot; ${actors.length - 1} carriers<br>`
      + `sim ${simRate}x &middot; camera ${camDist.toFixed(0)} m &middot; drone phase: ${dc?.phase ?? '-'}, boxes ${dc?.carry ?? 0}<br>`
      + `<span style="color:#56605b">Zoom out: models keep a minimum on-screen size (scaleForDistance).</span>`;
  };
  // handle for debugging from the console: __models.focus(0) glides the camera to the drone
  (window as unknown as Record<string, unknown>).__models = {
    camera, controls, actors, renderer,
    advance(sec: number) { for (let i = 0; i < sec * 60; i++) { virt += 1000 / 60; tick(performance.now() + virt); } },
    focus(i: number, dist = 14) {
      const o = actors[i].model.anchor(new THREE.Vector3());
      controls.target.copy(o);
      camera.position.copy(o).add(new THREE.Vector3(-dist * 0.7, dist * 0.45, dist * 0.7));
    },
  };
  const resize = () => {
    const w = root.clientWidth || window.innerWidth, h = root.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  resize();
  frame();
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    for (const a of actors) a.model.dispose();
    renderer.dispose();
    root.innerHTML = '';
  };
}
