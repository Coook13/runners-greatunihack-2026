// Sweep (PLAN WP7): how much reaches clinics as carriers break down, with the cell network cut at t = 300 s.
// For each mode and each breakdown fraction, run a few seeds headless and average the final reach %.
// Writes public/sweep.json as { kill, mesh, central } for the chart (WP6 charts.ts).
// Usage: npx tsx scripts/sweep.ts [--hours 2] [--seeds 3]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreateEngine, Factories, Mode, NodeId } from '../src/contracts/types';
import { meshFactories } from '../src/agents';
import { centralFactories } from '../src/baseline';
import { TICK_DT } from '../src/contracts/config';

const KILL = [0, 0.2, 0.4, 0.6];

const CARRIERS = new Set(['drone', 'motorbike', 'van', 'boat']);

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const HOURS = arg('hours', 2);
const SEEDS = Array.from({ length: arg('seeds', 3) }, (_, i) => i + 1);

// Seeded pick of which carriers break (mulberry32), so a sweep always replays the same way.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadEngine(): Promise<CreateEngine | null> {
  const path = '../src/sim/engine.ts';   // a variable, so this script still compiles before WP1 lands
  try {
    const mod = (await import(path)) as { createEngine?: CreateEngine };
    return mod.createEngine ?? null;
  } catch (e) {
    console.error(`sweep: could not load ${path}: ${(e as Error).message}`);
    return null;
  }
}

// Fair test: both systems first run normally for an hour, then the towers go down and carriers break.
// We score only the outage window: boxes delivered intact during it, over requests made during it.
const WARMUP = 3600;
const made = (m: { deliveredIntact: number; reachPct: number }) => (m.reachPct > 0 ? (m.deliveredIntact * 100) / m.reachPct : 0);

async function runOnce(createEngine: CreateEngine, mode: Mode, factories: Factories, seed: number, kill: number): Promise<number> {
  const engine = await createEngine({ seed, mode, factories, warmupSec: WARMUP });
  const first = await engine.step();
  const carriers: NodeId[] = first.nodes.filter((n) => CARRIERS.has(n.kind)).map((n) => n.id).sort();
  const rng = mulberry32(seed * 1000 + Math.round(kill * 100));
  const broken = carriers.map((id) => ({ id, r: rng() })).sort((a, b) => a.r - b.r)
    .slice(0, Math.round(kill * carriers.length));
  engine.apply({ type: 'networkDown' });
  for (const b of broken) engine.apply({ type: 'breakdown', target: b.id });

  const d0 = first.metrics.deliveredIntact, r0 = made(first.metrics);
  let m = first.metrics;
  const steps = Math.round((HOURS * 3600) / TICK_DT);
  for (let i = 1; i < steps; i++) m = (await engine.step()).metrics;
  const requests = made(m) - r0;
  return requests > 0 ? Math.min(100, ((m.deliveredIntact - d0) * 100) / requests) : 0;
}

async function main() {
  const createEngine = await loadEngine();
  if (!createEngine) {
    console.error('sweep: engine (src/sim/engine.ts, export createEngine) is not built yet. Nothing written.');
    process.exitCode = 1;
    return;
  }
  const started = Date.now();
  const out: { kill: number[]; mesh: number[]; central: number[] } = { kill: KILL.map((k) => k * 100), mesh: [], central: [] };
  for (const mode of ['mesh', 'central'] as const) {
    const factories = mode === 'mesh' ? meshFactories : centralFactories;
    for (const kill of KILL) {
      let sum = 0;
      for (const seed of SEEDS) sum += await runOnce(createEngine, mode, factories, seed, kill);
      const avg = Math.round((sum / SEEDS.length) * 10) / 10;
      out[mode].push(avg);
      console.log(`${mode.padEnd(7)} kill ${String(kill * 100).padStart(2)}%  reach ${avg.toFixed(1)}%  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
  }
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sweep.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`sweep: wrote ${file} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((e) => { console.error('sweep failed:', e); process.exitCode = 1; });
