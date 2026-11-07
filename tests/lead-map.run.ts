import { createWorld, hasCoverage, dist } from '../src/sim/map';
const w = createWorld();
const r = (p: { x: number; y: number }) => `(${Math.round(p.x)},${Math.round(p.y)})`;
for (const s of w.stores) console.log(s.id, r(s.pos), hasCoverage(s.pos));
for (const h of w.hubs) console.log(h.id, r(h.pos), hasCoverage(h.pos), 'nearest store', Math.round(Math.min(...w.stores.map((s) => dist(s.pos, h.pos)))));
for (const v of w.villages) console.log(v.clinicId, v.name, r(v.pos), 'cov', hasCoverage(v.pos), 'riverside', v.riverside, 'nearestHub', Math.round(Math.min(...w.hubs.map((h) => dist(h.pos, v.pos)))), 'roadEta van min', Math.round(w.map.eta('van', w.stores[0].pos, v.pos) / 60), 'moto', Math.round(w.map.eta('motorbike', w.hubs[1].pos, v.pos) / 60));
console.log((w as any).coverage);
