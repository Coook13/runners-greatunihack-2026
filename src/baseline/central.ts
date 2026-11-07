// Central baseline (PLAN 3.7 + 13 #17): the "normal" way to run deliveries, for a fair side-by-side.
// One dispatch server sees everything over the cell network and gives orders. Every device carries the
// full common picture (stores, stock, clinics, open requests with their beneficiary notes), so breaching
// any one of them leaks it all. Boxes go store -> clinic direct, one carrier, no relays, no hand-off weights.
// When the cell network is down, nothing new can be ordered: carriers finish their current order, then hold.
import type {
  Agent, AgentSetup, Factories, AgentView, Action, BreachDump, CarrierKind, Label, Manifest,
  Msg, NodeId, Receipt, SealedBox, SizeClass, Urgency, Vec2,
} from '../contracts/types';
import {
  CAPACITY, CATALOGUE, CELL_COVERAGE, DRONE_RANGE_M, COUNTS, DEMAND, RESEND_EVERY, SIZE_FOR_KG, SIZE_UNITS,
  TRANSFER_RADIUS, WEIGHT_TOLERANCE_KG,
} from '../contracts/config';
import { seal, open, sign } from '../privacy/core';

// PLAN 3.7 says dispatch assigns "every 5 s". Not in config.ts yet (contract change requested).
export const DISPATCH_EVERY_SEC = 5;

// PLAN 3.7 / lead brief: clinics reach dispatch only over the cell network. Most villages have no
// signal, so central serves few of them. Set true to let a visiting carrier upload a clinic's queued
// requests when it next has signal (a fairer, more generous baseline).
export const CARRIER_UPLINK = false;

// Central drones recharge at a hub when idle below this battery level (engine: hubs and parked vans charge drones).
const DRONE_RECHARGE_BELOW = 0.6;

// ---------- the common picture every central device holds ----------
export interface CentralRequest {
  requestId: string;
  attempt: number;
  urgency: Urgency;
  size: SizeClass;
  cold: boolean;
  destCell: string;
  deadline: number;
  clinicId: NodeId;
  clinicPos: Vec2;
  replyPub: string;
  manifest: Manifest;       // central mode: dispatch reads manifests in the clear
}

export interface Picture {
  stores: Record<NodeId, { pos: Vec2; onShelf: number; packed: number; t: number }>;
  clinics: Record<NodeId, Vec2>;
  requests: Record<string, CentralRequest>;   // key requestId:attempt, open ones only
  notes: string[];                             // every beneficiary note seen
}

const emptyPicture = (): Picture => ({ stores: {}, clinics: {}, requests: {}, notes: [] });

// Merge another picture into mine (newest stock report wins, notes are a union).
function mergePicture(mine: Picture, other: Picture): void {
  for (const [id, s] of Object.entries(other.stores)) if (!mine.stores[id] || mine.stores[id].t <= s.t) mine.stores[id] = s;
  Object.assign(mine.clinics, other.clinics);
  mine.requests = { ...other.requests };   // dispatch's list of open requests is the truth
  for (const n of other.notes) if (!mine.notes.includes(n)) mine.notes.push(n);
}

function pictureDump(id: NodeId, p: Picture, labels: Label[], nextHop: NodeId | null): BreachDump {
  return {
    nodeId: id,
    readableLabels: labels,
    knownLocations: [
      ...Object.values(p.stores).map((s) => ({ what: 'store' as const, pos: s.pos })),
      ...Object.values(p.clinics).map((pos) => ({ what: 'clinic' as const, pos })),
    ],
    knownStockLevels: Object.keys(p.stores).length,
    readableBeneficiaryNotes: [...p.notes],
    nextHop,
  };
}

// ---------- message bodies (all carried as msg kind 'order', 'request' or 'beacon') ----------
type OrderBody =
  | { type: 'picture'; picture: Picture }
  | { type: 'pack'; packageId: string; carrier: NodeId; req: CentralRequest; picture: Picture }
  | { type: 'carry'; packageId: string; store: NodeId; storePos: Vec2; req: CentralRequest; picture: Picture }
  | { type: 'stock'; pos: Vec2; onShelf: number; packed: number }
  | { type: 'delivered'; requestId: string; attempt: number; packageId: string; by: NodeId; shortKg: number }
  | { type: 'requests'; reqs: CentralRequest[] };   // CARRIER_UPLINK only

interface CarrierStatus { kind: CarrierKind; pos: Vec2; busy: string | null; spare: number; battery?: number }

const isOrder = (m: Msg): m is Msg & { body: OrderBody } => m.kind === 'order' && !!m.body && typeof m.body === 'object';
const send = (from: NodeId, to: NodeId | '*', kind: Msg['kind'], body: unknown): Action =>
  ({ type: 'send', msg: { from, to, kind, body } });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const reqKey = (r: { requestId: string; attempt: number }) => `${r.requestId}:${r.attempt}`;

// Receipt signed by the receiver over every field except the signatures (PLAN 13 #1).
async function signedReceipt(r: Omit<Receipt, 'sigTo'>, setup: AgentSetup): Promise<Receipt> {
  return { ...r, sigTo: await sign(r, setup.keys.signPriv) };
}

// ---------- dispatch: the server ----------
function dispatchAgent(s: AgentSetup): Agent {
  const picture = emptyPicture();
  const carriers = new Map<NodeId, CarrierStatus & { seen: number }>();
  const assigned = new Map<string, { packageId: string; carrier: NodeId; store: NodeId; at: number }>();
  const filled = new Set<string>();   // requestIds already delivered
  const packedFor = new Map<string, { packageId: string; store: NodeId }>();   // request key -> box already packed for it
  let nextPkg = 1;
  let lastRun = -Infinity;

  return {
    id: s.id, kind: s.kind,
    async tick(v: AgentView): Promise<Action[]> {
      const out: Action[] = [];
      for (const m of v.inbox) {
        if (m.kind === 'beacon') carriers.set(m.from, { ...(m.body as CarrierStatus), seen: v.t });
        if (m.kind === 'request') addRequest(m.body as CentralRequest);
        if (!isOrder(m)) continue;
        const b = m.body;
        if (b.type === 'stock') picture.stores[m.from] = { pos: b.pos, onShelf: b.onShelf, packed: b.packed, t: v.t };
        if (b.type === 'requests') b.reqs.forEach(addRequest);
        if (b.type === 'delivered') {
          filled.add(b.requestId);
          for (const k of Object.keys(picture.requests)) if (picture.requests[k].requestId === b.requestId) { delete picture.requests[k]; assigned.delete(k); }
        }
      }
      if (!v.cellSignal || v.t - lastRun < DISPATCH_EVERY_SEC) return out;
      lastRun = v.t;

      // Free a job whose carrier went back to idle without ever taking it (missed the order).
      for (const [k, a] of assigned) {
        const c = carriers.get(a.carrier);
        if (c && c.busy === null && c.seen > a.at + 2 * DISPATCH_EVERY_SEC) assigned.delete(k);
      }

      // Greedy: most urgent, earliest deadline first; pick the carrier + store with the lowest total ETA.
      const open = Object.entries(picture.requests).filter(([k]) => !assigned.has(k))
        .sort(([, a], [, b]) => (b.urgency - a.urgency) || (a.deadline - b.deadline));
      const busyNow = new Set([...assigned.values()].map((a) => a.carrier));
      for (const [k, r] of open) {
        let best: { c: NodeId; st: NodeId; eta: number } | null = null;
        for (const [cid, c] of carriers) {
          if (c.busy !== null || busyNow.has(cid) || v.t - c.seen > 2 * DISPATCH_EVERY_SEC) continue;
          if (c.spare < SIZE_UNITS[r.size]) continue;
          for (const [sid, st] of Object.entries(picture.stores)) {
            // A box already packed for this request stays at its store: only that store can serve it.
            if (packedFor.has(k) && packedFor.get(k)!.store !== sid) continue;
            const eta = v.map.eta(c.kind, c.pos, st.pos) + v.map.eta(c.kind, st.pos, r.clinicPos);
            // A drone only gets the job if its battery covers the whole trip plus the flight to a charger.
            if (c.kind === 'drone') {
              const legs = dist(c.pos, st.pos) + dist(st.pos, r.clinicPos) + Math.min(...v.map.hubs().map((h) => dist(r.clinicPos, h.pos)));
              if (legs * 1.1 > (c.battery ?? 1) * DRONE_RANGE_M) continue;
            }
            if (Number.isFinite(eta) && (!best || eta < best.eta)) best = { c: cid, st: sid, eta };
          }
        }
        if (!best) continue;
        // Re-use the package id if this request was already packed for a carrier that missed it.
        const prev = packedFor.get(k);
        const packageId = prev?.packageId ?? `cp-${nextPkg++}`;
        packedFor.set(k, { packageId, store: best.st });
        assigned.set(k, { packageId, carrier: best.c, store: best.st, at: v.t });
        busyNow.add(best.c);
        const storePos = picture.stores[best.st].pos;
        out.push(send(s.id, best.st, 'order', { type: 'pack', packageId, carrier: best.c, req: r, picture } satisfies OrderBody));
        out.push(send(s.id, best.c, 'order', { type: 'carry', packageId, store: best.st, storePos, req: r, picture } satisfies OrderBody));
        out.push({ type: 'log', text: `Order: ${best.c} takes ${r.requestId} from ${best.st} to ${r.clinicId} (ETA ${Math.round(best.eta / 60)} min)` });
      }
      out.push(send(s.id, '*', 'order', { type: 'picture', picture } satisfies OrderBody));
      return out;
    },
    dump: () => pictureDump(s.id, picture, [], null),
    receipts: () => [],
  };

  function addRequest(r: CentralRequest) {
    if (filled.has(r.requestId) || picture.requests[reqKey(r)]) return;
    // A newer attempt replaces the old one: drop the stale attempt and its assignment.
    for (const [k, old] of Object.entries(picture.requests)) {
      if (old.requestId === r.requestId && old.attempt < r.attempt) { delete picture.requests[k]; assigned.delete(k); }
    }
    picture.requests[reqKey(r)] = r;
    picture.clinics[r.clinicId] = r.clinicPos;
    if (!picture.notes.includes(r.manifest.beneficiaryNote)) picture.notes.push(r.manifest.beneficiaryNote);
  }
}

// ---------- store: packs on dispatch orders, loads the named carrier ----------
function storeAgent(s: AgentSetup): Agent {
  const picture = emptyPicture();
  const forCarrier = new Map<string, NodeId>();   // packageId -> carrier that should collect it
  let packed = 0;
  let lastReport = -Infinity;

  return {
    id: s.id, kind: s.kind,
    async tick(v: AgentView): Promise<Action[]> {
      const out: Action[] = [];
      picture.stores[s.id] = { pos: v.pos, onShelf: v.inventory.length, packed, t: v.t };
      for (const m of v.inbox) {
        if (!isOrder(m)) continue;
        const b = m.body;
        if (b.type === 'picture' || b.type === 'pack') mergePicture(picture, b.picture);
        if (b.type !== 'pack') continue;
        const known = forCarrier.has(b.packageId);
        forCarrier.set(b.packageId, b.carrier);
        if (known) continue;   // already packed; just a new carrier to hand it to
        const box = await packBox(b.packageId, b.req, s);
        packed++;
        out.push({ type: 'spawnBox', box, kg: b.req.manifest.declaredKg });
        out.push({ type: 'log', text: `Packed ${b.packageId} for ${b.req.clinicId} on dispatch order; ${b.carrier} collects` });
      }
      // Hand each box to its carrier once it is close enough.
      for (const cb of v.inventory) {
        const c = forCarrier.get(cb.box.label.packageId);
        const n = c && v.neighbours.find((x) => x.id === c);
        if (n && n.dist <= TRANSFER_RADIUS) out.push({ type: 'transfer', packageId: cb.box.label.packageId, to: n.id });
      }
      if (v.cellSignal && v.t - lastReport >= DISPATCH_EVERY_SEC) {
        lastReport = v.t;
        out.push(send(s.id, 'dispatch', 'order', { type: 'stock', pos: v.pos, onShelf: v.inventory.length, packed } satisfies OrderBody));
      }
      return out;
    },
    dump: () => pictureDump(s.id, picture, [], null),
    receipts: () => [],
  };
}

async function packBox(packageId: string, r: CentralRequest, s: AgentSetup): Promise<SealedBox> {
  const label: Label = {
    packageId, requestId: r.requestId, attempt: r.attempt, urgency: r.urgency,
    size: r.size, cold: r.cold, destCell: r.destCell, deadline: r.deadline,
  };
  const sealed = await seal(r.manifest, r.replyPub);
  const auditorCopy = await seal(r.manifest, s.auditorSealPub);
  return { label, sealed, auditorCopy, packedBy: s.id, packSig: await sign({ label, sealed }, s.keys.signPriv) };
}

// ---------- carriers: obey one order at a time ----------
type CarrierJob = { packageId: string; store: NodeId; storePos: Vec2; req: CentralRequest; stage: 'toStore' | 'toClinic'; since: number; atStore?: number };

function carrierAgent(s: AgentSetup): Agent {
  const kind = s.kind as CarrierKind;
  const picture = emptyPicture();
  const queue: CarrierJob[] = [];
  const uplink: CentralRequest[] = [];
  const reports: OrderBody[] = [];   // "order done" reports waiting for signal (the clinic may have none)
  let job: CarrierJob | null = null;
  let heading: string | null = null;   // what the last moveTo was for, so we only re-plan on change
  let lastReport = -Infinity;
  let labels: Label[] = [];
  let charging = false;

  return {
    id: s.id, kind: s.kind,
    async tick(v: AgentView): Promise<Action[]> {
      const out: Action[] = [];
      labels = v.inventory.map((c) => c.box.label);
      for (const m of v.inbox) {
        if (!isOrder(m)) continue;
        const b = m.body;
        if (b.type === 'picture' || b.type === 'carry') mergePicture(picture, b.picture);
        if (b.type === 'carry' && job?.packageId !== b.packageId && !queue.some((q) => q.packageId === b.packageId)) {
          queue.push({ packageId: b.packageId, store: b.store, storePos: b.storePos, req: b.req, stage: 'toStore', since: v.t });
        }
        if (b.type === 'requests' && CARRIER_UPLINK) uplink.push(...b.reqs);
      }

      if (!job && queue.length) { job = queue.shift()!; job.since = v.t; out.push({ type: 'log', text: `New order: collect ${job.packageId} at ${job.store} for ${job.req.clinicId}` }); }

      if (job) {
        const holding = v.inventory.some((c) => c.box.label.packageId === job!.packageId);
        if (job.stage === 'toStore' && holding) {
          job.stage = 'toClinic';
          out.push({ type: 'log', text: `Collected ${job.packageId}; driving direct to ${job.req.clinicId}` });
        }
        if (job.stage === 'toClinic' && !holding) {
          out.push({ type: 'log', text: `Delivered ${job.packageId} to ${job.req.clinicId}; order done` });
          reports.push({ type: 'delivered', requestId: job.req.requestId, attempt: job.req.attempt, packageId: job.packageId, by: s.id, shortKg: 0 });
          job = null;
        } else if (job.stage === 'toStore' && dist(v.pos, job.storePos) <= TRANSFER_RADIUS && v.t - (job.atStore ??= v.t) > 4 * RESEND_EVERY) {
          out.push({ type: 'log', text: `Store never loaded ${job.packageId}; dropping the order` });
          job = null;   // the store never got its pack order (network cut mid-order)
        }
      }

      if (job) {
        const target = job.stage === 'toStore' ? job.storePos : job.req.clinicPos;
        const key = `${job.packageId}:${job.stage}`;
        if (heading !== key) { heading = key; out.push(moveTo(v, kind, target)); }
        if (job.stage === 'toClinic') {
          const n = v.neighbours.find((x) => x.id === job!.req.clinicId);
          if (n && n.dist <= TRANSFER_RADIUS) out.push({ type: 'transfer', packageId: job.packageId, to: n.id });
        }
      } else if (kind === 'drone' && (charging || v.battery < DRONE_RECHARGE_BELOW)) {
        // Idle drone on low battery: fly to the nearest hub (drones charge there) and wait until full.
        charging = v.battery < 0.98;
        const hub = v.map.hubs().reduce((b, h) => (dist(h.pos, v.pos) < dist(b.pos, v.pos) ? h : b));
        if (charging && heading !== `charge:${hub.id}`) {
          heading = `charge:${hub.id}`;
          out.push(moveTo(v, kind, hub.pos), { type: 'log', text: `Battery ${Math.round(v.battery * 100)}%: flying to ${hub.id} to recharge` });
        }
      } else if (!v.cellSignal) {
        // No order and no signal: head back into coverage to report in. If we are already in a covered
        // area and still have no signal, the network is down: hold where we are.
        const c = nearestCoverage(v.pos);
        if (dist(v.pos, c.pos) > c.radius * 0.8) {
          const target = { x: c.pos.x + (v.pos.x - c.pos.x) * 0.5, y: c.pos.y + (v.pos.y - c.pos.y) * 0.5 };
          const key = `home:${Math.round(c.pos.x)}`;
          if (heading !== key) { heading = key; out.push(moveTo(v, kind, target)); out.push({ type: 'log', text: 'Idle and out of signal: heading back into coverage' }); }
        } else if (heading !== 'hold') {
          heading = 'hold';
          out.push({ type: 'stop' }, { type: 'log', text: 'Network down: holding position until dispatch is back' });
        }
      }

      if (v.cellSignal && v.t - lastReport >= DISPATCH_EVERY_SEC) {
        lastReport = v.t;
        const used = v.inventory.reduce((u, c) => u + SIZE_UNITS[c.box.label.size], 0);
        const status: CarrierStatus = { kind, pos: v.pos, busy: job?.packageId ?? (queue[0]?.packageId ?? null), spare: CAPACITY[kind] - used, battery: v.battery };
        out.push(send(s.id, 'dispatch', 'beacon', status));
        for (const b of reports.splice(0)) out.push(send(s.id, 'dispatch', 'order', b));
        if (uplink.length) out.push(send(s.id, 'dispatch', 'order', { type: 'requests', reqs: uplink.splice(0) } satisfies OrderBody));
      }
      return out;
    },
    // Next hop is simply the clinic of the current order: central routes are direct.
    dump: () => pictureDump(s.id, picture, labels, job?.req.clinicId ?? null),
    receipts: () => [],
  };

  function moveTo(v: AgentView, k: CarrierKind, target: Vec2): Action {
    const path = v.map.route(k, v.pos, target);
    return { type: 'moveTo', path: path.length ? path : [target] };
  }
}

function nearestCoverage(p: Vec2) {
  return CELL_COVERAGE.reduce((best, c) => (dist(p, c.pos) - c.radius < dist(p, best.pos) - best.radius ? c : best));
}

// What the engine's scenario puts in a clinic's inbox (src/sim/scenario.ts DemandBody; only the fields used here).
interface ScenarioDemand { type: 'demand'; urgency?: Urgency; items?: { code: string; qty: number }[]; declaredKg?: number; beneficiaryNote?: string }

// ---------- clinic: makes requests, receives boxes ----------
function clinicAgent(s: AgentSetup): Agent {
  const picture = emptyPicture();
  const mine = new Map<string, { req: CentralRequest; lastSent: number }>();   // open, by requestId
  const filled = new Set<string>();
  const receipts: Receipt[] = [];
  const outbox: OrderBody[] = [];   // delivery reports waiting for signal
  let seq = 0;

  return {
    id: s.id, kind: s.kind,
    async tick(v: AgentView): Promise<Action[]> {
      const out: Action[] = [];
      picture.clinics[s.id] = v.pos;
      // New demand comes from the engine's seeded scenario (the same admissions the mesh clinics get, PLAN 3.4 step 1).
      for (const m of v.inbox) {
        if (isOrder(m) && m.body.type === 'picture') mergePicture(picture, m.body.picture);
        const d = m.body as ScenarioDemand | undefined;
        if (m.kind === 'order' && m.from === 'scenario' && m.to === s.id && d?.type === 'demand') {
          const requestId = `${s.id}-r${++seq}`;
          const manifest = d.items?.length && d.beneficiaryNote
            ? { requestId, items: d.items.map((i) => ({ ...i })), declaredKg: d.declaredKg ?? d.items.reduce((kg, i) => kg + (CATALOGUE[i.code]?.kg ?? 0) * i.qty, 0), beneficiaryNote: d.beneficiaryNote }
            : undefined;
          const req = newRequest(v, requestId, 1, manifest, d.urgency);
          mine.set(req.requestId, { req, lastSent: -Infinity });
          picture.notes.push(req.manifest.beneficiaryNote);
          out.push({ type: 'log', text: `New request ${req.requestId}: ${req.manifest.beneficiaryNote}` });
        }
      }

      // Deadline passed with no delivery: ask again (attempt + 1).
      for (const [id, o] of mine) {
        if (v.t > o.req.deadline) {
          const req = newRequest(v, id, o.req.attempt + 1, o.req.manifest);
          mine.set(id, { req, lastSent: -Infinity });
          out.push({ type: 'log', text: `${id} missed its deadline; re-requesting (attempt ${req.attempt})` });
        }
      }

      // Boxes that arrived: open, weigh, sign the delivery, consume.
      for (const cb of v.inventory) {
        const l = cb.box.label;
        let declared = 0;
        try { declared = (await open<Manifest>(cb.box.sealed, s.keys.sealPriv)).declaredKg; } catch { /* not ours to open */ }
        // Central boxes carry no hand-off receipts; the giver is whichever carrier is right next to us.
        const giver = v.neighbours.filter((n) => n.dist <= TRANSFER_RADIUS && n.kind !== 'store' && n.kind !== 'clinic')
          .sort((a, b) => a.dist - b.dist)[0]?.id;
        const last = cb.passport[cb.passport.length - 1];
        const r = await signedReceipt({
          packageId: l.packageId, requestId: l.requestId, attempt: l.attempt, kind: 'delivered',
          from: giver ?? last?.to ?? cb.box.packedBy, to: s.id, t: v.t, seq: cb.passport.length,
          cell: v.map.cellOf(v.pos), measuredKg: cb.measuredKg,
        }, s);
        receipts.push(r);
        out.push({ type: 'stamp', packageId: l.packageId, receipt: r }, { type: 'consume', packageId: l.packageId });
        const shortKg = Math.max(0, declared - cb.measuredKg);
        if (shortKg > WEIGHT_TOLERANCE_KG) {
          // Central has no signed hand-off weights, so the clinic cannot say where the loss happened.
          out.push({ type: 'alert', alert: { t: v.t, kind: 'short-delivery', reportedBy: s.id, packageId: l.packageId, cell: r.cell, kg: shortKg, text: `Box ${l.packageId} arrived ${shortKg.toFixed(1)} kg short; no record of where it was lost` } });
        }
        if (filled.has(l.requestId)) out.push({ type: 'log', text: `Duplicate box ${l.packageId} for ${l.requestId}` });
        filled.add(l.requestId);
        mine.delete(l.requestId);
        outbox.push({ type: 'delivered', requestId: l.requestId, attempt: l.attempt, packageId: l.packageId, by: r.from, shortKg });
      }

      // Requests go out only over the cell network (re-sent until dispatch lists them as open).
      const pending = [...mine.values()].filter((o) => !picture.requests[reqKey(o.req)] && v.t - o.lastSent >= RESEND_EVERY);
      if (v.cellSignal) {
        for (const o of pending) { o.lastSent = v.t; out.push(send(s.id, 'dispatch', 'request', o.req)); }
        for (const b of outbox.splice(0)) out.push(send(s.id, 'dispatch', 'order', b));
      } else if (CARRIER_UPLINK && pending.length) {
        const c = v.neighbours.find((n) => n.kind !== 'store' && n.kind !== 'clinic' && n.kind !== 'dispatch');
        if (c) { pending.forEach((o) => (o.lastSent = v.t)); out.push(send(s.id, c.id, 'order', { type: 'requests', reqs: pending.map((o) => o.req) } satisfies OrderBody)); }
      }
      return out;
    },
    dump: () => pictureDump(s.id, picture, [], null),
    receipts: () => [...receipts],
  };

  function newRequest(v: AgentView, requestId: string, attempt: number, manifest?: Manifest, urgencyIn?: Urgency): CentralRequest {
    const urgency = urgencyIn ?? ((1 + Math.floor(s.rng() * 3)) as Urgency);
    const m = manifest ?? makeManifest(requestId, s.rng);
    const cold = m.items.some((i) => CATALOGUE[i.code]?.cold);
    return {
      requestId, attempt, urgency, size: SIZE_FOR_KG(m.declaredKg), cold,
      destCell: v.map.cellOf(v.pos), deadline: v.t + DEMAND.deadlineSec[urgency],
      clinicId: s.id, clinicPos: v.pos, replyPub: s.keys.sealPub, manifest: m,
    };
  }
}

// Counts only, never names (PLAN 3.4 step 2).
export function makeManifest(requestId: string, rng: () => number): Manifest {
  const items = [{ code: 'RUTF-30', qty: 1 + Math.floor(rng() * 2) }];
  if (rng() < 0.4) items.push({ code: 'ORS-ZN', qty: 1 + Math.floor(rng() * 2) });
  if (rng() < 0.1) items.push({ code: 'VAX-MR', qty: 1 });
  const declaredKg = Math.round(items.reduce((kg, i) => kg + CATALOGUE[i.code].kg * i.qty, 0) * 100) / 100;
  const kids = 4 + Math.floor(rng() * 12);
  const fresh = Math.floor(rng() * Math.min(kids, 5));
  return { requestId, items, declaredKg, beneficiaryNote: `${kids} children 6-59 months, ${fresh} new` };
}

export const centralFactories: Factories = {
  drone: carrierAgent, motorbike: carrierAgent, van: carrierAgent, boat: carrierAgent,
  store: storeAgent, clinic: clinicAgent, dispatch: dispatchAgent,
};
