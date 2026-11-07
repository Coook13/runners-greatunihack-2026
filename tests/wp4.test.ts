import { beforeAll, describe, expect, it } from 'vitest';
import type { Alert, KeySet, Receipt } from '../src/contracts/types';
import { generateKeySet } from '../src/privacy/core';
import { buildReport, mergeStores, ReceiptStore, signReceipt } from '../src/ledger';

// Real keys and real signatures for every node in the tests.
const ids = ['store-A', 'van-01', 'moto-01', 'moto-02', 'drone-01', 'clinic-1', 'clinic-2', 'thief'];
const keys: Record<string, KeySet> = {};
const signPubs: Record<string, string> = {};

beforeAll(async () => {
  for (const id of ids) {
    keys[id] = await generateKeySet();
    signPubs[id] = keys[id].signPub;
  }
});

type Hop = [kind: Receipt['kind'], from: string, to: string, kg: number];

/** Build a signed chain for one box. Each receipt is signed by its receiver. */
async function chain(packageId: string, hops: Hop[], requestId = `r-${packageId}`): Promise<Receipt[]> {
  const out: Receipt[] = [];
  for (const [i, [kind, from, to, kg]] of hops.entries()) {
    out.push(await signReceipt(
      { packageId, requestId, attempt: 1, kind, from, to, t: 100 + i * 60, seq: i, cell: `C${i}-1`, measuredKg: kg },
      keys[to].signPriv,
    ));
  }
  return out;
}

const input = (receipts: Receipt[], alerts: Alert[] = [], dead: string[] = []) => ({ receipts, alerts, dead, signPubs });

describe('WP4 ledger', () => {
  it('merge is order-independent', async () => {
    const a = await chain('p-1', [['pickup', 'store-A', 'van-01', 5], ['handoff', 'van-01', 'moto-01', 5]]);
    const b = await chain('p-2', [['pickup', 'store-A', 'van-01', 3], ['handoff', 'van-01', 'drone-01', 3]]);
    const forged = { ...a[1], measuredKg: 9 };
    const s1 = new ReceiptStore(signPubs);
    await s1.addAll([a[0], a[1], b[0]]);
    const s2 = new ReceiptStore(signPubs);
    await s2.addAll([b[1], a[1], forged]);
    const s3 = new ReceiptStore(signPubs);
    await s3.addAll([b[0]]);

    const x = mergeStores(s1, s2, s3);
    const y = mergeStores(s3, s2, s1);
    const z = mergeStores(mergeStores(s2, s3), s1);
    expect(x.all()).toEqual(y.all());
    expect(x.all()).toEqual(z.all());
    expect(x.all()).toHaveLength(4);
    expect(x.badSignatures).toBe(1);
    expect(y.badSignatures).toBe(1);
  });

  it('A->B->C with C out-weight 1.2 kg lower names C', async () => {
    const r = await chain('p-31', [
      ['pickup', 'store-A', 'van-01', 6],
      ['handoff', 'van-01', 'moto-01', 6],
      ['handoff', 'moto-01', 'moto-02', 6],
      ['delivered', 'moto-02', 'clinic-1', 4.8],
    ]);
    const rep = await buildReport(input(r));
    expect(rep.findings).toHaveLength(1);
    expect(rep.findings[0]).toMatchObject({ packageId: 'p-31', kind: 'skim', holder: 'moto-02', cell: 'C3-1', kgLost: 1.2 });
    expect(rep.skimmed).toBe(1);
    expect(rep.boxes).toBe(1);
  });

  it('a chain ending at a live carrier is stolen and names it; a dead one is a breakdown', async () => {
    const stolen = await chain('p-5', [['pickup', 'store-A', 'van-01', 5], ['handoff', 'van-01', 'moto-01', 5]]);
    const broken = await chain('p-6', [['pickup', 'store-A', 'van-01', 5], ['handoff', 'van-01', 'drone-01', 5]]);
    const rep = await buildReport(input([...stolen, ...broken], [], ['drone-01']));
    expect(rep.stolen).toBe(1);
    expect(rep.lostBreakdown).toBe(1);
    expect(rep.findings).toEqual([expect.objectContaining({ packageId: 'p-5', kind: 'stolen', holder: 'moto-01' })]);
  });

  it('a box still on board is in transit when Snapshot.nodes is given', async () => {
    const r = await chain('p-7', [['pickup', 'store-A', 'van-01', 5]]);
    const nodes = [{ id: 'van-01', kind: 'van' as const, pos: { x: 0, y: 0 }, alive: true, boxes: ['p-7'], battery: 1, cellSignal: false }];
    const rep = await buildReport(input(r), nodes);
    expect(rep.inTransit).toBe(1);
    expect(rep.findings).toEqual([]);
  });

  it('forged receipts are rejected and counted, never used', async () => {
    const r = await chain('p-8', [['pickup', 'store-A', 'van-01', 5], ['delivered', 'van-01', 'clinic-1', 5]]);
    // Thief edits the weight on a real receipt, and signs one claiming to be the clinic with its own key.
    const edited = { ...r[1], measuredKg: 1 };
    const impostor = await signReceipt({ ...r[1], seq: 5, to: 'clinic-2' }, keys['thief'].signPriv);
    const unknown = await signReceipt({ ...r[1], seq: 6, to: 'ghost' }, keys['thief'].signPriv);
    const rep = await buildReport(input([...r, edited, edited, impostor, unknown]));
    expect(rep.badSignatures).toBe(3);
    expect(rep.deliveredIntact).toBe(1);
    expect(rep.findings).toEqual([]);
  });

  it('two delivered boxes for one request = 1 duplicate', async () => {
    const a = await chain('p-10', [['pickup', 'store-A', 'van-01', 3], ['delivered', 'van-01', 'clinic-1', 3]], 'r-9');
    const b = await chain('p-11', [['pickup', 'store-A', 'moto-01', 3], ['delivered', 'moto-01', 'clinic-1', 3]], 'r-9');
    const rep = await buildReport(input([...a, ...b]));
    expect(rep.duplicates).toBe(1);
    expect(rep.deliveredIntact).toBe(2);
  });

  it('short-delivery alerts: packer named for pack short, last carrier for collusion', async () => {
    const packed = await chain('p-20', [['pickup', 'store-A', 'van-01', 4], ['delivered', 'van-01', 'clinic-1', 4]]);
    const coll = await chain('p-21', [['pickup', 'store-A', 'van-01', 5], ['delivered', 'van-01', 'clinic-2', 5]]);
    const alerts: Alert[] = [
      { t: 500, kind: 'short-delivery', reportedBy: 'clinic-1', packageId: 'p-20', suspect: 'store-A', cell: 'C1-1', kg: 1, text: '' },
      { t: 600, kind: 'short-delivery', reportedBy: 'clinic-2', packageId: 'p-21', cell: 'C1-1', kg: 1.4, text: '' },
    ];
    const rep = await buildReport(input([...packed, ...coll], alerts));
    expect(rep.deliveredShort).toBe(2);
    expect(rep.findings).toEqual([
      expect.objectContaining({ packageId: 'p-20', kind: 'packed-short', holder: 'store-A', kgLost: 1 }),
      expect.objectContaining({ packageId: 'p-21', kind: 'short-at-clinic', holder: 'van-01', kgLost: 1.4 }),
    ]);
  });

  it('a skim already named on the chain is not double counted by the clinic alert', async () => {
    const r = await chain('p-22', [['pickup', 'store-A', 'van-01', 5], ['delivered', 'van-01', 'clinic-1', 3.8]]);
    const alerts: Alert[] = [{ t: 500, kind: 'short-delivery', reportedBy: 'clinic-1', packageId: 'p-22', cell: 'C1-1', kg: 1.2, text: '' }];
    const rep = await buildReport(input(r, alerts));
    expect(rep.findings).toHaveLength(1);
    expect(rep.findings[0]).toMatchObject({ kind: 'skim', holder: 'van-01' });
  });

  it('coerced hand-off names the victim rider as coerced, not stolen', async () => {
    const r = await chain('p-30', [['pickup', 'store-A', 'van-01', 5], ['handoff', 'van-01', 'moto-01', 5]]);
    const forced = await signReceipt(
      { packageId: 'p-30', requestId: 'r-p-30', attempt: 1, kind: 'handoff', from: 'moto-01', to: 'thief', t: 400, seq: 2, cell: 'C4-4', measuredKg: 5, coerced: true },
      keys['thief'].signPriv,
    );
    const rep = await buildReport(input([...r, forced]));
    expect(rep.stolen).toBe(1);
    expect(rep.findings).toEqual([expect.objectContaining({ kind: 'coerced', holder: 'moto-01' })]);
  });

  it('every box lands in exactly one bucket', async () => {
    const r = [
      ...(await chain('q-1', [['pickup', 'store-A', 'van-01', 5], ['delivered', 'van-01', 'clinic-1', 5]])),
      ...(await chain('q-2', [['pickup', 'store-A', 'van-01', 5], ['handoff', 'van-01', 'moto-01', 4]])),
      ...(await chain('q-3', [['pickup', 'store-A', 'drone-01', 5]])),
    ];
    const rep = await buildReport(input(r, [], ['drone-01']));
    const sum = rep.deliveredIntact + rep.deliveredShort + rep.skimmed + rep.stolen + rep.lostBreakdown + rep.inTransit;
    expect(sum).toBe(rep.boxes);
  });
});
