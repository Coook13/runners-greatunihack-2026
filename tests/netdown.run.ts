// Scratch runner (not a test): network down after warmup, mesh vs central, same seed.
//   npx tsx tests/netdown.run.ts [seed] [minutesAfterDown] [warmupSec]
import { meshFactories } from '../src/agents/index';
import { centralFactories } from '../src/baseline/index';
import { TICK_DT, WARMUP_SEC } from '../src/contracts/config';
import { createEngine } from '../src/sim/engine';

const seed = Number(process.argv[2] ?? 7);
const after = Number(process.argv[3] ?? 90);
const warm = Number(process.argv[4] ?? WARMUP_SEC);
for (const mode of ['mesh', 'central'] as const) {
  const e = await createEngine({ seed, mode, factories: mode === 'mesh' ? meshFactories : centralFactories, warmupSec: warm });
  let s = await e.step();
  const at = s.metrics;
  e.apply({ type: 'networkDown' });
  for (let i = 0; i < (after * 60) / TICK_DT; i++) s = await e.step();
  const m = s.metrics;
  console.log(`${mode.padEnd(8)} at down t=${Math.round(at.t / 60)}min: intact ${at.deliveredIntact}, reach ${at.reachPct}%  |  ${after} min later: intact ${m.deliveredIntact} (+${m.deliveredIntact - at.deliveredIntact}), boxes ${m.boxesTotal} (+${m.boxesTotal - at.boxesTotal}), open ${m.requestsOpen}, reach ${m.reachPct}%`);
}
