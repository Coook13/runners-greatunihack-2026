import { createWorld } from '../src/sim/map';
import { fleetPlan } from '../src/sim/setup';
const w = createWorld();
const name = (p: { x: number; y: number }) => w.hubs.find((h) => Math.hypot(h.pos.x - p.x, h.pos.y - p.y) < 1)?.id ?? w.villages.find((v) => Math.hypot(v.pos.x - p.x, v.pos.y - p.y) < 1)?.clinicId ?? `(${Math.round(p.x)},${Math.round(p.y)})`;
const pl = fleetPlan(w);
pl.motos.forEach((m, i) => console.log('moto', i + 1, m.hub, m.loop.map(name).join(' > '), Math.round(m.loop.reduce((s, p, k) => s + w.map.eta('motorbike', p, m.loop[(k + 1) % m.loop.length]), 0) / 60), 'min'));
pl.boats.forEach((b, i) => console.log('boat', i + 1, b.hub, b.patrol.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' ')));
console.log('drones', pl.droneHubs.join(' '));
