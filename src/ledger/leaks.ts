// The Leak Finder. Walks each box's receipt chain (its passport) and names the holder where weight or the box vanished.
import type { Alert, LeakFinding, NodeId, Receipt } from '../contracts/types';
import { WEIGHT_TOLERANCE_KG } from '../contracts/config';
import { receiptKey } from './receipts';

export interface LedgerContext {
  dead: Set<NodeId>;                 // carriers that broke down
  holding?: Map<string, NodeId>;     // packageId -> who physically holds it now (optional, from Snapshot.nodes)
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Group receipts per box, ordered by the box's logical counter (seq), never by clock. */
export function chains(receipts: Receipt[]): Map<string, Receipt[]> {
  const out = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const list = out.get(r.packageId) ?? [];
    list.push(r);
    out.set(r.packageId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.seq - b.seq || cmp(receiptKey(a), receiptKey(b)));
  return out;
}

export const isDelivered = (chain: Receipt[]): boolean => chain.some((r) => r.kind === 'delivered');
export const packerOf = (chain: Receipt[]): NodeId | undefined => (chain[0]?.kind === 'pickup' ? chain[0].from : undefined);
const round = (kg: number) => Math.round(kg * 1000) / 1000;

/** Skims: weight on the receipt OUT of X is lower than on the receipt INTO X, so X lost it. */
function skims(chain: Receipt[]): LeakFinding[] {
  const found: LeakFinding[] = [];
  for (let i = 1; i < chain.length; i++) {
    const into = chain[i - 1];
    const out = chain[i];
    const lost = into.measuredKg - out.measuredKg;
    // If a receipt is missing (into.to !== out.from) we still name into.to: the last holder we can prove had it.
    if (lost > WEIGHT_TOLERANCE_KG) {
      found.push({ packageId: out.packageId, kind: 'skim', holder: into.to, cell: out.cell, kgLost: round(lost), t: out.t });
    }
  }
  return found;
}

export function findLeaks(receipts: Receipt[], alerts: Alert[], ctx: LedgerContext): LeakFinding[] {
  const byBox = chains(receipts);
  const findings: LeakFinding[] = [];
  const has = (pkg: string, kind: LeakFinding['kind'], holder?: NodeId) =>
    findings.some((f) => f.packageId === pkg && f.kind === kind && (holder === undefined || f.holder === holder));

  // 1. Weight drops along each chain, and coerced hand-offs (duress PIN: the giver is the victim, not the thief).
  for (const chain of byBox.values()) {
    findings.push(...skims(chain));
    for (const r of chain) {
      if (r.coerced) findings.push({ packageId: r.packageId, kind: 'coerced', holder: r.from, cell: r.cell, kgLost: round(r.measuredKg), t: r.t });
    }
  }

  // 2. Live alerts fill gaps for receipts that have not reached us yet, and carry the clinic's manifest check.
  const sorted = [...alerts].sort((a, b) => a.t - b.t || cmp(a.reportedBy, b.reportedBy) || cmp(a.kind, b.kind));
  for (const a of sorted) {
    if (!a.packageId) continue;
    const pkg = a.packageId;
    const chain = byBox.get(pkg) ?? [];
    if (a.kind === 'weight-mismatch' && a.suspect && !has(pkg, 'skim', a.suspect)) {
      findings.push({ packageId: pkg, kind: 'skim', holder: a.suspect, cell: a.cell, kgLost: round(a.kg ?? 0), t: a.t });
    } else if (a.kind === 'coerced' && !has(pkg, 'coerced')) {
      findings.push({ packageId: pkg, kind: 'coerced', holder: a.suspect ?? a.reportedBy, cell: a.cell, kgLost: round(a.kg ?? 0), t: a.t });
    } else if (a.kind === 'short-delivery' && !has(pkg, 'short-at-clinic') && !has(pkg, 'packed-short')) {
      // Report only the part of the shortage that the chain's skims do not already explain.
      const skimmed = findings.filter((f) => f.packageId === pkg && f.kind === 'skim').reduce((s, f) => s + f.kgLost, 0);
      const residual = (a.kg ?? 0) - skimmed;
      if (a.kg !== undefined && residual <= WEIGHT_TOLERANCE_KG) continue;
      const packer = packerOf(chain);
      const suspect = a.suspect;
      // Pack short: first pickup already lighter than the manifest, so the clinic names the packer.
      const packedShort = suspect !== undefined && (suspect === packer || suspect.startsWith('store'));
      // Collusion: no weigh-in dropped, so the loss sits between the last honest weigh-in and the clinic.
      const deliverer = chain.find((r) => r.kind === 'delivered')?.from;
      findings.push({
        packageId: pkg,
        kind: packedShort ? 'packed-short' : 'short-at-clinic',
        holder: suspect ?? deliverer ?? a.reportedBy,
        cell: a.cell,
        kgLost: round(a.kg === undefined ? 0 : residual),
        t: a.t,
      });
    }
  }

  // 3. Vanished boxes: chain ends at a live holder, the box never arrived and nobody holds it now.
  for (const [pkg, chain] of byBox) {
    if (isDelivered(chain) || has(pkg, 'coerced')) continue;
    const last = chain[chain.length - 1];
    if (ctx.dead.has(last.to)) continue;          // lost in breakdown, not theft
    if (ctx.holding?.has(pkg)) continue;           // still on board somewhere: in transit
    findings.push({ packageId: pkg, kind: 'stolen', holder: last.to, cell: last.cell, kgLost: round(last.measuredKg), t: last.t });
  }

  return findings.sort((a, b) => a.t - b.t || cmp(a.packageId, b.packageId) || cmp(a.kind, b.kind) || cmp(a.holder, b.holder));
}
