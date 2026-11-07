import { describe, expect, it } from 'vitest';
import type { Alert, BreachDump, Metrics } from '../src/contracts/types';
import {
  alertKey, alertToFinding, ATTACKS, clampSpeed, clock, duration, exposure, exposureLines, findingKey, findingLine,
  isLossAlert, kg, killLabel, metricRows, newSeries, parseSweep, pct, pushPoint,
} from '../src/ui/format';

const dump = (over: Partial<BreachDump> = {}): BreachDump => ({
  nodeId: 'x', readableLabels: [], knownLocations: [], knownStockLevels: 0, readableBeneficiaryNotes: [], nextHop: null, ...over,
});

const alert = (over: Partial<Alert> = {}): Alert => ({
  t: 100, kind: 'weight-mismatch', reportedBy: 'van-02', suspect: 'moto-04', packageId: 'p-31', cell: 'C9-5', kg: 1.2, text: 'x', ...over,
});

describe('number formatting', () => {
  it('formats percent, kg and bad input', () => {
    expect(pct(42.6)).toBe('43%');
    expect(pct(NaN)).toBe('-');
    expect(kg(1.23)).toBe('1.2 kg');
    expect(kg(0.05)).toBe('0.05 kg');
  });
  it('formats durations', () => {
    expect(duration(0)).toBe('-');
    expect(duration(45)).toBe('45s');
    expect(duration(725)).toBe('12m 05s');
    expect(duration(7380)).toBe('2h 03m');
  });
  it('formats the sim clock', () => {
    expect(clock(0)).toBe('00:00:00');
    expect(clock(3725.9)).toBe('01:02:05');
    expect(clock(-5)).toBe('00:00:00');
  });
  it('clamps speed to 1..60', () => {
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(99)).toBe(60);
    expect(clampSpeed(12.4)).toBe(12);
    expect(clampSpeed(NaN)).toBe(1);
  });
});

describe('metric rows', () => {
  it('lists every required metric in order', () => {
    const m: Metrics = { t: 0, requestsOpen: 0, boxesTotal: 10, deliveredIntact: 7, deliveredShort: 0, skimmed: 1, stolen: 0,
      lostBreakdown: 1, inTransit: 1, duplicates: 0, leaksPinpointed: 1, attacksBlocked: 2, reachPct: 70, meanDeliverySec: 600,
      carriersAlive: 20, carriersTotal: 22 };
    const rows = metricRows(m);
    expect(rows.map((r) => r.key)).toEqual(['reach', 'intact', 'skimmed', 'stolen', 'lost', 'transit', 'dupes', 'mean', 'alive', 'blocked']);
    expect(rows[0].value).toBe('70%');
    expect(rows.find((r) => r.key === 'skimmed')!.tone).toBe('bad');
    expect(rows.find((r) => r.key === 'stolen')!.tone).toBeUndefined();
    expect(rows.find((r) => r.key === 'alive')!.value).toBe('20 / 22');
  });
});

describe('breach exposure', () => {
  it('mesh rider leaks nothing that scores', () => {
    const e = exposure(dump({ knownLocations: [{ what: 'hub', pos: { x: 0, y: 0 } }], nextHop: 'van-02' }));
    expect(e.score).toBe(0);
    expect(e.places).toBe(1);
    expect(exposureLines(e)).toContain('next hop: van-02');
  });
  it('central dump scores stores + stock + notes', () => {
    const e = exposure(dump({
      knownLocations: [{ what: 'store', pos: { x: 0, y: 0 } }, { what: 'store', pos: { x: 1, y: 1 } }, { what: 'clinic', pos: { x: 2, y: 2 } }],
      knownStockLevels: 2,
      readableBeneficiaryNotes: ['a', 'b', 'c'],
    }));
    expect(e).toMatchObject({ stores: 2, stock: 2, notes: 3, places: 1, score: 7 });
    expect(exposureLines(e)[0]).toBe('2 store locations');
    expect(exposureLines(exposure(dump({ knownStockLevels: 1 })))[1]).toBe('1 stock level');
  });
});

describe('alerts to findings', () => {
  it('maps loss alerts and names the suspect', () => {
    expect(isLossAlert(alert())).toBe(true);
    expect(isLossAlert(alert({ kind: 'bad-signature' }))).toBe(false);
    const f = alertToFinding(alert());
    expect(f).toEqual({ packageId: 'p-31', kind: 'skim', holder: 'moto-04', cell: 'C9-5', kgLost: 1.2, t: 100 });
    expect(findingLine(f)).toBe('Box p-31 lost 1.2 kg while held by moto-04, cell C9-5');
    expect(alertToFinding(alert({ kind: 'short-delivery' })).kind).toBe('short-at-clinic');
    expect(alertToFinding(alert({ suspect: undefined, kg: undefined })).holder).toBe('van-02');
  });
  it('dedupes re-raised alerts and matches ledger findings', () => {
    expect(alertKey(alert({ reportedBy: 'a' }))).toBe(alertKey(alert({ reportedBy: 'b' })));
    const ledger = { packageId: 'p-31', kind: 'skim' as const, holder: 'moto-04', cell: 'C9-5', kgLost: 1.2, t: 900 };
    expect(findingKey(ledger)).toBe(findingKey(alertToFinding(alert())));
  });
  it('has a line for every finding kind', () => {
    for (const kind of ['skim', 'stolen', 'short-at-clinic', 'packed-short', 'coerced'] as const)
      expect(findingLine({ packageId: 'p-1', kind, holder: 'h', cell: 'C1-1', kgLost: 1, t: 0 })).toMatch(/p-1/);
  });
});

describe('attack console', () => {
  it('has the ten attacks from PLAN 12.3', () => {
    expect(ATTACKS.map((a) => a.type)).toEqual(
      ['fakeCarrier', 'fakeClinic', 'replay', 'tamper', 'collude', 'packShort', 'flood', 'spoofGps', 'coerce', 'stealKey']);
  });
});

describe('sweep data', () => {
  it('accepts the right shape and rejects bad ones', () => {
    const ok = { kill: [0, 0.1], mesh: [90, 80], central: [30, 20] };
    expect(parseSweep(ok)).toEqual(ok);
    expect(parseSweep(null)).toBeNull();
    expect(parseSweep({ kill: [0], mesh: [1, 2], central: [1] })).toBeNull();
    expect(parseSweep({ kill: [], mesh: [], central: [] })).toBeNull();
    expect(parseSweep({ kill: ['a'], mesh: [1], central: [1] })).toBeNull();
  });
  it('labels kill fractions or percents', () => {
    expect(killLabel(0.3)).toBe('30%');
    expect(killLabel(40)).toBe('40%');
  });
});

describe('reach series', () => {
  it('appends, overwrites same t, restarts on reset', () => {
    const s = newSeries();
    pushPoint(s, 1, 10); pushPoint(s, 2, 20); pushPoint(s, 2, 25);
    expect(s.v).toEqual([10, 25]);
    pushPoint(s, 0, 5);
    expect(s.t).toEqual([0]);
  });
  it('decimates past the cap and keeps the newest point', () => {
    const s = newSeries();
    for (let i = 0; i < 11; i++) pushPoint(s, i, i * 10, 10);
    expect(s.t.length).toBeLessThanOrEqual(10);
    expect(s.t[s.t.length - 1]).toBe(10);
    expect(s.v[s.v.length - 1]).toBe(100);
    expect(s.t.length).toBe(s.v.length);
  });
});
