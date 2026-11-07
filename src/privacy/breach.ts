// What a breach of one device leaks (PLAN 3.9). Feeds the Breach card in the UI.
import type { BreachDump } from '../contracts/types';

export interface Exposure { storeLocations: number; stockLevels: number; beneficiaryNotes: number; score: number }

/** Exposure score = exact store locations + known stock levels + readable beneficiary notes. */
export function exposure(dump: BreachDump): Exposure {
  const storeLocations = dump.knownLocations.filter((l) => l.what === 'store').length;
  const stockLevels = dump.knownStockLevels;
  const beneficiaryNotes = dump.readableBeneficiaryNotes.length;
  return { storeLocations, stockLevels, beneficiaryNotes, score: storeLocations + stockLevels + beneficiaryNotes };
}

export const exposureScore = (dump: BreachDump): number => exposure(dump).score;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Plain lines for the Breach card, worst leaks first. */
export function summarise(dump: BreachDump): string[] {
  const e = exposure(dump);
  const others = dump.knownLocations.filter((l) => l.what !== 'store').length;
  return [
    `Breached ${dump.nodeId}: exposure score ${e.score}`,
    `${plural(e.storeLocations, 'store location')} exposed`,
    `${plural(e.stockLevels, 'store stock level')} exposed`,
    `${plural(e.beneficiaryNotes, 'clinic beneficiary note')} readable`,
    `${plural(dump.readableLabels.length, 'box label')} readable (2 km cell, urgency, size only)`,
    `${plural(others, 'other place')} known (hubs, clinics, hand-off points)`,
    dump.nextHop ? `Next hop: ${dump.nextHop}` : 'Next hop: none',
  ];
}
