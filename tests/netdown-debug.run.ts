// Scratch: mesh, warmup, then network down; prints logs after the outage.  npx tsx tests/netdown-debug.run.ts [minutes]
import { meshFactories } from '../src/agents/index';
import { TICK_DT, WARMUP_SEC } from '../src/contracts/config';
import { createEngine } from '../src/sim/engine';
const minutes = Number(process.argv[2] ?? 60);
const e = await createEngine({ seed: 7, mode: 'mesh', factories: meshFactories, warmupSec: WARMUP_SEC });
e.apply({ type: 'networkDown' });
let s;
for (let i = 0; i < (minutes * 60) / TICK_DT; i++) {
  s = await e.step();
  for (const l of s.newLogs) if (!l.text.startsWith('Carrying request')) console.log(`${Math.round(s.t)}s ${l.id}: ${l.text}`);
}
console.log(JSON.stringify(s!.metrics));
for (const n of s!.nodes) if (n.boxes.length) console.log(n.id, Math.round(n.pos.x), Math.round(n.pos.y), n.boxes.join(','));
