// Demand (new admissions at clinics) and the scripted demo events. All seeded.
import { CATALOGUE, DEMAND, SIZE_FOR_KG } from '../contracts/config';
import type { NodeId, SizeClass, Urgency, WorldEvent } from '../contracts/types';
import { HUBS } from './map';
import { randInt, type Rng } from './rng';

/**
 * What the engine puts in a clinic's inbox when a 'demand' event fires:
 *   Msg { from: 'scenario', to: clinicId, kind: 'order', body: DemandBody, hops: 0 }
 * Same shape as WP2's DemandOrder ({ type: 'demand', urgency, children }) plus the full detail.
 * Counts only, never names.
 */
export interface DemandBody {
  type: 'demand';
  clinicId: NodeId;
  children: number;                         // children 6-59 months to treat
  newAdmissions: number;
  urgency: Urgency;
  items: { code: string; qty: number }[];
  declaredKg: number;
  size: SizeClass;
  cold: boolean;
  beneficiaryNote: string;                  // e.g. "12 children 6-59 months, 3 new"
}

/** Build one clinic's demand from the scenario rng. */
export function makeDemand(rng: Rng, clinicId: NodeId): DemandBody {
  const children = randInt(rng, 4, 15);
  const newAdmissions = randInt(rng, 1, Math.min(5, children));
  const u = rng();
  const urgency: Urgency = u < 0.2 ? 3 : u < 0.6 ? 2 : 1;
  const items: { code: string; qty: number }[] = [{ code: 'RUTF-30', qty: children <= 8 ? 1 : 2 }];
  if (rng() < 0.5) items.push({ code: 'ORS-ZN', qty: 1 });
  if (rng() < 0.4) items.push({ code: 'AMOX', qty: 1 });
  if (rng() < 0.2) items.push({ code: 'MUAC', qty: 1 });
  if (rng() < 0.08) items.push({ code: 'VAX-MR', qty: 1 });
  const declaredKg = Math.round(items.reduce((s, it) => s + CATALOGUE[it.code].kg * it.qty, 0) * 100) / 100;
  return {
    type: 'demand',
    clinicId,
    children,
    newAdmissions,
    urgency,
    items,
    declaredKg,
    size: SIZE_FOR_KG(declaredKg),
    cold: items.some((it) => CATALOGUE[it.code].cold),
    beneficiaryNote: `${children} children 6-59 months, ${newAdmissions} new`,
  };
}

/** Requests per sim-hour across the district at time t (doubles at the surge). */
export const demandRate = (t: number): number =>
  DEMAND.ratePerHour * (t >= DEMAND.surgeAtSec ? DEMAND.surgeMultiplier : 1);

/** Seeded arrival process: each tick, a new admission lands at a random clinic with probability rate * dt. */
export class DemandGenerator {
  constructor(private readonly rng: Rng, private readonly clinics: NodeId[]) {}

  next(t: number, dt: number): WorldEvent[] {
    const p = (demandRate(t) * dt) / 3600;
    if (this.rng() >= p) return [];
    const target = this.clinics[Math.floor(this.rng() * this.clinics.length)];
    return [{ type: 'demand', target }];
  }
}

/** The stage demo, in order. The lead's demo runner fires the next one on a key press. */
export const DEMO_SCRIPT: { label: string; ev: WorldEvent }[] = [
  { label: 'Tower outage: NETWORK DOWN', ev: { type: 'networkDown' } },
  { label: 'Storm over the middle hub', ev: { type: 'deadZone', pos: { ...(HUBS.find((h) => h.id === 'hub-2') ?? HUBS[0]).pos }, radius: 3000 } },
  { label: 'Thief skims 1.2 kg from moto-04', ev: { type: 'skim', target: 'moto-04', kg: 1.2 } },
  { label: 'Drone-02 breaks down', ev: { type: 'breakdown', target: 'drone-02' } },
  { label: 'Hacker breaches moto-04', ev: { type: 'breach', target: 'moto-04' } },
  { label: 'Storm clears', ev: { type: 'clearZone' } },
  { label: 'NETWORK UP: ledgers merge', ev: { type: 'networkUp' } },
];

/** The same script on a clock, for headless runs: one event every `gapSec` from `startSec`. */
export const scriptedTimeline = (startSec: number, gapSec = 120): WorldEvent[] =>
  DEMO_SCRIPT.map((s, i) => ({ ...s.ev, t: startSec + i * gapSec }));
