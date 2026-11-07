// Lead scratch tracer: npx tsx tests/lead-trace.run.ts <mode> <minutes> <outfile> [netDownAtSec]
import { writeFileSync } from 'node:fs';
import { meshFactories } from '../src/agents/index';
import { centralFactories } from '../src/baseline/index';
import { TICK_DT } from '../src/contracts/config';
import type { Mode } from '../src/contracts/types';
import { createEngineWith } from '../src/sim/engine';
const mode = (process.argv[2] ?? 'mesh') as Mode;
const minutes = Number(process.argv[3] ?? '60');
const outFile = process.argv[4] ?? 'trace.log';
const down = process.argv[5] ? Number(process.argv[5]) : null;
const e = await createEngineWith({ seed: 7, mode, factories: mode === 'mesh' ? meshFactories : centralFactories, warmupSec: 0 });
if (down !== null) e.apply({ type: 'networkDown', t: down });
const lines: string[] = [];
let last;
for (let i = 0; i < Math.round((minutes * 60) / TICK_DT); i++) {
  last = await e.step();
  for (const l of last.newLogs) lines.push(`${Math.round(last.t)}s ${l.id}: ${l.text}`);
  for (const a of last.newAlerts) lines.push(`  ALERT ${a.kind} by ${a.reportedBy}: ${a.text}`);
}
lines.push(JSON.stringify(last!.metrics));
for (const n of last!.nodes) if (n.boxes.length || n.kind === 'van') lines.push(`${n.id} ${n.kind} ${Math.round(n.pos.x)} ${Math.round(n.pos.y)} ${n.boxes.join(',')}`);
writeFileSync(outFile, lines.join('\n'));
console.log(JSON.stringify(last!.metrics));
