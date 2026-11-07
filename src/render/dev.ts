// Dev page for the renderer, opened at /?dev=render (add &split=1 for two renderers side by side,
// &map=fictional for the old made-up district). A fake snapshot generator drives it on the REAL
// Hawassa map: vans and motorbikes ride real roads (world-hawassa routes), boats cross Lake Hawassa,
// drones fly straight. Nothing here is used by the real app.
import { CAPACITY, COUNTS, RADIO_RANGE, SPEED } from '../contracts/config';
import type { CarrierKind, Hub, Metrics, NodeId, NodeKind, NodeState, Snapshot, Tool, Vec2 } from '../contracts/types';
import { createWorld } from '../sim/world-hawassa';
import { createCameraLink, createRenderer, type BaseLayer, type Renderer } from './index';

const SIM_PER_UPDATE = 5;                               // sim seconds per fake snapshot
const UPDATE_MS = 250;                                  // 4 snapshots a second; the renderer blends between them

interface FakeNode {
  id: NodeId; kind: NodeKind; pos: Vec2; alive: boolean; fake?: boolean;
  route?: Vec2[]; idx?: number; boxes: number; follow?: NodeId;
}

function buildWorld(): { nodes: FakeNode[]; hubs: Hub[] } {
  const w = createWorld();
  const nodes: FakeNode[] = [];
  const hubs = w.hubs;
  const H = (id: string) => hubs.find((h) => h.id === id)!.pos;
  const loop = (kind: CarrierKind, stops: Vec2[]) => {
    const pts: Vec2[] = [];
    stops.forEach((s, i) => pts.push(...w.map.route(kind, s, stops[(i + 1) % stops.length]).slice(0, -1)));
    return pts;
  };
  w.stores.forEach((s) => nodes.push({ id: s.id, kind: 'store', pos: { ...s.pos }, alive: true, boxes: 6 }));
  w.villages.forEach((v) => nodes.push({ id: v.clinicId, kind: 'clinic', pos: { ...v.pos }, alive: true, boxes: 0 }));
  const vanPlan: [string, string][] = [['store-A', 'hub-2'], ['store-B', 'hub-1'], ['store-C', 'hub-3'], ['store-A', 'hub-3']];
  vanPlan.slice(0, COUNTS.vans).forEach(([s, h], i) => {
    const sp = w.stores.find((x) => x.id === s)!.pos;
    nodes.push({ id: `van-0${i + 1}`, kind: 'van', pos: { ...sp }, alive: true, route: loop('van', [sp, H(h)]), idx: 0, boxes: 0 });
  });
  const V = (k: number) => w.villages[k].pos;
  const motoPlan: [string, number, number][] = [
    ['hub-3', 0, 2], ['hub-3', 1, 3], ['hub-2', 4, 5], ['hub-2', 6, 1], ['hub-1', 7, 8], ['hub-1', 9, 8], ['hub-2', 8, 4], ['hub-3', 3, 0],
  ];
  motoPlan.slice(0, COUNTS.motorbikes).forEach(([h, a, b], i) => {
    const r = loop('motorbike', [H(h), V(a), V(b)]);
    nodes.push({ id: `moto-0${i + 1}`, kind: 'motorbike', pos: r[0], alive: true, route: r, idx: (i * 37) % r.length, boxes: 0 });
  });
  const droneHubs = ['hub-1', 'hub-2', 'hub-3', 'hub-1', 'hub-2', 'hub-3', 'hub-3', 'hub-2'];
  droneHubs.slice(0, COUNTS.drones).forEach((h, i) => {
    const c = V((i * 7 + 2) % 10);
    nodes.push({ id: `drone-0${i + 1}`, kind: 'drone', pos: H(h), alive: true, route: [H(h), c], idx: i % 2, boxes: 0 });
  });
  // boats: Hawassa lakeshore hub <-> west-shore landings (Dore, Dembara) and the north-east shore
  const landing = (p: Vec2) => w.water.snap(p).q;
  const boatPlans = [[H('hub-2'), landing(V(4)), landing(V(0))], [H('hub-2'), landing(V(5)), landing(V(8))]];
  boatPlans.slice(0, COUNTS.boats).forEach((stops, i) => {
    const r = loop('boat', stops.map(landing));
    nodes.push({ id: `boat-0${i + 1}`, kind: 'boat', pos: r[0], alive: true, route: r, idx: i * Math.floor(r.length / 2), boxes: 0 });
  });
  return { nodes, hubs };
}

function step(n: FakeNode, dt: number, frozen: boolean): void {
  if (!n.alive || !n.route || n.idx === undefined || frozen) return;
  let budget = SPEED[n.kind as CarrierKind] * dt * 3;    // 3x so the dev page shows motion quickly
  while (budget > 0 && n.route.length > 1) {
    const goal = n.route[(n.idx + 1) % n.route.length];
    const d = Math.hypot(goal.x - n.pos.x, goal.y - n.pos.y);
    if (d <= budget) {
      n.pos = { ...goal };
      budget -= d;
      n.idx = (n.idx + 1) % n.route.length;
      if (n.idx === 0) n.boxes = Math.min(CAPACITY[n.kind as CarrierKind], n.kind === 'van' ? 5 : 2);
      else if (n.idx === Math.floor(n.route.length / 2)) n.boxes = 0;
    } else {
      n.pos = { x: n.pos.x + ((goal.x - n.pos.x) / d) * budget, y: n.pos.y + ((goal.y - n.pos.y) / d) * budget };
      budget = 0;
    }
  }
}

const emptyMetrics = (t: number, alive: number, total: number): Metrics => ({
  t, requestsOpen: 0, boxesTotal: 0, deliveredIntact: 0, deliveredShort: 0, skimmed: 0, stolen: 0, lostBreakdown: 0,
  inTransit: 0, duplicates: 0, leaksPinpointed: 0, attacksBlocked: 0, reachPct: 0, meanDeliverySec: 0,
  carriersAlive: alive, carriersTotal: total,
});

export function mountDev(root: HTMLElement): void {
  const q = new URLSearchParams(location.search);
  const split = q.get('split') === '1';
  const fictional = q.get('map') === 'fictional';
  const mainCanvas = root.querySelector<HTMLCanvasElement>('#scene')!;
  const ui = root.querySelector<HTMLElement>('#ui')!;
  const world = createWorld();
  const villages = world.villages.map((v) => ({ name: v.name, pos: v.pos }));
  const ropts = (lowPower: boolean) => ({
    map: fictional ? ('fictional' as const) : ('hawassa' as const), coverage: world.coverage, lowPower,
    world: { villages }, hubNames: { 'hub-1': 'Tula junction', 'hub-2': 'Hawassa lakeshore', 'hub-3': 'Shashemene road' },
  });

  // one or two canvases; each sits in its own positioned box so its label overlay lines up
  const renderers: Renderer[] = [];
  if (split) {
    mainCanvas.style.display = 'none';
    const link = createCameraLink();
    ['Runners (mesh)', 'Central dispatch'].forEach((title, i) => {
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;top:0;bottom:0;${i ? 'right:0' : 'left:0'};width:50%;overflow:hidden;${i ? 'border-left:2px solid #222' : ''}`;
      const c = document.createElement('canvas');
      c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
      const tag = document.createElement('div');
      tag.textContent = title;
      tag.style.cssText = 'position:absolute;top:12px;right:12px;z-index:2;font:700 13px system-ui;background:rgba(20,20,20,.75);color:#fff;padding:4px 10px;border-radius:8px;pointer-events:none';
      box.append(c, tag);
      root.insertBefore(box, ui);
      renderers.push(createRenderer(c, { ...ropts(true), cameraLink: link }));
    });
  } else {
    renderers.push(createRenderer(mainCanvas, ropts(false)));
  }
  const r = renderers[0];
  const { nodes, hubs } = buildWorld();
  const central = split ? buildWorld().nodes : null;   // right side: central dispatch freezes when the network drops
  const zones: { pos: Vec2; radius: number }[] = [{ pos: { x: 30000, y: 20000 }, radius: 3000 }];
  let t = 0, networkUp = true, autoNet = true;

  // ---------- control panel ----------
  ui.innerHTML = `
    <style>
      .rdev { position: absolute; top: 16px; left: 16px; width: 270px; background: rgba(255,250,240,.92); color: #2b2418;
        border-radius: 12px; padding: 14px 16px; box-shadow: 0 6px 24px rgba(60,40,10,.18); font: 13px/1.4 system-ui, sans-serif; }
      .rdev h1 { font-size: 15px; margin: 0 0 2px; } .rdev p { margin: 0 0 10px; color: #6b5d48; font-size: 12px; }
      .rdev .row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
      .rdev button { border: 1px solid #d8c8a8; background: #fff; border-radius: 7px; padding: 5px 9px; font: inherit; cursor: pointer; color: #2b2418; }
      .rdev button.on { background: #2f8f83; border-color: #2f8f83; color: #fff; }
      .rdev .log { font: 11px/1.45 ui-monospace, Consolas, monospace; color: #4a4033; max-height: 120px; overflow: hidden; border-top: 1px solid #eadfc8; padding-top: 6px; }
      .rdev .net { font-weight: 600; } .rdev .net.down { color: #b0382c; }
    </style>
    <div class="rdev">
      <h1>Runners: renderer dev</h1>
      <p>Hawassa, Ethiopia. Fake snapshots at 4 Hz on real roads, blended to 60 fps. Drag to orbit, right-drag to pan.</p>
      <div class="row" id="layers"></div>
      <div class="row" id="tools"></div>
      <div class="row">
        <button id="roads" class="on">Roads</button><button id="grid">Cell grid</button><button id="net">Network: auto</button>
        <button id="hl">Highlight</button><button id="focus">Focus selected</button>
      </div>
      <div class="row"><span class="net" id="netState">Cell network up</span></div>
      <div class="log" id="log"></div>
    </div>`;
  const $ = <T extends HTMLElement>(id: string) => ui.querySelector<T>(`#${id}`)!;
  const logLines: string[] = [];
  const log = (s: string) => { logLines.unshift(s); logLines.length = Math.min(logLines.length, 8); $('log').innerHTML = logLines.join('<br>'); };

  const layers: [BaseLayer, string][] = [['sat', 'Satellite'], ['street', 'Street map'], ['stylised', 'Stylised']];
  for (const [l, label] of layers) {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('on', l === r.getBaseLayer());
    b.onclick = () => { renderers.forEach((x) => x.setBaseLayer(l)); [...$('layers').children].forEach((c) => c.classList.toggle('on', c === b)); };
    $('layers').appendChild(b);
  }
  const tools: Tool[] = ['select', 'deadZone', 'breakdown'];
  for (const tl of tools) {
    const b = document.createElement('button');
    b.textContent = tl === 'deadZone' ? 'Dead zone (drag)' : tl[0].toUpperCase() + tl.slice(1);
    b.onclick = () => { renderers.forEach((x) => x.setTool(tl)); [...$('tools').children].forEach((c) => c.classList.toggle('on', c === b)); };
    if (tl === 'select') b.classList.add('on');
    $('tools').appendChild(b);
  }
  $('roads').onclick = () => { let on = true; renderers.forEach((x) => { on = x.toggleRoads(); }); $('roads').classList.toggle('on', on); };
  $('grid').onclick = () => { let on = true; renderers.forEach((x) => { on = x.toggleGrid(); }); $('grid').classList.toggle('on', on); };
  $('net').onclick = () => {
    autoNet = false;
    networkUp = !networkUp;
    $('net').textContent = networkUp ? 'Network: up' : 'Network: down';
  };
  let hlOn = false;
  $('hl').onclick = () => { hlOn = !hlOn; renderers.forEach((x) => x.highlight(hlOn ? ['moto-02', 'van-01'] : [])); $('hl').classList.toggle('on', hlOn); };
  let selected: NodeId | null = null;
  $('focus').onclick = () => selected && r.focus(selected);

  r.onSelect((id) => { selected = id; log(`select ${id ?? '(none)'}`); });
  r.onNodeClick((id, tl) => {
    log(`node ${id} [${tl}]`);
    const n = nodes.find((x) => x.id === id);
    if (n && tl === 'breakdown') n.alive = !n.alive;
  });
  r.onGroundClick((p, tl) => {
    log(`ground ${Math.round(p.x)}, ${Math.round(p.y)} [${tl}]`);
    if (tl === 'deadZone') zones.push({ pos: p, radius: 2000 });
  });
  r.onZoneDraw((p, radius) => { log(`zone ${Math.round(p.x)}, ${Math.round(p.y)} r=${Math.round(radius)} m`); zones.push({ pos: p, radius }); });

  // ---------- fake engine ----------
  const inZone = (p: Vec2) => zones.some((z) => Math.hypot(p.x - z.pos.x, p.y - z.pos.y) < z.radius);
  const snapshot = (list: FakeNode[], mode: 'mesh' | 'central'): Snapshot => {
    const states: NodeState[] = list.map((n) => ({
      id: n.id, kind: n.kind, pos: { ...n.pos }, alive: n.alive, battery: 1, cellSignal: networkUp, fake: n.fake,
      boxes: Array.from({ length: n.boxes }, (_, k) => `p-${n.id}-${k}`),
    }));
    const links: [NodeId, NodeId][] = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (!a.alive || !b.alive || inZone(a.pos) || inZone(b.pos)) continue;
      const range = Math.min(RADIO_RANGE[a.kind], RADIO_RANGE[b.kind]);
      if (range > 0 && Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) < range) links.push([a.id, b.id]);
    }
    const carriers = list.filter((n) => n.route);
    return {
      t, mode, nodes: states, links: mode === 'mesh' ? links : [], cellNetworkUp: networkUp,
      deadZones: zones.map((z) => ({ pos: { ...z.pos }, radius: z.radius })),
      hubs, metrics: emptyMetrics(t, carriers.filter((c) => c.alive).length, carriers.length), newAlerts: [], newLogs: [],
    };
  };

  setInterval(() => {
    t += SIM_PER_UPDATE;
    for (const n of nodes) step(n, SIM_PER_UPDATE, false);
    if (central) for (const n of central) step(n, SIM_PER_UPDATE, !networkUp);
    zones[0].pos.x = 30000 - 5000 * Math.sin(t / 900);
    if (t === 150) nodes.push({ id: 'intruder-1', kind: 'motorbike', pos: { ...nodes.find((n) => n.id === 'moto-03')!.pos }, alive: true, fake: true, boxes: 0, follow: 'moto-03' });
    if (t === 240) { const m = nodes.find((n) => n.id === 'moto-05'); if (m) m.alive = false; }
    for (const n of nodes) if (n.follow) {
      const f = nodes.find((x) => x.id === n.follow)!;
      n.pos = { x: n.pos.x + (f.pos.x + 220 - n.pos.x) * 0.3, y: n.pos.y + (f.pos.y + 160 - n.pos.y) * 0.3 };
    }
    if (autoNet && t % 120 === 0) networkUp = !networkUp;
    $('netState').textContent = networkUp ? 'Cell network up' : 'Cell network DOWN';
    $('netState').classList.toggle('down', !networkUp);
    r.update(snapshot(nodes, 'mesh'));
    if (central && renderers[1]) renderers[1].update(snapshot(central, 'central'));
  }, UPDATE_MS);
  r.update(snapshot(nodes, 'mesh'));
  if (central && renderers[1]) renderers[1].update(snapshot(central, 'central'));
}
