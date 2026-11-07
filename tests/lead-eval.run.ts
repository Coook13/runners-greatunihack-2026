// Lead scratch evaluator: npx tsx tests/lead-eval.run.ts <minutes> <seeds> [downAtSec]
// Prints final reach / intact / boxes / meanSec per seed for mesh and central.
import { meshFactories } from '../src/agents/index';
import { centralFactories } from '../src/baseline/index';
import { TICK_DT } from '../src/contracts/config';
import type { Mode } from '../src/contracts/types';
import { createEngineWith } from '../src/sim/engine';
const minutes = Number(process.argv[2] ?? 180);
const seeds = Number(process.argv[3] ?? 3);
const down = process.argv[4] ? Number(process.argv[4]) : null;
const modes = (process.argv[5] ?? 'mesh,central').split(',') as Mode[];
for (const mode of modes) {
  const rows: number[][] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const e = await createEngineWith({ seed: seed === 1 ? 7 : seed, mode, factories: mode === 'mesh' ? meshFactories : centralFactories, warmupSec: 0 });
    if (down !== null) e.apply({ type: 'networkDown', t: down });
    let s;
    let atDown = 0;
    for (let i = 0; i < Math.round((minutes * 60) / TICK_DT); i++) { s = await e.step(); if (down !== null && s.t === down) atDown = s.metrics.deliveredIntact; }
    const m = s!.metrics;
    rows.push([m.reachPct, m.deliveredIntact, m.boxesTotal, m.requestsOpen, m.meanDeliverySec, m.deliveredIntact - atDown, m.duplicates]);
  }
  const avg = (k: number) => (rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(1);
  console.log(`${mode.padEnd(8)} reach% ${rows.map((r) => r[0].toFixed(0)).join(' ')}  avg ${avg(0)} | intact avg ${avg(1)} boxes ${avg(2)} open ${avg(3)} meanSec ${avg(4)}${down !== null ? ` | intact after down ${avg(5)}` : ''} dups ${avg(6)}`);
}
