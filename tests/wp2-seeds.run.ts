// Scratch runner (not a test): mesh vs central over several seeds, towers up for the whole run and towers down
// after a warmup.  npx tsx tests/wp2-seeds.run.ts [seeds=1,2,3,7] [upMinutes=240] [warmMin=60] [downMinutes=120]
import { meshFactories } from '../src/agents/index';
import { centralFactories } from '../src/baseline/index';
import { TICK_DT } from '../src/contracts/config';
import type { Metrics, Mode } from '../src/contracts/types';
import { createEngine } from '../src/sim/engine';

const seeds = (process.argv[2] ?? '1,2,3,7').split(',').map(Number);
const upMin = Number(process.argv[3] ?? 240);
const warmMin = Number(process.argv[4] ?? 60);
const downMin = Number(process.argv[5] ?? 120);
const f = (m: Mode) => (m === 'mesh' ? meshFactories : centralFactories);

async function up(seed: number, mode: Mode): Promise<{ m: Metrics; sec: number }> {
  const w = Date.now();
  const e = await createEngine({ seed, mode, factories: f(mode) });
  let s = await e.step();
  for (let i = 1; i < (upMin * 60) / TICK_DT; i++) s = await e.step();
  return { m: s.metrics, sec: (Date.now() - w) / 1000 };
}
async function down(seed: number, mode: Mode): Promise<{ at: Metrics; m: Metrics }> {
  const e = await createEngine({ seed, mode, factories: f(mode), warmupSec: warmMin * 60 });
  let s = await e.step();
  const at = s.metrics;
  e.apply({ type: 'networkDown' });
  for (let i = 0; i < (downMin * 60) / TICK_DT; i++) s = await e.step();
  return { at, m: s.metrics };
}

const rows: string[] = [];
for (const seed of seeds) {
  for (const mode of ['mesh', 'central'] as const) {
    const u = await up(seed, mode);
    const d = await down(seed, mode);
    rows.push(`seed ${seed} ${mode.padEnd(7)} | up ${upMin}m: reach ${String(u.m.reachPct).padStart(6)}%  mean ${String(Math.round(u.m.meanDeliverySec / 60)).padStart(3)} min  (${u.sec.toFixed(1)} s real) | down ${downMin}m after ${warmMin}m: +${d.m.deliveredIntact - d.at.deliveredIntact} delivered, reach ${d.m.reachPct}%, open ${d.m.requestsOpen}`);
    console.log(rows[rows.length - 1]);
  }
}
