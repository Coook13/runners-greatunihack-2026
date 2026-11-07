// Scratch debug runner for WP2 (not a test file): npx tsx tests/wp2-debug.run.ts [minutes] [filter]
import { centralFactories } from '../src/baseline/index';
import { TICK_DT } from '../src/contracts/config';
import { createEngineWith } from '../src/sim/engine';

const minutes = Number(process.argv[2] ?? '30');
const filter = process.argv[3] ?? '';
const engine = await createEngineWith({ seed: 7, mode: "central", factories: centralFactories, warmupSec: 0, autoDemand: true });
const ticks = Math.round((minutes * 60) / TICK_DT);
let last;
for (let i = 0; i < ticks; i++) {
  last = await engine.step();
  for (const l of last.newLogs) if (!filter || l.id.includes(filter) || l.text.includes(filter)) console.log(`${Math.round(last.t)}s ${l.id}: ${l.text}`);
  for (const a of last.newAlerts) console.log(`  ALERT ${a.kind} by ${a.reportedBy}: ${a.text}`);
}
console.log(JSON.stringify(last!.metrics));
for (const n of last!.nodes) if (n.boxes.length || n.kind === "van") console.log(n.id, n.kind, Math.round(n.pos.x), Math.round(n.pos.y), n.boxes.join(','));
