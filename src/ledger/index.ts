// WP4 entry point: merged receipts in, one classified report out (shown on NETWORK UP).
import type { EngineApi, LedgerReport, NodeState } from '../contracts/types';
import { ReceiptStore } from './receipts';
import { chains, findLeaks, type LedgerContext } from './leaks';
import { tally } from './invariants';

export { ReceiptStore, receiptKey, receiptPayload, signReceipt, verifyReceipt } from './receipts';
export { mergeStores } from './merge';
export { chains, findLeaks } from './leaks';
export type { LedgerContext } from './leaks';
export { classify, countDuplicates } from './invariants';

/**
 * Build the ledger report. Pass `nodes` (Snapshot.nodes) when you have it: boxes still on board are then
 * "in transit" instead of "stolen". Without it, any undelivered chain ending at a live holder counts as stolen.
 */
export async function buildReport(input: ReturnType<EngineApi['ledgerInput']>, nodes?: NodeState[]): Promise<LedgerReport> {
  const store = new ReceiptStore(input.signPubs);
  await store.addAll(input.receipts);

  const ctx: LedgerContext = { dead: new Set(input.dead) };
  if (nodes) {
    ctx.holding = new Map();
    for (const n of nodes) {
      if (!n.alive) ctx.dead.add(n.id);
      else for (const p of n.boxes) ctx.holding.set(p, n.id);
    }
  }

  const receipts = store.all();
  const findings = findLeaks(receipts, input.alerts, ctx);
  return tally(chains(receipts), findings, ctx, store.badSignatures);
}
