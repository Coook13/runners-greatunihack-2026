// Scratch tracer (not a test): where does each box spend its time?
//   npx tsx tests/wp2-trace.run.ts [mode] [minutes] [netDownAtSec] [seed]
// Prints one line per request (made -> packed -> each custody hop -> delivered) and the mean of each stage.
import { meshFactories } from '../src/agents/index';
import { centralFactories } from '../src/baseline/index';
import { TICK_DT } from '../src/contracts/config';
import type { Mode } from '../src/contracts/types';
import { createEngineWith } from '../src/sim/engine';

const mode = (process.argv[2] ?? 'mesh') as Mode;
const minutes = Number(process.argv[3] ?? '240');
const down = process.argv[4] && process.argv[4] !== '-' ? Number(process.argv[4]) : null;
const seed = Number(process.argv[5] ?? '7');
const started = Date.now();
const e = await createEngineWith({ seed, mode, factories: mode === 'mesh' ? meshFactories : centralFactories, warmupSec: 0 });
if (down !== null) e.apply({ type: 'networkDown', t: down });

interface Trace { req: string; clinic: string; made?: number; packed?: number; store?: string; pkg?: string; hops: { t: number; by: string }[]; done?: number }
const reqs = new Map<string, Trace>();
const byPkg = new Map<string, Trace>();
let last;
for (let i = 0; i < Math.round((minutes * 60) / TICK_DT); i++) {
  last = await e.step();
  for (const l of last.newLogs) {
    let m = /^New request (r-\S+?):/.exec(l.text);
    if (m) { reqs.set(m[1], { req: m[1], clinic: l.id, made: l.t, hops: [] }); continue; }
    m = /^Packed box (p-\w+) for (r-\S+) /.exec(l.text);
    if (m) {
      const tr = reqs.get(m[2]);
      if (tr && tr.pkg === undefined) { tr.pkg = m[1]; tr.packed = l.t; tr.store = l.id; byPkg.set(m[1], tr); }
      continue;
    }
    m = /^Got box (p-\w+) from/.exec(l.text);
    if (m) { const tr = byPkg.get(m[1]); if (tr) tr.hops.push({ t: l.t, by: l.id }); continue; }
    m = /^Delivered: box (p-\w+)/.exec(l.text);
    if (m) { const tr = byPkg.get(m[1]); if (tr && tr.done === undefined) tr.done = l.t; }
  }
}
const mm = (s: number) => (s / 60).toFixed(1).padStart(5);
const stage: Record<string, number[]> = { pack: [], toVan: [], vanHold: [], restHops: [], total: [] };
for (const tr of reqs.values()) {
  const hops = tr.hops.map((h, i) => `${h.by}@${mm(h.t - (i ? tr.hops[i - 1].t : tr.packed!))}`).join(' > ');
  console.log(`${tr.req.padEnd(10)} ${tr.clinic.padEnd(9)} made ${mm(tr.made!)}  pack +${tr.packed !== undefined ? mm(tr.packed - tr.made!) : '  -  '} ${tr.store ?? ''}  ${hops}  ${tr.done !== undefined ? `DONE total ${mm(tr.done - tr.made!)} (last leg ${mm(tr.done - (tr.hops.at(-1)?.t ?? tr.packed!))})` : 'open'}`);
  if (tr.done === undefined || tr.packed === undefined) continue;
  stage.pack.push(tr.packed - tr.made!);
  if (tr.hops[0]) stage.toVan.push(tr.hops[0].t - tr.packed);
  if (tr.hops[1]) stage.vanHold.push(tr.hops[1].t - tr.hops[0].t);
  stage.restHops.push(tr.done - (tr.hops[1]?.t ?? tr.hops[0]?.t ?? tr.packed));
  stage.total.push(tr.done - tr.made!);
}
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
console.log(Object.entries(stage).map(([k, v]) => `${k} ${mm(avg(v))} min (n=${v.length})`).join(' | '));
console.log(JSON.stringify(last!.metrics));
console.log(`real time ${((Date.now() - started) / 1000).toFixed(1)} s`);
