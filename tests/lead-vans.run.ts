// Lead scratch: where are the vans and drones every 5 sim-minutes.
import { meshFactories } from '../src/agents/index';
import { TICK_DT } from '../src/contracts/config';
import { createEngineWith } from '../src/sim/engine';
import { createWorld, dist } from '../src/sim/map';
const w = createWorld();
const where = (p: { x: number; y: number }) => {
  const s = w.stores.find((x) => dist(x.pos, p) < 60); if (s) return s.id;
  const h = w.hubs.find((x) => dist(x.pos, p) < 400); if (h) return h.id;
  const v = w.villages.find((x) => dist(x.pos, p) < 1500); if (v) return v.clinicId;
  return `${Math.round(p.x / 100) / 10},${Math.round(p.y / 100) / 10}`;
};
const kinds = (process.argv[2] ?? 'van').split(',');
const e = await createEngineWith({ seed: 7, mode: 'mesh', factories: meshFactories, warmupSec: 0 });
for (let i = 1; i <= Math.round((Number(process.argv[3] ?? 120) * 60) / TICK_DT); i++) {
  const s = await e.step();
  if (i % 600 === 0) console.log(String(Math.round(s.t / 60)).padStart(4), s.nodes.filter((n) => kinds.includes(n.kind)).map((n) => `${n.id.replace(/^(\w)\w+-/, '$1')}:${where(n.pos)}[${n.boxes.length}]`).join(' '));
}
