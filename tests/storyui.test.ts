// Story UI pure helpers: black box instructions from a dump + logs, glass box weight-drop highlighting.
import { describe, expect, it } from 'vitest';
import type { BreachDump, Label, LeakFinding, Metrics, Receipt } from '../src/contracts/types';
import { defaultNamer, derivePlan, readLogs, theftItems, theftYield } from '../src/ui/blackbox';
import { boxStatus, custody, manifestRows, orderBoxes, weightDrops } from '../src/ui/glassbox';
import { lossStats, sideStats } from '../src/ui/beforeAfter';

const label = (packageId: string, destCell: string, urgency: 1 | 2 | 3 = 2): Label => ({
  packageId, requestId: `r-${packageId}`, attempt: 1, urgency, size: 'M', cold: false, destCell, deadline: 9000,
});
const dump = (over: Partial<BreachDump> = {}): BreachDump => ({
  nodeId: 'moto-04', readableLabels: [], knownLocations: [], knownStockLevels: 0, readableBeneficiaryNotes: [], nextHop: null, ...over,
});

// Real Hawassa places (src/geo/hawassa.json): Tula ~(19705, 9814), Bona ~(18108, 11427).
const TULA_HUB = { x: 19800, y: 9900 };
const TULA_MEET = { x: 19950, y: 10050 };

describe('black box: place names come from the real map', () => {
  it('names cells after the nearest Hawassa village', () => {
    expect(defaultNamer.cell('C9-4')).toBe('Tula');
    expect(defaultNamer.clinic('C9-5')).toBe('Bona health post');
    expect(defaultNamer.clinic('C0-0')).toMatch(/clinic in C0-0|health post/);
  });
});

describe('black box: instructions from dump + logs', () => {
  const crates = [label('p-a', 'C9-5', 1), label('p-b', 'C9-4', 3)];

  it('accepted hand-off at a hub: meet partner at the junction, with minutes, hand over the right crate', () => {
    const plan = derivePlan({
      id: 'moto-07', kind: 'motorbike', pos: { x: 19950, y: 6050 },
      dump: dump({ readableLabels: crates, nextHop: 'moto-04', knownLocations: [{ what: 'hub', pos: TULA_HUB }, { what: 'handoff', pos: TULA_MEET }] }),
      logs: [
        '[100s] Offering box p-b to moto-04: its ETA to C9-4 is 8 min vs my 14 min.',
        '[101s] moto-04 accepted box p-b; heading to the meeting point.',
      ],
    });
    expect(plan.next).toMatch(/^Meet moto-04 at Tula junction in \d+ min, hand over crate 2$/);
    expect(plan.steps[0]).toBe('Crate 1: deliver to Bona health post. Contents: sealed.');
    expect(plan.steps[1]).toBe('Crate 2: hand over to moto-04 at Tula junction. Contents: sealed.');
    expect(plan.sealed).toBe(true);
  });

  it('a finished hand-off drops out; the most urgent remaining crate leads', () => {
    const plan = derivePlan({
      id: 'moto-07', kind: 'motorbike', dump: dump({ readableLabels: [crates[0]] }),
      logs: ['[100s] moto-04 accepted box p-b; heading to the meeting point.', '[160s] Handed box p-b to moto-04. Meeting point wiped.'],
    });
    expect(plan.next).toBe('Take crate 1 to Bona health post');
  });

  it('clinic signed reply means hand over now; calling means wait', () => {
    const replied = derivePlan({
      id: 'drone-02', kind: 'drone', dump: dump({ readableLabels: [crates[0]] }),
      logs: ['[10s] In C9-5 with box p-a: calling the clinic for a signed reply.', '[11s] clinic-4 sent a valid signed reply for box p-a. Delivering.'],
    });
    expect(replied.next).toBe('Hand crate 1 to the staff at Bona health post');
    const calling = derivePlan({ id: 'drone-02', kind: 'drone', dump: dump({ readableLabels: [crates[0]] }), logs: ['[10s] In C9-5 with box p-a: calling the clinic for a signed reply.'] });
    expect(calling.next).toBe("Wait at Bona health post for the clinic's signed reply, then hand over crate 1");
  });

  it('a hand-off nobody answered is cancelled', () => {
    const f = readLogs(['[1s] Offering box p-a to van-02: its ETA to C9-5 is 5 min vs my 9 min.', '[40s] No answer from van-02 about box p-a; keeping it.']);
    expect(f.deals.size).toBe(0);
  });

  it('taking a box: meet the giver, minutes from the logged distance', () => {
    const plan = derivePlan({
      id: 'drone-01', kind: 'drone', t: 100, dump: dump(),
      logs: ['[100s] Taking box p-z from van-02: meeting 3000 m from here.'],
    });
    expect(plan.next).toBe('Meet van-02 at the agreed meeting point in 2 min, collect a sealed crate');
  });

  it('explicit instructions win and lose their NEXT: prefix', () => {
    const plan = derivePlan({ id: 'x', kind: 'van', dump: dump(), logs: [], instructions: ['NEXT: meet moto-04 at Tula junction', 'step two'] });
    expect(plan.next).toBe('meet moto-04 at Tula junction');
    expect(plan.steps).toEqual(['step two']);
  });

  it('empty carriers and central-mode orders', () => {
    expect(derivePlan({ id: 'van-01', kind: 'van', dump: dump(), logs: [] }).next).toBe('Collect sealed crates at the store');
    const central = derivePlan({
      id: 'moto-01', kind: 'motorbike', dump: dump({ readableLabels: [crates[0]], readableBeneficiaryNotes: ['12 children'], knownStockLevels: 3 }),
      logs: ['[5s] New order: collect p-a at store-A for clinic-4', '[50s] Collected p-a; driving direct to clinic-4'],
    });
    expect(central.next).toBe('Drive direct to Bona health post with crate 1');
    expect(central.sealed).toBe(false);
    expect(derivePlan({ id: 'moto-01', kind: 'motorbike', dump: dump(), logs: ['[5s] Network down: holding position until dispatch is back'] }).next)
      .toMatch(/^Hold position/);
  });

  it('theft line: a mesh rider leaks one next stop and none of the three secrets', () => {
    const y = theftYield(dump({ readableLabels: crates, nextHop: 'moto-04', knownLocations: [{ what: 'hub', pos: TULA_HUB }] }));
    expect(y).toMatchObject({ nextStops: 1, labels: 2, stores: 0, stock: 0, notes: 0, score: 0 });
    expect(theftItems(y).filter((i) => i.tone === 'zero')).toHaveLength(3);
    const c = theftYield(dump({ knownLocations: [{ what: 'store', pos: { x: 1, y: 1 } }], knownStockLevels: 3, readableBeneficiaryNotes: ['a', 'b'] }));
    expect(c.score).toBe(6);
    expect(theftItems(c).filter((i) => i.tone === 'hot')).toHaveLength(3);
  });
});

// ---------- glass box ----------
const rc = (seq: number, kind: Receipt['kind'], from: string, to: string, kg: number, t = 100 + seq * 60, cell = `C9-${seq}`): Receipt => ({
  packageId: 'p-31', requestId: 'r-12', attempt: 1, kind, from, to, t, seq, cell, measuredKg: kg, sigTo: 'sig',
});
// store-A -> van-02 -> moto-04 -> drone-01 -> clinic-4, moto-04 skims 1.2 kg
const chain = [rc(0, 'pickup', 'store-A', 'van-02', 5), rc(1, 'handoff', 'van-02', 'moto-04', 5), rc(2, 'handoff', 'moto-04', 'drone-01', 3.8), rc(3, 'delivered', 'drone-01', 'clinic-4', 3.8)];
const skim: LeakFinding = { packageId: 'p-31', kind: 'skim', holder: 'moto-04', cell: 'C9-2', kgLost: 1.2, t: 220 };

describe('glass box: weight-drop highlighting', () => {
  it('pins a ledger skim finding to the hop out of the holder', () => {
    const d = weightDrops(chain, [skim]);
    expect([...d.keys()]).toEqual([2]);
    const c = custody(chain, [skim]);
    expect(c.rows.map((r) => r.tone)).toEqual(['ok', 'ok', 'bad', 'ok']);
    expect(c.rows[2].notes[0]).toBe('Weight dropped 1.2 kg while moto-04 held it. Named in the ledger.');
    expect(c.rows[2].deltaKg).toBe(-1.2);
    expect(c.packer).toBe('store-A');
  });

  it('a live-alert finding (different time and cell) still lands on the right hop', () => {
    expect([...weightDrops(chain, [{ ...skim, t: 999, cell: 'C1-1' }]).keys()]).toEqual([2]);
  });

  it('ignores other boxes and non-skim findings; no findings means a clean timeline', () => {
    expect(weightDrops(chain, [{ ...skim, packageId: 'p-99' }]).size).toBe(0);
    const clean = custody(chain, []);
    expect(clean.rows.every((r) => r.tone === 'ok')).toBe(true);
    expect(clean.tail?.tone).toBe('ok');
  });

  it('stolen, short at clinic and packed short are marked where they happened', () => {
    const open = chain.slice(0, 2);
    expect(custody(open, [{ packageId: 'p-31', kind: 'stolen', holder: 'moto-04', cell: 'C9-1', kgLost: 5, t: 160 }]).tail)
      .toEqual({ text: 'Box vanished after moto-04, last seen in C9-1.', tone: 'bad' });
    const short = custody(chain, [{ packageId: 'p-31', kind: 'short-at-clinic', holder: 'drone-01', cell: 'C9-3', kgLost: 1.4, t: 280 }]);
    expect(short.rows[3].tone).toBe('bad');
    const packed = custody(chain, [{ packageId: 'p-31', kind: 'packed-short', holder: 'store-A', cell: 'C9-0', kgLost: 0.5, t: 100 }]);
    expect(packed.rows[0].notes[0]).toMatch(/Packer store-A named/);
  });

  it('status, ordering and manifest rows', () => {
    expect(boxStatus(chain, [skim])).toEqual({ text: 'Skimmed, hop named', tone: 'bad' });
    expect(boxStatus(chain, [])).toEqual({ text: 'Delivered intact', tone: 'ok' });
    const other = [{ ...chain[0], packageId: 'p-01', t: 10 }];
    const byBox = new Map([['p-31', chain], ['p-01', other]]);
    expect(orderBoxes(['p-01', 'p-31'], byBox, [skim])).toEqual(['p-31', 'p-01']);
    const m = manifestRows({ requestId: 'r-12', items: [{ code: 'RUTF-30', qty: 2 }, { code: 'ORS-ZN', qty: 1 }], declaredKg: 6.1, beneficiaryNote: '12 children' });
    expect(m.itemsKg).toBe(6.1);
    expect(m.rows[0].name).toMatch(/Therapeutic food/);
  });
});

describe('before/after numbers', () => {
  const m = (over: Partial<Metrics>): Metrics => ({
    t: 0, requestsOpen: 0, boxesTotal: 0, deliveredIntact: 0, deliveredShort: 0, skimmed: 0, stolen: 0, lostBreakdown: 0, inTransit: 0,
    duplicates: 0, leaksPinpointed: 0, attacksBlocked: 0, reachPct: 0, meanDeliverySec: 0, carriersAlive: 0, carriersTotal: 0, ...over,
  });
  it('counts losses and pins', () => {
    expect(lossStats(m({ skimmed: 2, stolen: 1, deliveredShort: 1, leaksPinpointed: 3 }))).toEqual({ losses: 4, pinned: 3 });
    expect(sideStats(m({ reachPct: 81.6, skimmed: 1 }), 27).map((s) => s.value)).toEqual(['82%', '0 of 1', '27']);
  });
});
