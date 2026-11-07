// Drop-in replacement for world.ts on REAL geography around Hawassa, Ethiopia (src/geo/hawassa.json:
// OpenStreetMap roads/water/places, Copernicus DEM). Same exports and signatures as world.ts, so the
// engine switches by changing one import. Fixed layout (same for every seed), fully deterministic.
//
// Layout (ids kept compatible with the patrol plans in setup.ts: hub-3 north, hub-2 middle, hub-1 south):
//   stores  store-A Hawassa (district store), store-B south Hawassa, store-C Shashemene (sub-store)
//   hubs    hub-1 Tula junction (south), hub-2 north Hawassa lakeshore (boat transfers), hub-3 trunk junction
//           on the Hawassa-Shashemene road (north)
//   clinics v1..v10 at real villages: Biishaan Gurachaa, Kala, Harabet Shumba, Wondo Genet, Dore (west
//           of the lake), Dembara (west), Busa, Abela Lida, Bona, Morocho
import { CELL_COVERAGE, CELL_SIZE, MEET_OFFSET, SPEED, WORLD_SIZE } from '../contracts/config';
import type { CarrierKind, CellId, Hub, MapQuery, NodeId, Vec2 } from '../contracts/types';
import {
  LAKE as GEO_LAKE, LAKE_AREA_M2, LAKE_CENTROID, PLACES, RIVERS, dist as geoDist, heightAt, inLake, lakeGraph,
  lakeLanding, nearestShore, pathLength as geoPathLength, placeByName, roadGraph, type Place,
} from '../geo';
import { NetGraph } from './world';

export { NetGraph };

// ---------- small geometry helpers (same as world.ts) ----------
export const dist = geoDist;
export const pathLength = geoPathLength;

// ---------- fixed layout ----------
export interface Village { id: string; name: string; pos: Vec2; clinicId: NodeId; riverside: boolean }
export interface Site { id: NodeId; pos: Vec2 }

const place = (name: string): Place => {
  const p = placeByName(name);
  if (!p) throw new Error(`world-hawassa: place "${name}" missing from hawassa.json`);
  return p;
};
/** Nearest point on the road network (so fixed sites sit on a road). */
const onRoad = (p: Vec2): Vec2 => { const q = roadGraph().snap(p).q; return { x: Math.round(q.x), y: Math.round(q.y) }; };

const HAWASSA = place('Hawassa').pos;
const SHASHEMENE = place('Shashamane').pos;            // OSM spelling

export const TOWN: Vec2 = { ...HAWASSA };               // district town (Hawassa), has the district store
export const STORES: Site[] = [
  { id: 'store-A', pos: onRoad({ x: 20300, y: 19300 }) },          // district store, Hawassa city
  { id: 'store-B', pos: onRoad({ x: 22260, y: 16910 }) },          // second store, south Hawassa on the trunk road
  { id: 'store-C', pos: onRoad({ x: SHASHEMENE.x + 300, y: SHASHEMENE.y - 300 }) },  // sub-store, Shashemene
];
export const HUBS: Hub[] = [
  { id: 'hub-1', pos: onRoad({ x: 19650, y: 9720 }) },             // south: Tula, trunk/tertiary junction
  // middle: north Hawassa lakeshore by Biishaan Gurachaa, boats land here. Kept > 4.5 km from every store so a
  // drone parked at a hub is never within radio range of a store (it must never learn where a store is).
  { id: 'hub-2', pos: onRoad({ x: 20103, y: 24499 }) },
  { id: 'hub-3', pos: onRoad({ x: 24300, y: 31700 }) },            // north: trunk junction towards Shashemene
];
export const DISPATCH_POS: Vec2 = { x: Math.round(HAWASSA.x + 400), y: Math.round(HAWASSA.y + 500) };  // central mode: server in Hawassa

/** Main river (longest 'river' polyline in the data); drawn only, nothing routes on it. */
export const RIVER: Vec2[] = (() => {
  const rivers = RIVERS.filter((r) => r.cls === 'river');
  const best = (rivers.length ? rivers : RIVERS).reduce((a, b) => (geoPathLength(b.pts) > geoPathLength(a.pts) ? b : a));
  return best.pts.map((p) => ({ ...p }));
})();
/** Lake Hawassa as a centre + equal-area radius (shape summary; the real outline is LAKE_POLY). */
export const LAKE = { center: { x: Math.round(LAKE_CENTROID.x), y: Math.round(LAKE_CENTROID.y) }, radius: Math.round(Math.sqrt(LAKE_AREA_M2 / Math.PI)) };
export const LAKE_POLY: Vec2[] = GEO_LAKE.map((p) => ({ ...p }));

const CLINIC_PLACES = [
  'Biishaan Gurachaa', 'Kala', 'Harabet Shumba', 'Wondo Genet', 'Dore', 'Dembara', 'Busa', 'Abela Lida', 'Bona', 'Morocho',
];
export const VILLAGES: Village[] = CLINIC_PLACES.map((name, i) => {
  const p = place(name).pos;
  return {
    id: `v${i + 1}`, name, pos: { x: Math.round(p.x), y: Math.round(p.y) }, clinicId: `clinic-${i + 1}`,
    riverside: nearestShore(p).d <= 4000,                // a boat landing is within 4 km
  };
});

// ---------- terrain ----------
/** Ground height in metres above sea level (real DEM, about 1680 m at the lake to 2675 m in the east). */
export function makeHeight(): (x: number, y: number) => number {
  return heightAt;
}

// ---------- cells (identical to world.ts) ----------
const CELLS = Math.ceil(WORLD_SIZE / CELL_SIZE);
export function cellOf(p: Vec2): CellId {
  const c = Math.max(0, Math.min(CELLS - 1, Math.floor(p.x / CELL_SIZE)));
  const r = Math.max(0, Math.min(CELLS - 1, Math.floor(p.y / CELL_SIZE)));
  return `C${c}-${r}`;
}
export function cellCenter(id: CellId): Vec2 {
  const m = /^C(\d+)-(\d+)$/.exec(id);
  if (!m) return { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  return { x: (Number(m[1]) + 0.5) * CELL_SIZE, y: (Number(m[2]) + 0.5) * CELL_SIZE };
}

/** Cell coverage exists only around Hawassa and Shashemene (config.ts CELL_COVERAGE is the fictional map's). */
const COVERAGE: { pos: Vec2; radius: number }[] = CELL_COVERAGE.map((c) => ({ pos: { ...c.pos }, radius: c.radius }));   // single source: config.ts
/** Is p inside a town's cell coverage (ignoring outages)? */
export const hasCoverage = (p: Vec2): boolean => COVERAGE.some((c) => dist(p, c.pos) <= c.radius);

// ---------- road and water networks, NetGraph-compatible ----------
const SHORE_BAND = 150;                                  // ground carriers may wade this far out to meet a boat

/** Roads for vans and motorbikes, backed by the geo road graph (shortest cost, class-weighted). */
class RoadNet extends NetGraph {
  constructor() {
    super([], []);                                       // the base all-pairs table stays empty: routing is in geo
    const g = roadGraph();
    Object.assign(this, { pts: g.nodes, edges: g.segs.map((s) => [s.a, s.b] as [number, number]) });
  }
  override snap(p: Vec2): { edge: number; q: Vec2; d: number } {
    const s = roadGraph().snap(p);
    return { edge: s.seg, q: s.q, d: s.d };
  }
  /** Path from -> roads -> to. The last off-road leg is walked only when `to` is on land (or the shore band). */
  override route(from: Vec2, to: Vec2, offNetEnd: boolean): Vec2[] {
    const wet = inLake(to) && nearestShore(to).d > SHORE_BAND;
    return roadGraph().shortestPath(from, to, offNetEnd && !wet).path;
  }
}

/** Lake Hawassa for boats: open-water straight lines, else a visibility graph just inside the shore. */
class WaterNet extends NetGraph {
  constructor() {
    super([], []);
    const g = lakeGraph();
    Object.assign(this, { pts: g.nodes, edges: g.edges });
  }
  /** The landing point for p: p itself on open water, else just off the nearest shore. */
  override snap(p: Vec2): { edge: number; q: Vec2; d: number } {
    const q = lakeLanding(p);
    return { edge: nearestShore(q).seg, q, d: dist(p, q) };
  }
  override route(from: Vec2, to: Vec2, _offNetEnd: boolean): Vec2[] {
    return lakeGraph().route(from, to);                  // boats stop at the landing nearest `to`
  }
}

// ---------- world object ----------
export interface World {
  villages: Village[];
  stores: Site[];
  hubs: Hub[];
  river: Vec2[];
  lake: Vec2[];
  roads: NetGraph;            // vans and motorbikes
  water: NetGraph;            // boats
  roadSegments: [Vec2, Vec2][];
  height: (x: number, y: number) => number;
  map: MapQuery;
  /** Extras for the real map (not in world.ts): cell coverage and every named place. */
  coverage: { pos: Vec2; radius: number }[];
  places: { name: string; kind: string; pos: Vec2 }[];
}

let cached: World | null = null;

/** The one Hawassa map. Built once and shared (it never changes during a run). */
export function createWorld(): World {
  if (cached) return cached;
  const roads = new RoadNet();
  const water = new WaterNet();
  const directM = 2 * MEET_OFFSET[1];

  const route = (kind: CarrierKind, from: Vec2, to: Vec2): Vec2[] => {
    if (kind === 'drone') return [from, to];
    if (kind === 'boat') return water.route(from, to, false);
    if (dist(from, to) <= directM && !inLake(to)) return [from, to];
    return roads.route(from, to, true);
  };
  const map: MapQuery = {
    cellOf,
    cellCenter,
    route,
    eta: (kind, from, to) => pathLength(route(kind, from, to)) / SPEED[kind],
    passable: (kind, p) =>
      kind === 'drone' ? true
        : kind === 'boat' ? inLake(p)
          : roadGraph().snap(p).d <= MEET_OFFSET[1] && (!inLake(p) || nearestShore(p).d <= SHORE_BAND),
    hubs: () => HUBS.map((h) => ({ id: h.id, pos: { ...h.pos } })),
  };
  const g = roadGraph();
  cached = {
    villages: VILLAGES,
    stores: STORES,
    hubs: HUBS,
    river: RIVER,
    lake: LAKE_POLY,
    roads,
    water,
    roadSegments: g.segs.map((s) => [g.nodes[s.a], g.nodes[s.b]] as [Vec2, Vec2]),
    height: makeHeight(),
    map,
    coverage: COVERAGE.map((c) => ({ pos: { ...c.pos }, radius: c.radius })),
    places: PLACES.map((p) => ({ name: p.name, kind: p.kind, pos: { ...p.pos } })),
  };
  return cached;
}
