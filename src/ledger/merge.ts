// Merge = union. Both inputs are already verified, so nothing is re-checked here.
// ReceiptStore.put resolves key clashes deterministically, so merge(a, b) equals merge(b, a).
import { ReceiptStore } from './receipts';

export function mergeStores(...stores: ReceiptStore[]): ReceiptStore {
  const signPubs = Object.assign({}, ...stores.map((s) => s.signPubs));
  const out = new ReceiptStore(signPubs);
  for (const s of stores) {
    for (const [k, r] of s.entries) out.put(k, r);
    for (const fp of s.rejected) out.rejected.add(fp);
  }
  return out;
}
