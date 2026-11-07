// Pure formatting helpers for the UI. No DOM, no chart.js: unit-tested in tests/wp6.format.test.ts.
import type { Alert, AlertKind, BreachDump, Label, LeakFinding, Metrics, WorldEvent } from '../contracts/types';

// Presentation-only limits (not sim tunables).
export const SPEED_MIN = 1;
export const SPEED_MAX = 60;
export const LOG_LINES = 15;
export const SKIM_DEFAULT_KG = 1.2;       // starting value of the skim amount box

export const clampSpeed = (x: number): number =>
  Number.isFinite(x) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(x))) : SPEED_MIN;

export const pct = (v: number): string => (Number.isFinite(v) ? `${Math.round(v)}%` : '-');

export const int = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : '-');

export function kg(v: number): string {
  if (!Number.isFinite(v)) return '-';
  return `${v.toFixed(Math.abs(v) < 1 ? 2 : 1)} kg`;
}

/** Human duration: "45s", "12m 05s", "2h 03m". Zero or bad input shows "-". */
export function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '-';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const two = (n: number) => String(n).padStart(2, '0');
  if (s < 3600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
}

/** Sim clock as hh:mm:ss. */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(t) ? t : 0));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** Rows of the metrics panel, in display order. */
export function metricRows(m: Metrics): { key: string; label: string; value: string; tone?: 'good' | 'bad' }[] {
  return [
    { key: 'reach', label: 'Reach', value: pct(m.reachPct), tone: 'good' },
    { key: 'intact', label: 'Delivered intact', value: int(m.deliveredIntact) },
    { key: 'skimmed', label: 'Skimmed', value: int(m.skimmed), tone: m.skimmed > 0 ? 'bad' : undefined },
    { key: 'stolen', label: 'Stolen', value: int(m.stolen), tone: m.stolen > 0 ? 'bad' : undefined },
    { key: 'lost', label: 'Lost in breakdowns', value: int(m.lostBreakdown) },
    { key: 'transit', label: 'In transit', value: int(m.inTransit) },
    { key: 'dupes', label: 'Duplicates', value: int(m.duplicates) },
    { key: 'mean', label: 'Mean delivery time', value: duration(m.meanDeliverySec) },
    { key: 'alive', label: 'Carriers alive', value: `${int(m.carriersAlive)} / ${int(m.carriersTotal)}` },
    { key: 'blocked', label: 'Attacks blocked', value: int(m.attacksBlocked) },
  ];
}

// ---------- breach exposure ----------
export interface Exposure {
  stores: number;           // exact store locations
  stock: number;            // stores whose stock levels are known
  notes: number;            // readable beneficiary notes (child data)
  labels: number;           // readable box labels (routing info only)
  places: number;           // clinics, hubs and hand-off points known
  nextHop: string | null;
  score: number;            // PLAN 3.9: store locations + stock levels + beneficiary notes
}

export function exposure(d: BreachDump): Exposure {
  const stores = d.knownLocations.filter((l) => l.what === 'store').length;
  const stock = Math.max(0, d.knownStockLevels | 0);
  const notes = d.readableBeneficiaryNotes.length;
  return {
    stores,
    stock,
    notes,
    labels: d.readableLabels.length,
    places: d.knownLocations.length - stores,
    nextHop: d.nextHop,
    score: stores + stock + notes,
  };
}

/** One line per exposure item, as the breach card shows it. */
export function exposureLines(e: Exposure): string[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    plural(e.stores, 'store location', 'store locations'),
    plural(e.stock, 'stock level', 'stock levels'),
    plural(e.notes, 'clinic note on children', 'clinic notes on children'),
    plural(e.labels, 'box label (cells only)', 'box labels (cells only)'),
    e.nextHop ? `next hop: ${e.nextHop}` : 'no next hop',
  ];
}

// ---------- alerts and leak findings ----------
// Alerts that mean food went missing go to the Leak Finder; the rest are security events.
export const LOSS_ALERTS: AlertKind[] = ['weight-mismatch', 'short-delivery', 'coerced'];
export const isLossAlert = (a: Alert): boolean => LOSS_ALERTS.includes(a.kind);

export function alertToFinding(a: Alert): LeakFinding {
  const kind: LeakFinding['kind'] =
    a.kind === 'short-delivery' ? 'short-at-clinic' : a.kind === 'coerced' ? 'coerced' : 'skim';
  return {
    packageId: a.packageId ?? '',
    kind,
    holder: a.suspect ?? a.reportedBy,
    cell: a.cell,
    kgLost: a.kg ?? 0,
    t: a.t,
  };
}

/** Same box + same kind + same suspect = same alert, even if several nodes re-raise it. */
export const alertKey = (a: Alert): string => `${a.kind}|${a.packageId ?? ''}|${a.suspect ?? a.reportedBy}`;

/** Live alerts and ledger findings about the same loss share this key, so the list shows it once. */
export const findingKey = (f: LeakFinding): string => `${f.kind}|${f.packageId}|${f.holder}`;

export function findingLine(f: LeakFinding): string {
  const box = f.packageId ? `Box ${f.packageId}` : 'A box';
  switch (f.kind) {
    case 'skim':
      return `${box} lost ${kg(f.kgLost)} while held by ${f.holder}, cell ${f.cell}`;
    case 'stolen':
      return `${box} vanished; last holder ${f.holder}, cell ${f.cell}`;
    case 'short-at-clinic':
      return `${box} arrived ${kg(f.kgLost)} short; loss after ${f.holder}, cell ${f.cell}`;
    case 'packed-short':
      return `${box} packed ${kg(f.kgLost)} short; packer ${f.holder} named`;
    case 'coerced':
      return `${box} handed over under duress by ${f.holder}, cell ${f.cell}; rider not blamed`;
  }
}

export const findingKindLabel: Record<LeakFinding['kind'], string> = {
  skim: 'Skimmed',
  stolen: 'Stolen',
  'short-at-clinic': 'Short at clinic',
  'packed-short': 'Packed short',
  coerced: 'Coerced',
};

export const labelLine = (l: Label): string =>
  `${l.packageId} to ${l.destCell}, urgency ${l.urgency}, size ${l.size}${l.cold ? ', cold' : ''}`;

// ---------- attack console ----------
export type AttackType = Extract<
  WorldEvent['type'],
  'fakeCarrier' | 'fakeClinic' | 'replay' | 'tamper' | 'collude' | 'packShort' | 'flood' | 'spoofGps' | 'coerce' | 'stealKey'
>;

export const ATTACKS: { type: AttackType; label: string; hint: string }[] = [
  { type: 'fakeCarrier', label: 'Fake carrier', hint: 'Uncertified carrier tries to collect a box' },
  { type: 'fakeClinic', label: 'Ghost clinic', hint: 'Uncertified node requests food' },
  { type: 'replay', label: 'Replay', hint: 'Re-send an old delivered request' },
  { type: 'tamper', label: 'Tamper', hint: 'Flip a byte in a message' },
  { type: 'collude', label: 'Collude', hint: 'Two carriers sign a fake weight' },
  { type: 'packShort', label: 'Pack short', hint: 'Store packs under weight' },
  { type: 'flood', label: 'Flood', hint: 'One node spams 500 messages' },
  { type: 'spoofGps', label: 'Spoof GPS', hint: 'Carrier position jumps 5 km' },
  { type: 'coerce', label: 'Coerce', hint: 'Rider hands over a box at gunpoint' },
  { type: 'stealKey', label: 'Steal key', hint: "Copy a rider's signing key" },
];

// ---------- sweep chart ----------
export interface SweepData { kill: number[]; mesh: number[]; central: number[] }

/** Validates the sweep.json shape; returns null if it is wrong so the UI can say so. */
export function parseSweep(data: unknown): SweepData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const nums = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (!nums(d.kill) || !nums(d.mesh) || !nums(d.central)) return null;
  if (d.kill.length === 0 || d.mesh.length !== d.kill.length || d.central.length !== d.kill.length) return null;
  return { kill: d.kill, mesh: d.mesh, central: d.central };
}

/** Kill fraction (0..1) or percent (0..100) both render as a percent label. */
export const killLabel = (k: number): string => `${Math.round(k <= 1 ? k * 100 : k)}%`;

// ---------- time series for the live reach chart ----------
export interface Series { t: number[]; v: number[] }

export const newSeries = (): Series => ({ t: [], v: [] });

/**
 * Adds a point. Time going backwards means a reset, so the series restarts.
 * When the series passes maxPoints, every other point is dropped so the chart stays light.
 */
export function pushPoint(s: Series, t: number, v: number, maxPoints = 240): void {
  const last = s.t.length ? s.t[s.t.length - 1] : -Infinity;
  if (t < last) { s.t.length = 0; s.v.length = 0; }
  else if (t === last) { s.v[s.v.length - 1] = v; return; }
  s.t.push(t);
  s.v.push(v);
  if (s.t.length > maxPoints) {
    s.t = s.t.filter((_, i) => i % 2 === 0 || i === s.t.length - 1);
    s.v = s.v.filter((_, i, arr) => i % 2 === 0 || i === arr.length - 1);
  }
}
