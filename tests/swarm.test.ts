import { describe, expect, it } from 'vitest';
import { CELL_COVERAGE, CELL_SIZE, RADIO_RANGE, SPEED } from '../src/contracts/config';
import type { MapQuery, NodeKind, Vec2 } from '../src/contracts/types';
import {
  type AuctionResult, type AuctionState, type Bidder, type Flier, type Gossip, type Peer, type Task, SWARM, auctionStep,
  auctionWinner, bandOf, chargeDecision, inTownCoverage, emptyAuction, emptyPatrol, formation, netStatus, patrolStep, planRelays,
  radioGroups, separate, stepAlt, taskId, toward,
} from '../src/agents/swarm';

// ---------- a flat test world: straight lines everywhere, no hubs ----------
const cellOf = (p: Vec2) => `C${Math.floor(p.x / CELL_SIZE)}-${Math.floor(p.y / CELL_SIZE)}`;
const map: MapQuery = {
  cellOf,
  cellCenter: (c) => {
    const [col, row] = c.slice(1).split('-').map(Number);
    return { x: (col + 0.5) * CELL_SIZE, y: (row + 0.5) * CELL_SIZE };
  },
  route: (_k, a, b) => [a, b],
  eta: (k, a, b) => Math.hypot(a.x - b.x, a.y - b.y) / SPEED[k],
  passable: () => true,
  hubs: () => [],
};
const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

// ---------- auction harness: synchronous gossip rounds over a fixed link graph ----------
const VAN = { id: 'van-01', pos: { x: 20000, y: 20000 } };
const task = (pkg: string, dest: Vec2, urgency: 1 | 2 | 3, units = 1): Task => ({
  id: taskId(pkg, VAN.id), packageId: pkg, holder: VAN.id, holderKind: 'van', pos: VAN.pos, dest,
  destCell: cellOf(dest), urgency, units,
});
const TASKS = [
  task('p-1', { x: 32000, y: 20000 }, 3),
  task('p-2', { x: 20000, y: 32000 }, 2),
  task('p-3', { x: 8000, y: 20000 }, 1),
];
const drone = (id: string, x: number, y: number, spare = 1): Bidder => ({ id, kind: 'drone', pos: { x, y }, battery: 1, spare });
const BIDDERS = [
  drone('drone-01', 21000, 20000), drone('drone-02', 20500, 21500), drone('drone-03', 19000, 20500),
  drone('drone-04', 20000, 19000, 2), drone('drone-05', 22000, 21000),
];
const ring = (ids: string[]): [string, string][] => ids.map((id, k) => [id, ids[(k + 1) % ids.length]]);

interface Run { rounds: { results: Record<string, AuctionResult> }[]; states: Record<string, AuctionState> }

function runAuction(bidders: Bidder[], links: [string, string][], rounds: number, opts: { from?: Run; drop?: string; t0?: number } = {}): Run {
  const agents = [...bidders.map((b) => b.id), VAN.id].filter((id) => id !== opts.drop);
  const nb = (id: string) => links.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : [])).filter((x) => x !== opts.drop);
  const states: Record<string, AuctionState> = opts.from ? { ...opts.from.states } : {};
  let last: Record<string, { out: Gossip; }> = {};
  if (opts.from) {
    const r = opts.from.rounds[opts.from.rounds.length - 1].results;
    for (const id of Object.keys(r)) last[id] = { out: { from: id, t: r[id].state.seen[id], ...r[id].out } };
  }
  const out: Run = { rounds: [], states };
  const t0 = opts.t0 ?? 100;
  for (let r = 0; r < rounds; r++) {
    const now = t0 + r * 2;
    const results: Record<string, AuctionResult> = {};
    for (const id of agents) {
      const me: Bidder = bidders.find((b) => b.id === id) ?? { id, kind: 'van', pos: VAN.pos, battery: 1, spare: 0 };
      const gossip = nb(id).flatMap((n) => (last[n] ? [last[n].out] : []));
      results[id] = auctionStep(states[id] ?? emptyAuction(), { me, now, tasks: TASKS, gossip, map, bidding: id !== VAN.id });
    }
    last = {};
    for (const id of agents) {
      states[id] = results[id].state;
      last[id] = { out: { from: id, t: now, ...results[id].out } };
    }
    out.rounds.push({ results });
  }
  return out;
}

/** Per task: the winner every agent agrees on, or null if they disagree / more than one claims it. */
function consensus(res: Record<string, AuctionResult>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const t of TASKS) {
    const views = new Set(Object.values(res).map((r) => r.state.table[t.id]?.bidder ?? 'none'));
    const claimers = Object.entries(res).filter(([, r]) => r.wins.some((w) => w.task.id === t.id)).map(([id]) => id);
    out[t.id] = views.size === 1 && claimers.length === 1 && [...views][0] === claimers[0] ? claimers[0] : null;
  }
  return out;
}

describe('task auction (CBBA-style)', () => {
  it('converges to one winner per box under partial connectivity (ring, no chords)', () => {
    const links = [...ring(BIDDERS.map((b) => b.id)), [VAN.id, 'drone-01'], [VAN.id, 'drone-03']] as [string, string][];
    const run = runAuction(BIDDERS, links, 12);
    const firstStable = run.rounds.findIndex((_, k) =>
      run.rounds.slice(k).every((r) => Object.values(consensus(r.results)).every((w) => w !== null)));
    expect(firstStable).toBeGreaterThanOrEqual(0);
    expect(firstStable).toBeLessThanOrEqual(6);                       // "within a few ticks" (2 s beacon rounds)
    const final = run.rounds[run.rounds.length - 1].results;
    const winners = consensus(final);
    // each bidder respects its spare capacity
    for (const b of BIDDERS) {
      const used = final[b.id].wins.reduce((s, w) => s + w.task.units, 0);
      expect(used).toBeLessThanOrEqual(b.spare);
    }
    // the holder sees the same winner and gets a log line naming the bids
    const w = auctionWinner(final[VAN.id].state, TASKS[0].id);
    expect(w?.bid.bidder).toBe(winners[TASKS[0].id]);
    expect(w?.reason).toMatch(/won with \d\.\d+/);
    // every agent's log uses plain sentences with the numbers in them
    const lines = run.rounds.flatMap((r) => Object.values(r.results).flatMap((x) => x.reasons));
    expect(lines.some((l) => /^Bid \d\.\d+ for p-\d .*I win\.$/.test(l))).toBe(true);
  });

  it('in one radio group (beacons reach everyone) two drones never both act on the same box', () => {
    const ids = BIDDERS.map((b) => b.id);
    const links = ids.flatMap((a, k) => [...ids.slice(k + 1).map((b) => [a, b] as [string, string]), [a, VAN.id] as [string, string]]);
    const run = runAuction(BIDDERS, links, 10);
    for (const r of run.rounds) {
      for (const t of TASKS) {
        const settled = Object.values(r.results).filter((x) => x.wins.some((w) => w.task.id === t.id && w.settled));
        expect(settled.length).toBeLessThanOrEqual(1);
      }
    }
    expect(Object.values(consensus(run.rounds[run.rounds.length - 1].results)).every((w) => w !== null)).toBe(true);
  });

  it('re-auctions when the winner goes silent', () => {
    const links = [...ring(BIDDERS.map((b) => b.id)), [VAN.id, 'drone-01'], [VAN.id, 'drone-03']] as [string, string][];
    const run = runAuction(BIDDERS, links, 12);
    const before = consensus(run.rounds[run.rounds.length - 1].results);
    const gone = before[TASKS[0].id]!;
    expect(gone).toBeTruthy();
    const after = runAuction(BIDDERS, links, 14, { from: run, drop: gone, t0: 124 });
    const final = consensus(after.rounds[after.rounds.length - 1].results);
    expect(final[TASKS[0].id]).not.toBeNull();
    expect(final[TASKS[0].id]).not.toBe(gone);
    const lines = after.rounds.flatMap((r) => Object.values(r.results).flatMap((x) => x.reasons));
    expect(lines.some((l) => l.includes(`Winner ${gone}`) && l.includes('went silent') && l.includes('re-auctioning'))).toBe(true);
  });

  it('refuses forged bids above the maximum and bids from untrusted nodes', () => {
    const me = drone('drone-01', 21000, 20000);
    const forged: Gossip = { from: 'drone-02', t: 100, seen: {}, bids: [{ task: TASKS[0].id, bidder: 'fake-01', value: 9.99, stamp: 100 }] };
    const r1 = auctionStep(emptyAuction(), { me, now: 100, tasks: TASKS, gossip: [forged], map });
    expect(r1.state.table[TASKS[0].id]?.bidder).toBe('drone-01');
    expect(r1.reasons.some((l) => l.includes('above the highest possible bid'))).toBe(true);
    const sybil: Gossip = { from: 'fake-01', t: 100, seen: {}, bids: [{ task: TASKS[0].id, bidder: 'fake-01', value: 2, stamp: 100 }] };
    const r2 = auctionStep(emptyAuction(), { me, now: 100, tasks: TASKS, gossip: [sybil], map, trusted: (id) => id !== 'fake-01' });
    expect(r2.state.table[TASKS[0].id]?.bidder).toBe('drone-01');
  });

  it('does not bid when the holder is already nearly as fast (the 20% rule)', () => {
    const near = task('p-9', { x: 20500, y: 20000 }, 3);            // van is 500 m from the clinic
    const r = auctionStep(emptyAuction(), { me: drone('drone-01', 25000, 20000), now: 100, tasks: [near], gossip: [], map });
    expect(r.wins).toEqual([]);
  });
});

// ---------- relays ----------
const P = (id: string, kind: NodeKind, x: number, y: number, heardAt: number, extra: Partial<Peer> = {}): Peer =>
  ({ id, kind, pos: { x, y }, heardAt, ...extra });
const NOW = 1000;
// West group (fresh): clinic-1, van-01, three drones. East group (beacons 60 s old): moto-04, clinic-2. Gap 4 km.
const LAYOUT: Peer[] = [
  P('clinic-1', 'clinic', 2000, 20000, 0),
  P('van-01', 'van', 4000, 20000, NOW, { swarm: { role: 'idle' } }),
  P('drone-01', 'drone', 3500, 20500, NOW, { battery: 1, holding: [], swarm: { role: 'idle' } }),
  P('drone-02', 'drone', 3000, 19500, NOW, { battery: 1, holding: [], swarm: { role: 'idle' } }),
  P('drone-03', 'drone', 3800, 20200, NOW, { battery: 1, holding: [{ packageId: 'p-7', destCell: 'C10-10', urgency: 3 }], swarm: { role: 'courier' } }),
  P('moto-04', 'motorbike', 8000, 20000, NOW - 60),
  P('clinic-2', 'clinic', 10000, 20000, 0),
];
const asMe = (id: string, relaySlot: string | null = null, layout = LAYOUT) => {
  const p = layout.find((x) => x.id === id)!;
  return {
    me: { id, kind: p.kind, pos: p.pos, battery: 1, carrying: p.holding ?? [], busy: p.swarm?.role === 'courier', relaySlot },
    peers: layout.filter((x) => x.id !== id),
  };
};

describe('connectivity relays', () => {
  it('places a relay that bridges two disconnected groups, picked the same way by every drone', () => {
    const plans = ['drone-01', 'drone-02', 'drone-03'].map((id) =>
      planRelays({ ...asMe(id), now: NOW, networkDown: true, hubs: [], cellOf }));
    expect(plans[0].groups.length).toBe(2);
    expect(plans[0].slots.length).toBe(1);
    for (const p of plans) expect(p.slots.map((s) => [s.id, s.assignee])).toEqual(plans[0].slots.map((s) => [s.id, s.assignee]));
    // drone-03 is closest but carries an urgent box: never taken. drone-01 is the nearest idle one.
    expect(plans[0].mine?.assignee).toBe('drone-01');
    expect(plans[0].role).toBe('relay');
    expect(plans[0].phase).toBe('relay');
    expect(plans[1].mine).toBeNull();
    expect(plans[2].mine).toBeNull();
    expect(plans[0].reasons[0]).toMatch(/cut off .* I'm the nearest idle drone: relay 1 of 1 at C\d+-\d+\./);
    // with the relay hovering at its post, every node (true ranges, true positions) is in one radio group
    const relayed = [...LAYOUT.filter((p) => p.id !== 'drone-01'), P('drone-01', 'drone', plans[0].mine!.pos.x, plans[0].mine!.pos.y, NOW)];
    expect(radioGroups(relayed).length).toBe(1);
  });

  it('keeps the post once the bridge works (no flapping), and stands down when towers return', () => {
    const first = planRelays({ ...asMe('drone-01'), now: NOW, networkDown: true, hubs: [], cellOf });
    const post = first.mine!;
    // 10 s later: drone-01 hovers at the post, and the east group is heard again (fresh) through it
    const moved = LAYOUT.map((p) => (p.kind === 'clinic' ? p
      : p.id === 'drone-01' ? { ...p, heardAt: NOW + 10, pos: post.pos, swarm: { role: 'relay' as const, relaySlot: post.id } }
        : { ...p, heardAt: NOW + 10 }));
    const again = planRelays({ ...asMe('drone-01', post.id, moved), now: NOW + 10, networkDown: true, hubs: [], cellOf });
    expect(again.mine?.id).toBe(post.id);
    expect(again.reasons[0]).toMatch(/^Holding relay post/);
    const other = planRelays({ ...asMe('drone-02', null, moved), now: NOW + 10, networkDown: true, hubs: [], cellOf });
    expect(other.mine).toBeNull();
    const up = planRelays({ ...asMe('drone-01', post.id, moved), now: NOW + 20, networkDown: false, hubs: [], cellOf });
    expect(up.mine).toBeNull();
    expect(up.reasons).toEqual(['Towers are back up: leaving my relay post.']);
  });

  it('never uses more than the relay budget', () => {
    const chain: Peer[] = [0, 1, 2, 3, 4].flatMap((k) => [
      P(`clinic-${k}`, 'clinic', 2000 + k * 6000, 5000, 0),
      P(`moto-${k}`, 'motorbike', 2500 + k * 6000, 5000, NOW),
    ]);
    const drones = [1, 2, 3, 4, 5, 6].map((k) => P(`drone-0${k}`, 'drone', 2000 + k * 300, 5200, NOW, { battery: 1, holding: [], swarm: { role: 'idle' } }));
    const all = [...chain, ...drones];
    const plan = planRelays({ ...asMe('drone-01', null, all), now: NOW, networkDown: true, hubs: [], maxRelays: 2, cellOf });
    expect(plan.slots.length).toBeLessThanOrEqual(2);
    expect(new Set(plan.slots.map((s) => s.assignee)).size).toBe(plan.slots.length);
  });

  it('learns the towers are down first-hand inside town, or from a beacon outside it', () => {
    const inTown = netStatus({ me: 'drone-01', pos: { ...CELL_COVERAGE[0].pos }, cellSignal: false, now: 50, peers: [] });
    expect(inTown.down).toBe(true);
    expect(inTown.reasons[0]).toMatch(/towers are down/);
    const far = [{ x: 500, y: 500 }, { x: 39500, y: 500 }, { x: 500, y: 39500 }, { x: 39500, y: 39500 }].find((p) => !inTownCoverage(p))!;
    const outside = netStatus({ me: 'drone-02', pos: far, cellSignal: false, now: 52, peers: [P('drone-01', 'drone', 0, 0, 52, { swarm: { net: inTown.obs! } })] });
    expect(outside.down).toBe(true);
    expect(outside.reasons[0]).toBe('drone-01 reports the towers are down. Mesh only from here.');
  });
});

// ---------- separation ----------
interface Sim { fliers: (Flier & { goal: Vec2 })[] }
function stepFlight(sim: Sim, dt = 0.5): { reasons: string[] } {
  const reasons: string[] = [];
  const results = sim.fliers.map((f) => {
    const others = sim.fliers.filter((o) => o.id !== f.id);
    const r = separate({ me: f, desired: toward(f.pos, f.goal, SPEED.drone, dt), others, cellOf });
    reasons.push(...r.reasons);
    return r;
  });
  sim.fliers = sim.fliers.map((f, k) => ({
    ...f, vel: results[k].vel, pos: { x: f.pos.x + results[k].vel.x * dt, y: f.pos.y + results[k].vel.y * dt },
    alt: stepAlt(f.alt, results[k].alt, dt),
  }));
  return { reasons };
}
function violations(sim: Sim): string[] {
  const out: string[] = [];
  for (let a = 0; a < sim.fliers.length; a++) {
    for (let b = a + 1; b < sim.fliers.length; b++) {
      const x = sim.fliers[a], y = sim.fliers[b];
      if (d(x.pos, y.pos) < SWARM.SEP_MIN && Math.abs(x.alt - y.alt) < SWARM.ALT_SEP) out.push(`${x.id}/${y.id} ${Math.round(d(x.pos, y.pos))} m`);
    }
  }
  return out;
}
function crossing(n: number, r = 1500): Sim {
  const c = { x: 20000, y: 20000 };
  return {
    fliers: Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n;
      const pos = { x: c.x - r * Math.cos(a), y: c.y - r * Math.sin(a) };
      const goal = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
      const vel = toward(pos, goal, SPEED.drone);
      return { id: `drone-0${k + 1}`, pos, goal, vel, alt: bandOf(vel) === 'east' ? SWARM.ALT_EAST : SWARM.ALT_WEST };
    }),
  };
}

describe('separation in flight', () => {
  it('a lone drone flies the layer for its direction: eastbound 110 m, westbound 130 m', () => {
    const e = separate({ me: { id: 'drone-01', pos: { x: 0, y: 0 }, vel: { x: 25, y: 0 }, alt: 110 }, desired: { x: 25, y: 0 }, others: [] });
    const w = separate({ me: { id: 'drone-01', pos: { x: 0, y: 0 }, vel: { x: -25, y: 0 }, alt: 130 }, desired: { x: -25, y: 0 }, others: [] });
    expect([e.alt, w.alt]).toEqual([110, 130]);
    expect(e.reasons).toEqual([]);
  });

  it('six drones converging on one point: never within 80 m at the same altitude', () => {
    const sim = crossing(6);
    const lines: string[] = [];
    for (let s = 0; s < 240; s++) {
      lines.push(...stepFlight(sim).reasons);
      expect(violations(sim)).toEqual([]);
    }
    expect(lines.some((l) => l.startsWith('Yielding to drone-0'))).toBe(true);
  });

  it('a seeded mix of crossing, overtaking and parallel drones keeps separation', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const fliers: Sim['fliers'] = [];
    while (fliers.length < 8) {
      const pos = { x: 18000 + rnd() * 4000, y: 18000 + rnd() * 4000 };
      if (fliers.some((f) => d(f.pos, pos) < 300)) continue;
      const goal = { x: 18000 + rnd() * 4000, y: 18000 + rnd() * 4000 };
      if (d(pos, goal) < 2000) continue;
      const vel = toward(pos, goal, SPEED.drone);
      fliers.push({ id: `drone-0${fliers.length + 1}`, pos, goal, vel, alt: bandOf(vel) === 'east' ? 110 : 130 });
    }
    const sim = { fliers };
    for (let s = 0; s < 200; s++) {
      stepFlight(sim);
      expect(violations(sim)).toEqual([]);
    }
  });
});

// ---------- coverage ----------
describe('patrol coverage', () => {
  const sites = [
    { id: 'clinic-1', pos: { x: 10000, y: 10000 } },
    { id: 'clinic-2', pos: { x: 10000, y: 14000 } },
    { id: 'clinic-3', pos: { x: 14000, y: 10000 } },
  ];
  const me = { id: 'moto-01', kind: 'motorbike' as const, pos: { x: 12000, y: 12000 } };
  const visited = { ...emptyPatrol(), visits: { 'clinic-1': 100, 'clinic-2': 500, 'clinic-3': 900 } };

  it('picks the clinic nobody has visited for longest', () => {
    const r = patrolStep(visited, { me, now: 1000, sites, peers: [], map });
    expect(r.site).toBe('clinic-1');
    expect(r.out.patrolClaim).toEqual({ site: 'clinic-1', t: 1000 });
    expect(r.reasons[0]).toMatch(/^Patrol: clinic-1 is the stalest clinic I know \(last visit 15 min ago\)/);
  });

  it('avoids a clinic a neighbour just claimed, and yields an older claim', () => {
    const rival = P('moto-02', 'motorbike', 11000, 11000, 998, { swarm: { patrolClaim: { site: 'clinic-1', t: 990 } } });
    const r = patrolStep(visited, { me, now: 1000, sites, peers: [rival], map });
    expect(r.site).toBe('clinic-2');
    expect(r.reasons[0]).toContain('moto-02 has clinic-1');
    const mine = { ...visited, claim: { site: 'clinic-1', target: sites[0].pos, t: 995 } };
    const y = patrolStep(mine, { me, now: 1000, sites, peers: [rival], map });
    expect(y.reasons[0]).toBe('moto-02 claimed clinic-1 first; switching.');
    expect(y.site).toBe('clinic-2');
  });

  it('records a visit on arrival and learns visits from beacons', () => {
    const there = { ...me, pos: { x: 10000, y: 10100 } };
    const claim = { ...visited, claim: { site: 'clinic-1', target: sites[0].pos, t: 900 } };
    const peer = P('boat-01', 'boat', 0, 0, 999, { swarm: { visits: { 'clinic-2': 990 } } });
    const r = patrolStep(claim, { me: there, now: 1000, sites, peers: [peer], map });
    expect(r.state.visits['clinic-1']).toBe(1000);
    expect(r.state.visits['clinic-2']).toBe(990);
    expect(r.site).toBe('clinic-3');                                   // now the stalest
  });
});

// ---------- formation and charging ----------
describe('formation and charging', () => {
  it('drones to the same cell pick one leader and distinct slots at least 80 m apart', () => {
    const dest = { x: 30000, y: 20000 };
    const cell = cellOf(dest);
    const pos: Record<string, Vec2> = { 'drone-01': { x: 20000, y: 20300 }, 'drone-02': { x: 20400, y: 19800 }, 'drone-03': { x: 19800, y: 19600 } };
    const peers = (me: string) => Object.entries(pos).filter(([id]) => id !== me)
      .map(([id, p]) => P(id, 'drone', p.x, p.y, 100, { holding: [{ packageId: `p-${id}`, destCell: cell, urgency: 2 }], swarm: { role: 'courier', dest: cell } }));
    const res = Object.keys(pos).map((id) => formation({ me: { id, pos: pos[id], destCell: cell, urgency: 2 }, dest, peers: peers(id), now: 100 }));
    expect(new Set(res.map((r) => r.leader)).size).toBe(1);
    expect(res[0].leader).toBe('drone-02');                            // closest to the destination
    expect(res.map((r) => r.slot).sort()).toEqual([0, 1, 2]);
    expect(res.every((r) => r.shape === 'V')).toBe(true);
    const lead = res.find((r) => r.slot === 0)!;
    expect(lead.reasons[0]).toMatch(/^Leading drone-01, drone-03 to C15-10 in a V/);
    const h = { x: 1, y: 0 };                                          // leader heading (due east)
    const slot = (k: number) => ({ x: pos['drone-02'].x - Math.ceil(k / 2) * SWARM.V_BACK * h.x, y: pos['drone-02'].y + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * SWARM.V_SIDE });
    const pts = [pos['drone-02'], slot(1), slot(2)];
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) expect(d(pts[a], pts[b])).toBeGreaterThanOrEqual(80);
    const solo = formation({ me: { id: 'drone-09', pos: { x: 0, y: 0 }, destCell: cell, urgency: 1 }, dest, peers: [], now: 100 });
    expect(solo.shape).toBe('solo');
  });

  it('returns to charge when the battery cannot cover the trip and the way back', () => {
    const hubs = [{ id: 'hub-1', pos: { x: 10000, y: 10000 } }];
    const box = { destCell: 'C15-5', dest: { x: 31000, y: 11000 }, urgency: 2 as const };
    const low = chargeDecision({ me: { pos: { x: 12000, y: 10000 }, battery: 0.3, carrying: [box] }, hubs });
    expect(low.action).toBe('return');
    expect(low.reasons[0]).toMatch(/^Battery 30% .* returning to hub-1/);
    const ok = chargeDecision({ me: { pos: { x: 12000, y: 10000 }, battery: 0.9, carrying: [box] }, hubs });
    expect(ok.action).toBe('continue');
    const parked = chargeDecision({ me: { pos: { x: 10100, y: 10000 }, battery: 0.5, carrying: [] }, hubs });
    expect([parked.action, parked.phase]).toEqual(['charge', 'charging']);
  });
});

// ---------- determinism and purity ----------
describe('determinism', () => {
  it('same inputs give the same outputs, and inputs are never mutated', () => {
    const links = [...ring(BIDDERS.map((b) => b.id)), [VAN.id, 'drone-01']] as [string, string][];
    expect(JSON.stringify(runAuction(BIDDERS, links, 8))).toBe(JSON.stringify(runAuction(BIDDERS, links, 8)));
    const a = crossing(6), b = crossing(6);
    for (let s = 0; s < 100; s++) { stepFlight(a); stepFlight(b); }
    expect(a).toEqual(b);
    const frozen = deepFreeze({ ...asMe('drone-01'), now: NOW, networkDown: true, hubs: [], cellOf });
    expect(planRelays(frozen)).toEqual(planRelays({ ...asMe('drone-01'), now: NOW, networkDown: true, hubs: [], cellOf }));
    const st = deepFreeze(emptyAuction());
    const inp = deepFreeze({ me: drone('drone-01', 21000, 20000), now: 100, tasks: TASKS, gossip: [], map });
    expect(() => auctionStep(st, inp)).not.toThrow();
    const pin = deepFreeze({ me: { id: 'moto-01', kind: 'motorbike' as const, pos: { x: 0, y: 0 } }, now: 10, sites: [{ id: 'clinic-1', pos: { x: 100, y: 0 } }], peers: [], map });
    expect(patrolStep(deepFreeze(emptyPatrol()), pin)).toEqual(patrolStep(emptyPatrol(), pin));
  });
});

// sanity: the radio-range table the relay maths relies on
it('relay maths uses the configured radio ranges', () => {
  expect(RADIO_RANGE.drone).toBeGreaterThan(0);
});
