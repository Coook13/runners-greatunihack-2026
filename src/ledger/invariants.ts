// Classify every box into exactly one bucket (PLAN 3.6), so the buckets always add up to the box count.
import type { LeakFinding, LedgerReport, Receipt } from '../contracts/types';
import { isDelivered, type LedgerContext } from './leaks';

export type BoxClass = 'deliveredIntact' | 'deliveredShort' | 'skimmed' | 'stolen' | 'lostBreakdown' | 'inTransit';

export function classify(chain: Receipt[], findings: LeakFinding[], ctx: LedgerContext): BoxClass {
  const kinds = new Set(findings.map((f) => f.kind));
  if (isDelivered(chain)) {
    if (kinds.has('skim')) return 'skimmed';                                     // hop named
    if (kinds.has('short-at-clinic') || kinds.has('packed-short')) return 'deliveredShort';
    return 'deliveredIntact';
  }
  if (kinds.has('stolen') || kinds.has('coerced')) return 'stolen';
  if (ctx.dead.has(chain[chain.length - 1].to)) return 'lostBreakdown';
  if (kinds.has('skim')) return 'skimmed';                                       // still moving, but already lighter
  return 'inTransit';
}

/** A duplicate = a delivered box for a request that already had one delivered (PLAN 13 #10). */
export function countDuplicates(byBox: Map<string, Receipt[]>): number {
  const perRequest = new Map<string, number>();
  for (const chain of byBox.values()) {
    const d = chain.find((r) => r.kind === 'delivered');
    if (d) perRequest.set(d.requestId, (perRequest.get(d.requestId) ?? 0) + 1);
  }
  let dup = 0;
  for (const n of perRequest.values()) dup += Math.max(0, n - 1);
  return dup;
}

export function tally(byBox: Map<string, Receipt[]>, findings: LeakFinding[], ctx: LedgerContext, badSignatures: number): LedgerReport {
  const r: LedgerReport = {
    boxes: byBox.size, deliveredIntact: 0, deliveredShort: 0, skimmed: 0, stolen: 0, lostBreakdown: 0, inTransit: 0,
    duplicates: countDuplicates(byBox), badSignatures, findings,
  };
  for (const [pkg, chain] of byBox) r[classify(chain, findings.filter((f) => f.packageId === pkg), ctx)]++;
  return r;
}
