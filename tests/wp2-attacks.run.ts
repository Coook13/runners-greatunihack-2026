// Scratch runner: fire every attack-console event once after warmup and print the alerts WP2 agents raise.
import { meshFactories } from '../src/agents/index';
import { createEngineWith } from '../src/sim/engine';
import type { WorldEvent } from '../src/contracts/types';
const engine = await createEngineWith({ seed: 7, mode: 'mesh', factories: meshFactories, warmupSec: 0, autoDemand: true });
const evs: WorldEvent['type'][] = ['skim', 'fakeCarrier', 'fakeClinic', 'replay', 'tamper', 'flood', 'packShort', 'collude', 'steal', 'breakdown'];
const at = (i: number) => 7200 + i * 600;
evs.forEach((type, i) => engine.apply({ type, t: at(i), kg: type === 'skim' ? 1.2 : undefined }));
const end = at(evs.length) + 3600;
const seen = new Map<string, number>();
let s;
for (;;) {
  s = await engine.step();
  for (const l of s.newLogs) if (l.id === 'attack-console' || l.id === 'world') console.log(`${s.t}s ${l.id}: ${l.text}`);
  for (const a of s.newAlerts) {
    const k = `${a.kind}`; seen.set(k, (seen.get(k) ?? 0) + 1);
    if ((seen.get(k) ?? 0) <= 3) console.log(`   ALERT ${a.kind} by ${a.reportedBy}: ${a.text}`);
  }
  if (s.t >= end) break;
}
console.log(JSON.stringify(Object.fromEntries(seen)));
console.log(JSON.stringify(s.metrics));
