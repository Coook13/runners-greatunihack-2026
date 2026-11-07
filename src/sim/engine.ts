// The simulator. It owns physical truth (where everything is, what each box really weighs, who is
// alive) and nothing else: every decision is made by the injected agents, which only see AgentView.
// Each tick: apply due events -> build radio topology -> every agent ticks in parallel ->
// apply actions in sorted NodeId order (so async timing never changes the result) -> move -> metrics.
import {
  CATALOGUE, CAPACITY, CELL_SIZE, DRONE_CHARGE_X, DRONE_RANGE_M, DWELL, MEET_OFFSET, RESEND_EVERY, SIZE_UNITS, SPEED,
  TICK_DT, TRANSFER_RADIUS, WORLD_SIZE,
} from '../contracts/config';
import type {
  Action, Agent, AgentSetup, AgentView, Alert, AlertKind, CarriedBox, CreateEngine, EngineApi, Factories,
  Metrics, Mode, Msg, NodeId, NodeKind, NodeState, Receipt, SealedBox, Snapshot, Vec2, WorldEvent,
} from '../contracts/types';
import { buildTopology, RateLimiter, recipients, type Topology, type Zone } from './network';
import { childRng, type Rng } from './rng';
import { DemandGenerator, makeDemand } from './scenario';
import { buildSetups, isCarrier, makeSetup, nearestHub, type SharedKeys } from './setup';
import { cellOf, createWorld, dist, type World } from './map';

type Log = { id: NodeId; t: number; text: string };

interface NodeRec {
  id: NodeId;
  kind: NodeKind;
  pos: Vec2;
  alive: boolean;
  battery: number;
  inv: CarriedBox[];
  path: Vec2[];
  agent: Agent;
  setup: AgentSetup;
  fake: boolean;                     // attack-console intruder
  passive: boolean;                  // intruder with no brain (flood source)
  cellSignal: boolean;
  logs: string[];
  inbox: Msg[];                      // delivered this tick, read next tick
  gps?: { dx: number; dy: number; until: number };  // spoofGps: what this node's GPS claims
  // Display state (NodeState.role/phase/alt/heading). The agent's latest 'status' wins; otherwise derived from motion.
  status?: { role?: string; phase?: NodeState['phase']; alt?: number; t: number };
  heading?: number;                  // radians, 0 = east, counter-clockwise; kept while stopped
  alt: number;                       // derived altitude (drones), metres above ground
  movedLast: number;                 // metres moved last tick
}

interface Loss { kind: 'skim' | 'steal' | 'collude' | 'packShort' | 'raid'; by: NodeId[]; kg: number; t: number }

interface BoxTruth {
  cb: CarriedBox;                    // the same object that sits in a holder's inventory
  realKg: number;
  createdAt: number;
  holder: NodeId | null;
  status: 'transit' | 'delivered' | 'stolen' | 'lost';
  deliveredAt?: number;
  deliveredTo?: NodeId;
  duplicate: boolean;
  losses: Loss[];
  maskKg?: number;                   // collude: carriers' scales are rigged to read this
}

interface Attack { type: WorldEvent['type']; t: number; expects: AlertKind[]; resolved: boolean }

const LOG_KEEP = 200;
const DRONE_CRUISE_ALT = 120;                     // metres: derived altitude when a drone gives no status of its own
const DRONE_CLIMB_RATE = 5;                       // m/s up or down
const HOVER_DRAIN_X = 0.3;                        // hovering drains this fraction of the cruise drain rate
const TRACK_EVERY = DWELL.minSec / 4;             // sample often enough for raiders to see a dwell
const SPOOF_SEC = 2 * RESEND_EVERY;               // how long a spoofed GPS keeps lying
const SPOOF_JUMP = 5000;                          // metres (PLAN 12.3: "position jumps 5 km")
const FLOOD_COUNT = 500;                          // PLAN 12.3: "node spams 500 messages"
const round2 = (x: number) => Math.round(x * 100) / 100;
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** An intruder with no brain: it exists on the radio and does nothing (used as the flood source). */
const passiveAgent = (id: NodeId, kind: NodeKind): Agent => ({
  id, kind,
  async tick() { return []; },
  dump: () => ({ nodeId: id, readableLabels: [], knownLocations: [], knownStockLevels: 0, readableBeneficiaryNotes: [], nextHop: null }),
  receipts: () => [],
});

class Engine implements EngineApi {
  t = 0;
  private nodes = new Map<NodeId, NodeRec>();
  private order: NodeId[] = [];                    // sorted ids: the one true action order
  private boxes = new Map<string, BoxTruth>();
  private queue: WorldEvent[] = [];
  private cellUp = true;
  private zones: Zone[] = [];
  private topo: Topology | null = null;
  private limiter = new RateLimiter();
  private msgSeq = 0;
  private fakeSeq = 0;
  private demandsMade = 0;                         // engine-injected demand events into real clinics (reach denominator)
  private filled = new Set<string>();              // requestIds that got their first box
  private intactFilled = new Set<string>();        // requestIds whose first box arrived intact
  private requestSeen = new Map<string, number>(); // every real request: requestId -> when it was made
  private recentMsgs: { sender: NodeId; msg: Msg }[] = [];
  private alerts: Alert[] = [];
  private newAlerts: Alert[] = [];
  private newLogs: Log[] = [];
  private attacks: Attack[] = [];
  private attacksBlocked = 0;
  private tracks = new Map<NodeId, Vec2[]>();
  private vanSpots: Vec2[] = [];                   // live van positions at the start of this tick's move (drone charging)
  private nextTrackT = 0;
  private pendingShort = new Map<NodeId, number>(); // packShort: store -> kg it will under-pack
  private demandGen: DemandGenerator | null;      // null = clinics generate their own demand (default)
  private rng: Rng;                                 // engine's own stream: events and demand contents

  constructor(
    readonly seed: number, readonly mode: Mode, private factories: Factories,
    private world: World, private shared: SharedKeys, setups: AgentSetup[], autoDemand: boolean,
  ) {
    this.rng = childRng(seed, 'engine');
    for (const s of setups) this.addNode(s, factories[s.kind](s), false, false);
    const clinics = this.order.filter((id) => this.nodes.get(id)!.kind === 'clinic');
    this.demandGen = autoDemand ? new DemandGenerator(childRng(seed, 'scenario'), clinics) : null;
  }

  // ---------------- public API ----------------

  apply(ev: WorldEvent): void {
    this.queue.push({ ...ev });
  }

  async step(): Promise<Snapshot> {
    this.newAlerts = [];
    this.newLogs = [];
    await this.applyDueEvents();
    for (const ev of this.demandGen?.next(this.t, TICK_DT) ?? []) await this.applyEvent(ev);

    const live = this.order.map((id) => this.nodes.get(id)!);
    this.topo = buildTopology(live.map((n) => ({ id: n.id, kind: n.kind, pos: n.pos, alive: n.alive })), { cellUp: this.cellUp, deadZones: this.zones });
    for (const n of live) n.cellSignal = this.topo.signal.get(n.id) === true;

    // Every live agent decides in parallel, from its own view only.
    const ticking = live.filter((n) => n.alive && !n.passive);
    const views = ticking.map((n) => this.viewFor(n));
    for (const n of live) n.inbox = [];
    const results = await Promise.all(ticking.map(async (n, i) => {
      try {
        return await n.agent.tick(views[i]);
      } catch (e) {
        return [{ type: 'log', text: `agent error: ${(e as Error).message}` } as Action];
      }
    }));
    // Apply in sorted id order (ticking is already sorted).
    ticking.forEach((n, i) => {
      for (const a of results[i] ?? []) this.applyAction(n, a);
    });

    this.move();
    this.updateScales();
    this.sampleTracks();
    this.t = round2(this.t + TICK_DT);
    return this.snapshot();
  }

  inspect(id: NodeId) {
    const n = this.nodes.get(id);
    if (!n) return null;
    const dump = n.agent.dump();
    // Mesh: a breached non-van can never show a store location (belt and braces: agents already never record one).
    if (this.mode === 'mesh' && n.kind !== 'van' && n.kind !== 'store') dump.knownLocations = dump.knownLocations.filter((l) => l.what !== 'store');
    return { kind: n.kind, dump, logs: n.logs.slice(-15) };
  }

  ledgerInput() {
    const seen = new Set<string>();
    const receipts: Receipt[] = [];
    const add = (r: Receipt) => {
      const k = `${r.packageId}|${r.seq}|${r.kind}|${r.from}|${r.to}|${r.t}|${r.sigTo}`;
      if (seen.has(k)) return;
      seen.add(k);
      receipts.push(r);
    };
    for (const id of this.order) {
      try { this.nodes.get(id)!.agent.receipts().forEach(add); } catch { /* a broken agent holds nothing readable */ }
    }
    for (const b of [...this.boxes.keys()].sort()) this.boxes.get(b)!.cb.passport.forEach(add);
    const signPubs: Record<NodeId, string> = {};
    for (const id of this.order) signPubs[id] = this.nodes.get(id)!.setup.keys.signPub;
    return {
      receipts,
      dead: this.order.filter((id) => !this.nodes.get(id)!.alive),
      alerts: [...this.alerts],
      signPubs,
    };
  }

  trackHistory(): Record<NodeId, Vec2[]> {
    const out: Record<NodeId, Vec2[]> = {};
    for (const [id, pts] of this.tracks) out[id] = pts.map((p) => ({ ...p }));
    return out;
  }

  auditorSealPriv(): CryptoKey {
    return this.shared.auditor.sealPriv;
  }

  /** Run silently (no snapshot consumers) for `sec` sim seconds. */
  async fastForward(sec: number): Promise<void> {
    const end = this.t + sec;
    while (this.t < end) await this.step();
    this.newAlerts = [];
    this.newLogs = [];
  }

  // ---------------- nodes ----------------

  private addNode(s: AgentSetup, agent: Agent, fake: boolean, passive: boolean, pos?: Vec2): NodeRec {
    const n: NodeRec = {
      id: s.id, kind: s.kind, pos: { ...(pos ?? s.home) }, alive: true, battery: 1, inv: [], path: [],
      agent, setup: s, fake, passive, cellSignal: false, logs: [], inbox: [], alt: 0, movedLast: 0,
    };
    this.nodes.set(s.id, n);
    this.order = [...this.nodes.keys()].sort();
    return n;
  }

  private gpsPos(n: NodeRec): Vec2 {
    if (!n.gps || n.gps.until <= this.t) return { ...n.pos };
    return { x: n.pos.x + n.gps.dx, y: n.pos.y + n.gps.dy };
  }

  private viewFor(n: NodeRec): AgentView {
    // Only vans load at stores, so only a van's radio is told a store is there (PLAN 3.3). Everyone else never
    // gets a store in its neighbour list at all: no id, no position, no distance (stores to stores still see each other).
    const seesStores = n.kind === 'van' || n.kind === 'store';
    const nbs = (this.topo!.neighbours.get(n.id) ?? [])
      .filter((nb) => seesStores || nb.kind !== 'store')
      .map((nb) => ({ ...nb, pos: this.gpsPos(this.nodes.get(nb.id)!) }));
    return {
      self: n.id,
      kind: n.kind,
      t: this.t,
      dt: TICK_DT,
      pos: this.gpsPos(n),
      battery: n.battery,
      // Copies: an agent can't edit physical truth by mutating its view.
      inventory: n.inv.map((cb) => ({ box: cb.box, measuredKg: cb.measuredKg, passport: [...cb.passport] })),
      inbox: n.inbox,
      neighbours: nbs,
      cellSignal: n.cellSignal,
      mode: this.mode,
      map: this.world.map,
    };
  }

  private log(id: NodeId, text: string) {
    const n = this.nodes.get(id);
    if (n) {
      n.logs.push(`[${Math.floor(this.t)}s] ${text}`);
      if (n.logs.length > LOG_KEEP) n.logs.splice(0, n.logs.length - LOG_KEEP);
    }
    this.newLogs.push({ id, t: this.t, text });
  }

  private carried(n: NodeRec, packageId: string): number {
    return n.inv.findIndex((cb) => cb.box.label.packageId === packageId);
  }

  private hasRoom(n: NodeRec, box: SealedBox): boolean {
    if (!isCarrier(n.kind)) return true;
    const used = n.inv.reduce((s, cb) => s + SIZE_UNITS[cb.box.label.size], 0);
    return used + SIZE_UNITS[box.label.size] <= CAPACITY[n.kind];
  }

  // ---------------- actions ----------------

  private applyAction(n: NodeRec, a: Action) {
    switch (a.type) {
      case 'moveTo':
        if (isCarrier(n.kind)) n.path = a.path.map((p) => ({ x: p.x, y: p.y }));
        break;
      case 'stop':
        n.path = [];
        break;
      case 'send':
        this.send(n, { ...a.msg, id: `${n.id}:${++this.msgSeq}`, t: this.t, hops: 0 } as Msg);
        break;
      case 'transfer':
        this.transfer(n, a.packageId, a.to);
        break;
      case 'stamp': {
        const i = this.carried(n, a.packageId);
        if (i < 0 || a.receipt.packageId !== a.packageId) this.log(n.id, `stamp ignored: not holding ${a.packageId}`);
        else n.inv[i].passport.push({ ...a.receipt });
        break;
      }
      case 'spawnBox':
        this.spawnBox(n, a.box, a.kg);
        break;
      case 'consume':
        this.consume(n, a.packageId);
        break;
      case 'alert':
        this.raise({ ...a.alert, reportedBy: n.id, t: this.t });
        break;
      case 'log':
        this.log(n.id, a.text);
        break;
      case 'status': {
        // Display only (role / flight phase / altitude for the renderer); never changes physics.
        const phases: NonNullable<NodeState['phase']>[] = ['idle', 'takeoff', 'cruise', 'landing', 'handoff', 'charging', 'relay'];
        n.status = {
          role: typeof a.role === 'string' ? a.role.slice(0, 24) : undefined,
          phase: a.phase && phases.includes(a.phase) ? a.phase : undefined,
          alt: typeof a.alt === 'number' && Number.isFinite(a.alt) ? Math.max(0, Math.min(500, a.alt)) : undefined,
          t: this.t,
        };
        break;
      }
    }
  }

  /** Route a message over radio / cell this tick. Receivers read it on their next tick. */
  private send(n: NodeRec, msg: Msg) {
    const topo = this.topo!;
    let radioOnly = false;
    if (msg.kind !== 'beacon') {
      const rl = this.limiter.check(n.id, this.t);
      radioOnly = rl !== 'ok';
      if (rl === 'first-limited')
        this.raise({ t: this.t, kind: 'rate-limited', reportedBy: 'network', suspect: n.id, cell: cellOf(n.pos),
          text: `Rate-limited ${n.id}: over the message limit, no longer forwarded. Urgent deliveries unaffected.` });
      this.sniff(n, msg);
    }
    // One copy per hop count, shared by every receiver at that distance (agents never edit their inbox).
    const copies = new Map<number, Msg>();
    for (const r of recipients(topo, n.id, msg.to, radioOnly)) {
      let c = copies.get(r.hops);
      if (!c) copies.set(r.hops, (c = { ...msg, hops: r.hops }));
      this.nodes.get(r.id)!.inbox.push(c);
    }
  }

  /**
   * The engine overhears what real clinics send, to learn every request they make (the reach denominator)
   * and when it was made. It also keeps a few recent messages for the replay and tamper attacks.
   */
  private sniff(sender: NodeRec, msg: Msg) {
    if (sender.kind === 'clinic' && !sender.fake)
      for (const r of findRequests(msg.body))
        if (!this.requestSeen.has(r.requestId)) this.requestSeen.set(r.requestId, r.createdAt ?? this.t);
    if (!sender.fake) {
      this.recentMsgs.push({ sender: sender.id, msg });
      if (this.recentMsgs.length > 200) this.recentMsgs.shift();
    }
  }

  private transfer(giver: NodeRec, packageId: string, to: NodeId) {
    const i = this.carried(giver, packageId);
    const recv = this.nodes.get(to);
    if (i < 0) return this.log(giver.id, `transfer refused: not holding ${packageId}`);
    if (!recv || !recv.alive) return this.log(giver.id, `transfer of ${packageId} failed: ${to} not reachable`);
    const d = dist(giver.pos, recv.pos);
    if (d > TRANSFER_RADIUS) return this.log(giver.id, `transfer of ${packageId} to ${to} failed: ${Math.round(d)} m apart (needs ${TRANSFER_RADIUS} m)`);
    const cb = giver.inv[i];
    if (!this.hasRoom(recv, cb.box)) return this.log(giver.id, `transfer of ${packageId} to ${to} failed: no room`);
    giver.inv.splice(i, 1);
    recv.inv.push(cb);                               // the passport travels with the box
    const truth = this.boxes.get(packageId);
    if (truth) {
      truth.holder = recv.id;
      // Everyone who holds a box with rigged scales after a collusion is part of the stretch that hid it.
      for (const l of truth.losses) if (l.kind === 'collude' && isCarrier(recv.kind)) l.by.push(recv.id);
    }
  }

  private spawnBox(n: NodeRec, box: SealedBox, kg: number) {
    if (n.kind !== 'store') return this.log(n.id, 'spawnBox refused: only stores pack boxes');
    const id = box.label.packageId;
    if (this.boxes.has(id)) return this.log(n.id, `spawnBox refused: ${id} already exists`);
    const short = Math.min(this.pendingShort.get(n.id) ?? 0, kg);
    this.pendingShort.delete(n.id);
    const realKg = round2(kg - short);
    const cb: CarriedBox = { box, measuredKg: realKg, passport: [] };
    const truth: BoxTruth = { cb, realKg, createdAt: this.t, holder: n.id, status: 'transit', duplicate: false, losses: [] };
    if (short > 0) {
      truth.losses.push({ kind: 'packShort', by: [n.id], kg: round2(short), t: this.t });
      this.attackLine(`Packed short: ${id} left ${n.id} ${round2(short)} kg under its manifest`);
    }
    this.boxes.set(id, truth);
    if (!this.requestSeen.has(box.label.requestId)) this.requestSeen.set(box.label.requestId, this.t);
    n.inv.push(cb);
  }

  private consume(n: NodeRec, packageId: string) {
    const i = this.carried(n, packageId);
    if (n.kind !== 'clinic' || i < 0) return this.log(n.id, `consume refused: not a clinic holding ${packageId}`);
    n.inv.splice(i, 1);
    const truth = this.boxes.get(packageId);
    if (!truth) return;
    truth.holder = null;
    if (n.fake) {
      // A ghost clinic "receiving" food is theft.
      truth.status = 'stolen';
      truth.losses.push({ kind: 'steal', by: [n.id], kg: truth.realKg, t: this.t });
      return;
    }
    truth.status = 'delivered';
    truth.deliveredAt = this.t;
    truth.deliveredTo = n.id;
    const rq = truth.cb.box.label.requestId;
    if (this.filled.has(rq)) truth.duplicate = true;
    else {
      this.filled.add(rq);
      if (truth.losses.length === 0) this.intactFilled.add(rq);
    }
  }

  private raise(al: Alert) {
    this.alerts.push(al);
    this.newAlerts.push(al);
    for (const at of this.attacks) {
      if (at.resolved || al.t < at.t || !at.expects.includes(al.kind)) continue;
      at.resolved = true;
      this.attacksBlocked++;
      this.attackLine(`Blocked (${at.type}): ${al.text}`);
      break;
    }
  }

  private attackLine(text: string) {
    this.newLogs.push({ id: 'attack-console', t: this.t, text });
  }

  // ---------------- physics ----------------

  private move() {
    this.vanSpots = this.order.map((id) => this.nodes.get(id)!).filter((v) => v.kind === 'van' && v.alive).map((v) => v.pos);
    for (const id of this.order) {
      const n = this.nodes.get(id)!;
      if (!n.alive || !isCarrier(n.kind)) continue;
      this.prevPos.set(id, n.pos);
      let budget = n.kind === 'drone' && n.battery <= 0 ? 0 : SPEED[n.kind] * TICK_DT;
      let moved = 0;
      while (budget > 0 && n.path.length) {
        const tgt = n.path[0];
        const d = dist(n.pos, tgt);
        if (d <= budget) {
          n.pos = { x: tgt.x, y: tgt.y };
          budget -= d;
          moved += d;
          n.path.shift();
        } else {
          n.pos = { x: n.pos.x + ((tgt.x - n.pos.x) * budget) / d, y: n.pos.y + ((tgt.y - n.pos.y) * budget) / d };
          moved += budget;
          budget = 0;
        }
      }
      const before = this.prevPos.get(n.id) ?? n.pos;
      n.pos = { x: Math.max(0, Math.min(WORLD_SIZE, n.pos.x)), y: Math.max(0, Math.min(WORLD_SIZE, n.pos.y)) };
      if (moved > 0.1) n.heading = Math.atan2(n.pos.y - before.y, n.pos.x - before.x);
      n.movedLast = moved;
      if (n.kind === 'drone') {
        this.battery(n, moved);
        // Derived altitude: climb to cruise when flying, descend when parked (a relay holds its hover height).
        const target = moved > 0.1 ? DRONE_CRUISE_ALT : n.status?.phase === 'relay' ? (n.status.alt ?? DRONE_CRUISE_ALT) : 0;
        const step = DRONE_CLIMB_RATE * TICK_DT;
        n.alt = Math.abs(target - n.alt) <= step ? target : n.alt + Math.sign(target - n.alt) * step;
      }
    }
  }

  private prevPos = new Map<NodeId, Vec2>();

  /** Drones drain with distance; parked near a van or at a hub (where vans park) they recharge DRONE_CHARGE_X times faster. */
  private battery(n: NodeRec, moved: number) {
    n.battery = Math.max(0, n.battery - moved / DRONE_RANGE_M);
    if (moved > 1) return;
    // Hovering on a relay post costs power too (a fraction of cruise), so relays eventually go home to charge.
    if (n.status?.phase === 'relay' && this.t - n.status.t <= 2) n.battery = Math.max(0, n.battery - (HOVER_DRAIN_X * SPEED.drone * TICK_DT) / DRONE_RANGE_M);
    const nearVan = this.vanSpots.some((p) => dist(p, n.pos) <= MEET_OFFSET[0]);
    const atHub = this.world.hubs.some((h) => dist(h.pos, n.pos) <= MEET_OFFSET[1]);
    if (nearVan || atHub) n.battery = Math.min(1, n.battery + (DRONE_CHARGE_X * SPEED.drone * TICK_DT) / DRONE_RANGE_M);
  }

  /** Each holder's scale reads the box's real weight (unless colluders rigged the carriers' scales). */
  private updateScales() {
    for (const id of this.order) {
      const n = this.nodes.get(id)!;
      for (const cb of n.inv) {
        const truth = this.boxes.get(cb.box.label.packageId);
        if (!truth) continue;
        cb.measuredKg = round2(truth.maskKg !== undefined && isCarrier(n.kind) ? truth.maskKg : truth.realKg);
      }
    }
  }

  private sampleTracks() {
    if (this.t < this.nextTrackT) return;
    this.nextTrackT = this.t + TRACK_EVERY;
    for (const id of this.order) {
      const n = this.nodes.get(id)!;
      if (!isCarrier(n.kind)) continue;
      let tr = this.tracks.get(id);
      if (!tr) this.tracks.set(id, (tr = []));
      tr.push({ ...n.pos });
    }
  }

  // ---------------- events ----------------

  private async applyDueEvents() {
    const due = this.queue.filter((e) => e.t === undefined || e.t <= this.t);
    this.queue = this.queue.filter((e) => !(e.t === undefined || e.t <= this.t));
    for (const ev of due) await this.applyEvent(ev);
  }

  private nodesOf(pred: (n: NodeRec) => boolean): NodeRec[] {
    return this.order.map((id) => this.nodes.get(id)!).filter(pred);
  }

  /** The event's target, or the matching node nearest its pos. */
  private targetOf(ev: WorldEvent, pred: (n: NodeRec) => boolean): NodeRec | null {
    if (ev.target) {
      const n = this.nodes.get(ev.target);
      return n && pred(n) ? n : null;
    }
    const pool = this.nodesOf(pred);
    if (!pool.length) return null;
    if (!ev.pos) return pool[Math.floor(this.rng() * pool.length)];
    return pool.reduce((b, n) => (dist(n.pos, ev.pos!) < dist(b.pos, ev.pos!) ? n : b));
  }

  private injectDemand(clinic: NodeRec) {
    const body = makeDemand(this.rng, clinic.id);
    clinic.inbox.push({ id: `scenario:${++this.msgSeq}`, from: 'scenario', to: clinic.id, kind: 'order', body, hops: 0, t: this.t });
  }

  private async applyEvent(ev: WorldEvent) {
    const real = (n: NodeRec) => !n.fake;
    const liveCarrier = (n: NodeRec) => n.alive && isCarrier(n.kind) && !n.fake;
    const holding = (n: NodeRec) => liveCarrier(n) && n.inv.length > 0;
    switch (ev.type) {
      case 'demand': {
        const c = this.targetOf(ev, (n) => n.kind === 'clinic' && real(n));
        if (!c) return;
        this.injectDemand(c);
        this.demandsMade++;
        return;
      }
      case 'networkDown':
        this.cellUp = false;
        return this.log('world', 'NETWORK DOWN: every cell tower is off');
      case 'networkUp':
        this.cellUp = true;
        return this.log('world', 'NETWORK UP: cell towers back');
      case 'deadZone':
        if (!ev.pos) return;
        this.zones.push({ pos: { ...ev.pos }, radius: ev.radius ?? CELL_SIZE });
        return this.log('world', `Dead zone over ${cellOf(ev.pos)}: local radio is dead inside`);
      case 'clearZone':
        this.zones = ev.pos ? this.zones.filter((z) => dist(z.pos, ev.pos!) > z.radius) : [];
        return this.log('world', 'Dead zone cleared');
      case 'breakdown': {
        const n = this.targetOf(ev, liveCarrier);
        if (!n) return;
        n.alive = false;
        n.path = [];
        for (const cb of n.inv) {
          const t = this.boxes.get(cb.box.label.packageId);
          if (t && t.status === 'transit') t.status = 'lost';
        }
        return this.log('world', `${n.id} broke down in ${cellOf(n.pos)} with ${n.inv.length} box(es)`);
      }
      case 'skim':
      case 'collude': {
        const n = this.targetOf(ev, holding);
        const cb = n?.inv.find((c) => (this.boxes.get(c.box.label.packageId)?.realKg ?? 0) > 0);
        if (!n || !cb) return this.log('world', `${ev.type}: no loaded carrier to target`);
        const truth = this.boxes.get(cb.box.label.packageId)!;
        const kg = round2(Math.min(ev.kg ?? truth.realKg / 2, truth.realKg));
        if (ev.type === 'collude') {
          truth.maskKg = truth.maskKg ?? truth.realKg;       // rigged scales keep showing the old weight
          this.attacks.push({ type: ev.type, t: this.t, expects: ['short-delivery'], resolved: false });
          this.attackLine(`Collusion: ${n.id} and the next carriers fake the weight of ${cb.box.label.packageId}`);
        }
        truth.realKg = round2(truth.realKg - kg);
        truth.losses.push({ kind: ev.type, by: [n.id], kg, t: this.t });
        return this.log('world', `THIEF: ${kg} kg taken from ${cb.box.label.packageId} while held by ${n.id} in ${cellOf(n.pos)}`);
      }
      case 'steal': {
        const n = this.targetOf(ev, holding);
        if (!n) return;
        const cb = n.inv.shift()!;
        const truth = this.boxes.get(cb.box.label.packageId);
        if (truth) {
          truth.status = 'stolen';
          truth.holder = null;
          truth.losses.push({ kind: 'steal', by: [n.id], kg: truth.realKg, t: this.t });
        }
        return this.log('world', `THIEF: box ${cb.box.label.packageId} stolen from ${n.id} in ${cellOf(n.pos)}`);
      }
      case 'breach': {
        const n = this.targetOf(ev, () => true);
        if (n) this.log('world', `HACKER: breached ${n.id} (inspect it to see the dump)`);
        return;
      }
      case 'raid': {
        // A raid hits only if the guess lands on a real store (PLAN 3.8).
        const stores = this.nodesOf((n) => n.kind === 'store');
        const s = ev.target ? stores.find((x) => x.id === ev.target)
          : ev.pos ? stores.find((x) => dist(x.pos, ev.pos!) <= DWELL.guessHitRadius) : undefined;
        if (!s) return this.log('world', 'RAID missed: no store at the guessed spot');
        for (const cb of s.inv) {
          const truth = this.boxes.get(cb.box.label.packageId);
          if (!truth) continue;
          truth.status = 'stolen';
          truth.holder = null;
          truth.losses.push({ kind: 'raid', by: ['raiders'], kg: truth.realKg, t: this.t });
        }
        const lost = s.inv.length;
        s.inv = [];
        return this.log('world', `RAID on ${s.id}: ${lost} packed box(es) taken`);
      }
      default:
        return this.applyAttack(ev);
    }
  }

  // ---------------- attack console (P1) ----------------

  private async spawnIntruder(kind: NodeKind, near: Vec2, like?: NodeRec, passive = false): Promise<NodeRec> {
    const id = `${kind === 'clinic' ? 'ghost-clinic' : passive ? 'intruder' : 'fake'}-${String(++this.fakeSeq).padStart(2, '0')}`;
    const home = { x: Math.min(WORLD_SIZE, near.x + 10), y: near.y };
    const setup = await makeSetup(this.seed, {
      id, kind, home,
      hubId: like?.setup.hubId ?? (isCarrier(kind) ? nearestHub(this.world, near) : undefined),
      patrol: like?.setup.patrol,
    }, this.shared, [], false);
    const agent = passive ? passiveAgent(id, kind) : this.factories[kind](setup);
    return this.addNode(setup, agent, true, passive);
  }

  private async applyAttack(ev: WorldEvent) {
    const expect = (kinds: AlertKind[]) => this.attacks.push({ type: ev.type, t: this.t, expects: kinds, resolved: false });
    const loaded = (n: NodeRec) => n.alive && isCarrier(n.kind) && !n.fake && n.inv.length > 0;
    const carrier = (n: NodeRec) => n.alive && isCarrier(n.kind) && !n.fake;
    switch (ev.type) {
      case 'fakeCarrier': {
        const like = this.targetOf(ev, loaded) ?? this.targetOf(ev, carrier);
        const near = ev.pos ?? like?.pos;
        if (!near) return;
        const f = await this.spawnIntruder('motorbike', near, like ?? undefined);
        expect(['no-cert']);
        return this.attackLine(`Fake carrier ${f.id} (no certificate) appears next to ${like?.id ?? cellOf(near)}`);
      }
      case 'fakeClinic': {
        const v = this.world.villages[Math.floor(this.rng() * this.world.villages.length)];
        const near = ev.pos ?? { x: v.pos.x + 1500, y: v.pos.y + 1500 };
        const g = await this.spawnIntruder('clinic', near);
        this.injectDemand(g);                       // the ghost asks for food (not counted as real demand)
        expect(['no-cert']);
        return this.attackLine(`Ghost clinic ${g.id} (no certificate) sends a request`);
      }
      case 'replay': {
        const old = [...this.recentMsgs].reverse().find((m) => m.msg.kind === 'request') ?? this.recentMsgs[this.recentMsgs.length - 1];
        if (!old) return this.attackLine('Replay: nothing recorded yet to replay');
        this.redeliver(old.sender, ev.target ?? old.sender, old.msg);
        expect(['replay']);
        return this.attackLine(`Replay: an old ${old.msg.kind} from ${old.msg.from} is re-sent`);
      }
      case 'tamper': {
        const pool = this.recentMsgs.filter((m) => m.msg.kind !== 'beacon' && (!ev.target || m.sender === ev.target));
        const old = pool[pool.length - 1];
        if (!old) return this.attackLine('Tamper: no message in flight to tamper with');
        const msg = structuredClone(old.msg) as Msg;
        flipOneByte(msg);
        this.redeliver(old.sender, old.sender, msg);
        expect(['bad-signature']);
        return this.attackLine(`Tamper: one byte flipped in a ${msg.kind} from ${msg.from}`);
      }
      case 'flood': {
        const near = ev.pos ?? this.targetOf(ev, carrier)?.pos;
        if (!near) return;
        const f = await this.spawnIntruder('motorbike', near, undefined, true);
        // The intruder needs a radio topology that includes it before it can transmit.
        const live = this.order.map((id) => this.nodes.get(id)!);
        this.topo = buildTopology(live.map((n) => ({ id: n.id, kind: n.kind, pos: n.pos, alive: n.alive })), { cellUp: this.cellUp, deadZones: this.zones });
        expect(['rate-limited']);
        this.attackLine(`Flood: ${f.id} spams ${FLOOD_COUNT} messages`);
        for (let i = 0; i < FLOOD_COUNT; i++)
          this.send(f, { id: `${f.id}:${++this.msgSeq}`, from: f.id, to: '*', kind: 'request', body: { junk: i }, hops: 0, t: this.t });
        return;
      }
      case 'spoofGps': {
        const n = this.targetOf(ev, carrier);
        if (!n) return;
        const dx = n.pos.x + SPOOF_JUMP <= WORLD_SIZE ? SPOOF_JUMP : -SPOOF_JUMP;
        n.gps = { dx, dy: 0, until: this.t + SPOOF_SEC };
        expect(['position-jump']);
        return this.attackLine(`Spoofed GPS: ${n.id} now claims to be ${SPOOF_JUMP / 1000} km away`);
      }
      case 'packShort': {
        const s = this.targetOf(ev, (n) => n.kind === 'store');
        if (!s) return;
        this.pendingShort.set(s.id, ev.kg ?? CATALOGUE['RUTF-30'].kg);
        expect(['short-delivery']);
        return this.attackLine(`Pack short: ${s.id} will under-pack its next box`);
      }
      case 'stealKey': {
        const n = this.targetOf(ev, carrier);
        if (!n) return;
        const exp = n.setup.cert?.expires;
        return this.attackLine(`Key stolen from ${n.id}: it works until its cert expires${exp !== undefined ? ` at t=${exp}s` : ''}; boxes stay unreadable (carriers hold no box key)`);
      }
      case 'coerce':
        return this.attackLine('Coerce: not built (P2)');
      default:
        return;
    }
  }

  /** Put a copy of an old message back on the air from `origin`'s position, to its original audience. */
  private redeliver(origin: NodeId, at: NodeId, msg: Msg) {
    if (!this.topo) return;
    const from = this.nodes.has(at) ? at : origin;
    for (const r of recipients(this.topo, from, msg.to)) this.nodes.get(r.id)!.inbox.push({ ...msg, hops: r.hops });
  }

  // ---------------- metrics and snapshot ----------------

  metrics(): Metrics {
    const m: Metrics = {
      t: this.t, requestsOpen: 0, boxesTotal: this.boxes.size, deliveredIntact: 0, deliveredShort: 0, skimmed: 0,
      stolen: 0, lostBreakdown: 0, inTransit: 0, duplicates: 0, leaksPinpointed: 0, attacksBlocked: this.attacksBlocked,
      reachPct: 0, meanDeliverySec: 0, carriersAlive: 0, carriersTotal: 0,
    };
    const alertsByBox = new Map<string, Set<NodeId>>();
    for (const a of this.alerts) {
      if (!a.packageId || !a.suspect) continue;
      if (!alertsByBox.has(a.packageId)) alertsByBox.set(a.packageId, new Set());
      alertsByBox.get(a.packageId)!.add(a.suspect);
    }
    let delivSum = 0, delivN = 0;
    for (const [id, b] of this.boxes) {
      const skimmed = b.losses.some((l) => l.kind === 'skim');
      if (b.duplicate) m.duplicates++;
      else if (b.status === 'lost') m.lostBreakdown++;
      else if (b.status === 'stolen') m.stolen++;
      else if (skimmed) m.skimmed++;
      else if (b.status === 'delivered') b.losses.length ? m.deliveredShort++ : m.deliveredIntact++;
      else m.inTransit++;
      if (b.losses.length) {
        const named = alertsByBox.get(id);
        if (named && b.losses.some((l) => l.by.some((x) => named.has(x)))) m.leaksPinpointed++;
      }
      if (b.status === 'delivered' && !b.duplicate) {
        delivSum += b.deliveredAt! - (this.requestSeen.get(b.cb.box.label.requestId) ?? b.createdAt);
        delivN++;
      }
    }
    // Requests made = demand the engine injected into real clinics (exact, and counted even when a clinic's
    // request never gets out, e.g. a central clinic with no signal). Falls back to overheard requests.
    const made = Math.max(this.demandsMade || this.requestSeen.size, this.filled.size);
    m.requestsOpen = Math.max(0, made - this.filled.size);
    m.reachPct = made ? Math.min(100, round2((100 * this.intactFilled.size) / made)) : 0;
    m.meanDeliverySec = delivN ? Math.round(delivSum / delivN) : 0;
    for (const n of this.nodes.values())
      if (isCarrier(n.kind) && !n.fake) {
        m.carriersTotal++;
        if (n.alive) m.carriersAlive++;
      }
    return m;
  }

  private snapshot(): Snapshot {
    const nodes: NodeState[] = this.order.map((id) => {
      const n = this.nodes.get(id)!;
      const st = n.status;
      const flying = n.kind === 'drone';
      const phase: NodeState['phase'] | undefined = st?.phase ?? (flying
        ? (n.movedLast > 0.1 ? (n.alt < DRONE_CRUISE_ALT - 20 ? 'takeoff' : 'cruise') : n.alt > 1 ? 'landing' : 'idle')
        : undefined);
      return {
        id, kind: n.kind, pos: { ...n.pos }, alive: n.alive, boxes: n.inv.map((cb) => cb.box.label.packageId),
        battery: n.battery, cellSignal: n.cellSignal, ...(n.fake ? { fake: true } : {}),
        ...(n.heading !== undefined ? { heading: n.heading } : {}),
        ...(flying ? { alt: Math.round((st?.alt ?? n.alt) * 10) / 10 } : {}),
        ...(phase ? { phase } : {}),
        ...(st?.role ? { role: st.role } : {}),
      };
    });
    return {
      t: this.t,
      mode: this.mode,
      nodes,
      links: this.topo ? this.topo.links.map(([a, b]) => [a, b] as [NodeId, NodeId]) : [],
      cellNetworkUp: this.cellUp,
      deadZones: this.zones.map((z) => ({ pos: { ...z.pos }, radius: z.radius })),
      hubs: this.world.map.hubs(),
      metrics: this.metrics(),
      newAlerts: this.newAlerts,
      newLogs: this.newLogs,
    };
  }
}

/** Every { requestId, createdAt? } inside a message body (bare envelope, { envelope }, arrays, { reqs: [...] }). */
function findRequests(body: unknown, depth = 0): { requestId: string; createdAt?: number }[] {
  if (!body || typeof body !== 'object' || depth > 3) return [];
  if (Array.isArray(body)) return body.flatMap((x) => findRequests(x, depth + 1));
  const o = body as Record<string, unknown>;
  if (typeof o.requestId === 'string') return [{ requestId: o.requestId, createdAt: typeof o.createdAt === 'number' ? o.createdAt : undefined }];
  return Object.values(o).flatMap((x) => findRequests(x, depth + 1));
}

/** Tamper: change one character of the first readable field, keeping every signature as it was. */
function flipOneByte(msg: Msg) {
  const flip = (s: string) => s.slice(0, -1) + (s.endsWith('X') ? 'Y' : 'X');
  const b = msg.body;
  if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => typeof o[k] === 'string' && !/sig/i.test(k)).sort();
    const k = ['destCell', 'requestId', 'packageId'].find((x) => keys.includes(x)) ?? keys[0];
    if (k) { o[k] = flip(o[k] as string); return; }
  }
  msg.body = { tampered: true, was: b };
}

/** Build an engine: make every node's keys and setup, create agents from the injected factories, optionally fast-forward. */
export const createEngine: CreateEngine = (opts) => createEngineWith(opts);

/**
 * Same as createEngine, plus `autoDemand`: true (default) = the engine's seeded generator (scenario.ts) is the one
 * owner of demand and injects it into clinics as 'order' messages, so mesh and central get identical demand for a seed.
 */
export async function createEngineWith(
  { seed, mode, factories, warmupSec, autoDemand = true }: Parameters<CreateEngine>[0] & { autoDemand?: boolean },
): Promise<EngineApi> {
  const world = createWorld();
  const { setups, ...shared } = await buildSetups(seed, mode, world);
  const e = new Engine(seed, mode, factories, world, shared, setups, autoDemand);
  if (warmupSec && warmupSec > 0) await e.fastForward(warmupSec);
  return e;
}
