// Append-only receipt store. Every receipt is checked against the receiver's public key before it goes in.
import type { NodeId, Receipt } from '../contracts/types';
import { canonical, sign, verify } from '../privacy/core';

/** One stable key per custody event. seq is the box's logical counter, so clocks never matter. */
export const receiptKey = (r: Receipt): string => `${r.packageId}:${r.kind}:${r.from}:${r.to}:${r.seq}`;

/** The bytes the receiver signs: every field except the two signatures. */
export const receiptPayload = (r: Receipt): Omit<Receipt, 'sigTo' | 'sigFrom'> => {
  const { sigTo: _to, sigFrom: _from, ...rest } = r;
  return rest;
};

/** Helper for agents and tests: the receiver signs a receipt it is about to stamp. */
export async function signReceipt(r: Omit<Receipt, 'sigTo' | 'sigFrom'>, receiverSignPriv: CryptoKey): Promise<Receipt> {
  return { ...r, sigTo: await sign(receiptPayload(r as Receipt), receiverSignPriv) };
}

/** Receiver signature check. Unknown receivers fail too (no key = no trust). */
export async function verifyReceipt(r: Receipt, signPubs: Record<NodeId, string>): Promise<boolean> {
  const pub = signPubs[r.to];
  if (!pub || typeof r.sigTo !== 'string') return false;
  return verify(receiptPayload(r), r.sigTo, pub);
}

export type AddResult = 'added' | 'known' | 'rejected';

export class ReceiptStore {
  /** key -> receipt. Only verified receipts live here. */
  readonly entries = new Map<string, Receipt>();
  /** Fingerprints of receipts that failed verification, so the same forgery seen twice counts once. */
  readonly rejected = new Set<string>();

  constructor(readonly signPubs: Record<NodeId, string>) {}

  async add(r: Receipt): Promise<AddResult> {
    const key = receiptKey(r);
    const fp = `${key}:${r.sigTo}`;
    if (this.rejected.has(fp)) return 'rejected';
    const have = this.entries.get(key);
    if (have && canonical(have) === canonical(r)) return 'known';
    if (!(await verifyReceipt(r, this.signPubs))) {
      this.rejected.add(fp);
      return 'rejected';
    }
    this.put(key, r);
    return have ? 'known' : 'added';
  }

  async addAll(rs: Receipt[]): Promise<void> {
    for (const r of rs) await this.add(r);
  }

  /** Insert an already-verified receipt. If two valid receipts share a key (receiver signed twice),
   *  keep the canonically smaller one so the result never depends on arrival order. */
  put(key: string, r: Receipt): void {
    const have = this.entries.get(key);
    if (!have || canonical(r) < canonical(have)) this.entries.set(key, r);
  }

  get badSignatures(): number {
    return this.rejected.size;
  }

  /** All receipts, sorted by key, so callers always see the same order. */
  all(): Receipt[] {
    return [...this.entries.keys()].sort().map((k) => this.entries.get(k)!);
  }

  /** PLAN 12.2 #14: a carrier keeps only receipts for boxes it touched, and drops them once delivery is confirmed. */
  prune(self: NodeId, deliveredPackageIds: Iterable<string>): void {
    const done = new Set(deliveredPackageIds);
    const touched = new Set<string>();
    for (const r of this.entries.values()) if (r.from === self || r.to === self) touched.add(r.packageId);
    for (const [k, r] of this.entries) if (!touched.has(r.packageId) || done.has(r.packageId)) this.entries.delete(k);
  }
}
