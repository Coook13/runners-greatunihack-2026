// Run the sim with no browser and print a metrics table every 5 sim-minutes.
//   npx tsx scripts/headless.ts --seed 7 --mode mesh --minutes 30 [--warmup 0] [--script]
// --script fires the stage demo events (network down, dead zone, skim, ...) on a clock.
// --no-auto-demand turns off the engine's seeded demand generator (it is the only source of demand by default).
import { meshFactories } from '../src/agents/index';
import { centralFactories } from '../src/baseline/index';
import type { Metrics, Mode } from '../src/contracts/types';
import { TICK_DT } from '../src/contracts/config';
import { createEngineWith } from '../src/sim/engine';
import { scriptedTimeline } from '../src/sim/scenario';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const seed = Number(arg('seed', '7'));
const mode = arg('mode', 'mesh') as Mode;
const minutes = Number(arg('minutes', '30'));
const warmup = Number(arg('warmup', '0'));
const script = process.argv.includes('--script');
const autoDemand = !process.argv.includes('--no-auto-demand');

const COLS: [keyof Metrics, string][] = [
  ['t', 'min'], ['requestsOpen', 'open'], ['boxesTotal', 'boxes'], ['deliveredIntact', 'intact'],
  ['deliveredShort', 'short'], ['skimmed', 'skim'], ['stolen', 'stolen'], ['lostBreakdown', 'lost'],
  ['inTransit', 'transit'], ['duplicates', 'dups'], ['leaksPinpointed', 'leaks'], ['attacksBlocked', 'blocked'],
  ['reachPct', 'reach%'], ['meanDeliverySec', 'meanSec'], ['carriersAlive', 'alive'],
];
const row = (cells: (string | number)[]) => cells.map((c) => String(c).padStart(8)).join('');

async function main() {
  if (mode !== 'mesh' && mode !== 'central') throw new Error(`--mode must be mesh or central, got ${mode}`);
  const started = Date.now();
  const engine = await createEngineWith({ seed, mode, factories: mode === 'mesh' ? meshFactories : centralFactories, warmupSec: warmup, autoDemand });
  if (script) for (const ev of scriptedTimeline((warmup || 0) + 300)) engine.apply(ev);

  console.log(`Runners headless  seed=${seed}  mode=${mode}  minutes=${minutes}  warmup=${warmup}s${script ? '  +demo script' : ''}`);
  console.log(row(COLS.map(([, h]) => h)));
  const ticks = Math.round((minutes * 60) / TICK_DT);
  const every = Math.round(300 / TICK_DT);
  let alerts = 0;
  for (let i = 1; i <= ticks; i++) {
    const s = await engine.step();
    alerts += s.newAlerts.length;
    for (const l of s.newLogs) if (l.id === 'world' || l.id === 'attack-console') console.log(`  [${Math.round(s.t)}s] ${l.id}: ${l.text}`);
    if (i % every === 0 || i === ticks) {
      const m = s.metrics;
      console.log(row(COLS.map(([k]) => (k === 't' ? (m.t / 60).toFixed(0) : m[k]))));
    }
  }
  console.log(`alerts raised: ${alerts}   real time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
