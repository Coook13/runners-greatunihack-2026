// FROZEN numbers. Only the lead edits this file. Every tunable lives here so nobody hard-codes it.
import type { CarrierKind, NodeKind, SizeClass, Vec2 } from './types';

export const WORLD_SIZE = 40000;            // metres, square district
export const CELL_SIZE = 2000;              // metres; labels and receipts only ever carry cells
export const TICK_DT = 0.5;                 // sim seconds per tick
export const DEMO_SEED = 7;
export const WARMUP_SEC = 3600;             // fast-forward 60 sim-minutes so the demo opens with boxes already landing

export const SPEED: Record<CarrierKind, number> = { drone: 25, motorbike: 12, van: 9, boat: 9 };  // m/s; boat = outboard skiff (~17 knots)  // m/s
export const RADIO_RANGE: Record<NodeKind, number> = {
  drone: 3000, motorbike: 2000, van: 3000, boat: 3000, store: 4000, clinic: 4000, dispatch: 0,
};
export const MAX_HOPS = 6;                  // mesh store-and-forward limit
export const TRANSFER_RADIUS = 25;          // metres; both sides must be this close
export const HANDOFF_MARGIN = 0.2;          // neighbour must beat my ETA by 20%
export const MEET_OFFSET: [number, number] = [100, 300];  // random offset from midpoint / hub, metres
export const DETOUR_BUDGET = 1500;          // vans/motorbikes: max detour for a hand-off, metres
export const RESEND_EVERY = 30;             // sim seconds: agents re-broadcast undelivered requests / receipts

export const SIZE_UNITS: Record<SizeClass, number> = { S: 1, M: 2, L: 4 };
export const CAPACITY: Record<CarrierKind, number> = { drone: 2, motorbike: 4, van: 24, boat: 12 };  // in size units
export const DRONE_RANGE_M = 60000;         // full battery; recharge at a parked van at a hub
export const DRONE_CHARGE_X = 4;           // parked at a hub or a van, a drone recharges this many times faster than it drains (battery swap)
export const COUNTS = { stores: 3, clinics: 10, drones: 12, motorbikes: 10, vans: 5, boats: 2, hubs: 3 };   // vans: one per store + 2 where demand per van is highest (setup.ts vanPlan)

// Cell network only exists near towns. NETWORK DOWN switches all of it off.
export const CELL_COVERAGE: { pos: Vec2; radius: number }[] = [
  // Real towns around Hawassa. Most clinics can phone in while the network is up (a fair "today" baseline);
  // Harabet Shumba, Dembara and Morocho are genuinely remote and only the mesh reaches them.
  { pos: { x: 19732, y: 19694 }, radius: 7000 },   // Hawassa city
  { pos: { x: 34134, y: 36921 }, radius: 5000 },   // Shashemene
  { pos: { x: 19704, y: 9814 }, radius: 5500 },    // Tula
  { pos: { x: 34702, y: 23826 }, radius: 5500 },   // Wondo Genet
  { pos: { x: 31600, y: 15600 }, radius: 3500 },   // Busa
  { pos: { x: 6327, y: 18647 }, radius: 2500 },    // Dore (west shore)
];

export const DEMAND = {
  ratePerHour: 4,                           // new requests per sim-hour across the district (before surge)
  surgeAtSec: 3600,                         // after warmup the rate doubles
  surgeMultiplier: 2,
  deadlineSec: { 1: 6 * 3600, 2: 3 * 3600, 3: 90 * 60 } as Record<1 | 2 | 3, number>,
  demandAnomalyX: 3,                        // a clinic asking for 3x its usual volume is flagged
};

export const WEIGHT_TOLERANCE_KG = 0.05;    // scale noise allowed before a mismatch alert
export const CERT_TTL_SEC = 24 * 3600;
export const RATE_LIMIT_PER_MIN = 60;       // messages per node per sim-minute before rate limiting
export const NONCE_CACHE = 2000;

export const DWELL = { radius: 30, minSec: 20, guessHitRadius: 300 };   // raiders (PLAN 3.8)
export const TRACK_SAMPLE_SEC = 5;          // engine.trackHistory() samples every carrier position at this interval (DWELL.minSec / 4); raid() takes it as sampleSec

// Item catalogue. Weights are illustrative, not sourced.
export const CATALOGUE: Record<string, { name: string; kg: number; cold: boolean }> = {
  'RUTF-30': { name: 'Therapeutic food, carton of 30 sachets', kg: 2.8, cold: false },
  'ORS-ZN':  { name: 'Oral rehydration + zinc kit', kg: 0.5, cold: false },
  'AMOX':    { name: 'Amoxicillin dispersible, pack', kg: 0.3, cold: false },
  'MUAC':    { name: 'MUAC measuring tapes, pack', kg: 0.1, cold: false },
  'VAX-MR':  { name: 'Measles-rubella vaccine, cold box', kg: 1.5, cold: true },
};

export const SIZE_FOR_KG = (kg: number): SizeClass => (kg <= 3 ? 'S' : kg <= 7 ? 'M' : 'L');
