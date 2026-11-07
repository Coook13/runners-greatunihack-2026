// Raiders (PLAN 3.8): an outsider who only watches vans drive around and tries to find the stores.
// 1. Dwell points: a van stays within DWELL.radius of one spot for at least DWELL.minSec.
// 2. Cluster dwell points that sit close together (repeat visits to the same place).
// 3. Guess the busiest clusters are stores (as many guesses as there are stores).
// 4. Score = share of real stores with a guess within DWELL.guessHitRadius.
// Mesh rotates hand-off spots, so its dwells scatter; central drives store -> clinic direct, so stores light up.
import type { NodeId, Vec2 } from '../contracts/types';
import { COUNTS, DWELL } from '../contracts/config';

export interface Dwell { pos: Vec2; sec: number; who: NodeId }
export interface Cluster { pos: Vec2; visits: number; sec: number }
export interface RaidResult { dwells: Dwell[]; clusters: Cluster[]; guesses: Vec2[]; hits: number; score: number }

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (ps: Vec2[]): Vec2 => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

/** Find the spots where one track lingered. sampleSec = seconds between track samples. */
export function dwellPoints(track: Vec2[], sampleSec: number, who: NodeId = ''): Dwell[] {
  const out: Dwell[] = [];
  let i = 0;
  while (i < track.length) {
    let j = i + 1;
    while (j < track.length && dist(track[j], track[i]) <= DWELL.radius) j++;
    const sec = (j - 1 - i) * sampleSec;
    if (sec >= DWELL.minSec) { out.push({ pos: mean(track.slice(i, j)), sec, who }); i = j; } else i++;
  }
  return out;
}

/** Greedy clustering: each dwell joins the first cluster within `radius`, else starts a new one. */
export function clusterDwells(dwells: Dwell[], radius = DWELL.guessHitRadius / 2): Cluster[] {
  const groups: Dwell[][] = [];
  for (const d of dwells) {
    const g = groups.find((g) => dist(mean(g.map((x) => x.pos)), d.pos) <= radius);
    if (g) g.push(d); else groups.push([d]);
  }
  return groups.map((g) => ({ pos: mean(g.map((d) => d.pos)), visits: g.length, sec: g.reduce((s, d) => s + d.sec, 0) }))
    .sort((a, b) => (b.visits - a.visits) || (b.sec - a.sec));
}

/**
 * Run the raider on engine tracks (EngineApi.trackHistory()).
 * Only van tracks are watched (ids starting with 'van', per the NodeId convention), unless `watch` says otherwise.
 */
export function raid(
  tracks: Record<NodeId, Vec2[]>, sampleSec: number, stores: Vec2[],
  opts: { guesses?: number; watch?: (id: NodeId) => boolean } = {},
): RaidResult {
  const watch = opts.watch ?? ((id: NodeId) => id.startsWith('van'));
  const dwells = Object.keys(tracks).sort().filter(watch).flatMap((id) => dwellPoints(tracks[id], sampleSec, id));
  const clusters = clusterDwells(dwells);
  // A one-off stop is not a pattern: only places visited at least twice count as guesses.
  const guesses = clusters.filter((c) => c.visits >= 2).slice(0, opts.guesses ?? COUNTS.stores).map((c) => c.pos);
  const hits = stores.filter((s) => guesses.some((g) => dist(g, s) <= DWELL.guessHitRadius)).length;
  return { dwells, clusters, guesses, hits, score: stores.length ? hits / stores.length : 0 };
}
