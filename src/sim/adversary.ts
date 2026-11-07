// Seeded loss scenarios that run beside the engine, so the demo shows realistic losses and how each design copes.
// Uses only what an outsider could see (the Snapshot) plus the engine's public API. Same seed, same intensity:
// the same kinds of incident at the same moments in the mesh run and the central run.
import type { EngineApi, NodeId, NodeState, Snapshot, ThreatEvent } from '../contracts/types';
import { exposure } from '../privacy/breach';
import { childRng, pick } from './rng';
import { cellOf } from './map';

export type Intensity = 'off' | 'low' | 'demo' | 'high';

// Mean seconds between incidents of each kind.
const EVERY: Record<Exclude<Intensity, 'off'>, { skim: number; steal: number; breach: number }> = {
  low: { skim: 2400, steal: 3600, breach: 1800 },
  demo: { skim: 600, steal: 1200, breach: 900 },
  high: { skim: 300, steal: 600, breach: 400 },
};

const byId = (a: NodeState, b: NodeState) => (a.id < b.id ? -1 : 1);
const isGround = (n: NodeState) => n.kind === 'van' || n.kind === 'motorbike';

export interface Adversary {
  step(s: Snapshot, engine: EngineApi): ThreatEvent[];
  insider(): NodeId | null;
}

export function createAdversary(opts: { seed: number; intensity: Intensity }): Adversary {
  const rng = childRng(opts.seed, 'loss-scenarios');
  const gap = (mean: number) => mean * (0.5 + rng());
  let next: { skim: number; steal: number; breach: number } | null = null;
  let insider: NodeId | null = null;
  const awaiting = new Map<string, NodeId>();          // packageId skimmed -> insider, until an alert names it

  return {
    insider: () => insider,
    step(s, engine) {
      if (opts.intensity === 'off') return [];
      const cfg = EVERY[opts.intensity];
      const out: ThreatEvent[] = [];
      if (!next) {
        next = { skim: s.t + gap(cfg.skim), steal: s.t + gap(cfg.steal), breach: s.t + gap(cfg.breach) };
        const people = s.nodes.filter((n) => isGround(n) && !n.fake).sort(byId).map((n) => n.id);
        insider = people.length ? pick(rng, people) : null;  // one dishonest rider or driver; drones are never insiders
      }

      // A skim counts as detected when a live alert names the box (the next hand-off weighed it).
      for (const a of s.newAlerts) {
        if (!a.packageId || !awaiting.has(a.packageId)) continue;
        const who = awaiting.get(a.packageId)!;
        awaiting.delete(a.packageId);
        out.push({ t: s.t, kind: 'skim', actor: `insider:${who}`, target: who, outcome: 'detected',
          text: `Loss on ${a.packageId} caught by ${a.reportedBy} at the next hand-off: ${a.suspect ?? who} named` });
      }

      const nodes = new Map(s.nodes.map((n) => [n.id, n]));

      // Insider skims a little from a sealed crate they are carrying.
      if (s.t >= next.skim) {
        next.skim = s.t + gap(cfg.skim);
        const n = insider ? nodes.get(insider) : undefined;
        if (n?.alive && n.boxes.length) {
          const kg = Math.round((0.3 + 1.2 * rng()) * 10) / 10;
          engine.apply({ type: 'skim', target: n.id, kg });
          awaiting.set(n.boxes[0], n.id);
          out.push({ t: s.t, kind: 'skim', actor: `insider:${n.id}`, target: n.id, pos: n.pos, outcome: 'succeeded',
            text: `Insider on ${n.id} took ${kg} kg from a sealed crate in ${cellOf(n.pos)}` });
        }
      }

      // Roadside theft: a loaded van or motorbike out of phone signal loses a crate.
      if (s.t >= next.steal) {
        next.steal = s.t + gap(cfg.steal);
        const cands = s.nodes.filter((n) => isGround(n) && n.alive && n.boxes.length > 0 && !n.cellSignal && !n.fake).sort(byId);
        if (cands.length) {
          const n = pick(rng, cands);
          engine.apply({ type: 'steal', target: n.id });
          out.push({ t: s.t, kind: 'intercept', actor: `roadside@${cellOf(n.pos)}`, target: n.id, pos: n.pos, outcome: 'succeeded',
            text: `Roadside theft: a crate taken from ${n.id} in ${cellOf(n.pos)}` });
        }
      }

      // A device is compromised. The outcome depends on what that device holds, which is the whole point.
      if (s.t >= next.breach) {
        next.breach = s.t + gap(cfg.breach);
        const cands = s.nodes.filter((n) => n.alive && !n.fake && n.kind !== 'store').sort(byId);
        if (cands.length) {
          const n = pick(rng, cands);
          engine.apply({ type: 'breach', target: n.id });
          const info = engine.inspect(n.id);
          const e = info ? exposure(info.dump) : null;
          const contained = !e || e.score === 0;
          out.push({ t: s.t, kind: 'breach', actor: 'device-compromise', target: n.id, pos: n.pos,
            outcome: contained ? 'contained' : 'succeeded',
            text: contained
              ? `Device ${n.id} compromised: 0 clinic notes, 0 store locations, contents sealed (contained)`
              : `Device ${n.id} compromised: ${e!.storeLocations} store locations, ${e!.beneficiaryNotes} clinic notes exposed` });
        }
      }
      return out;
    },
  };
}
