// Carrier brain: drones, motorbikes, vans and boats (PLAN 3.3-3.5, 3.9, 13 #1-3, #9).
// Each tick: check the hold (stamp + weigh new boxes), read messages, beacon, re-send what it carries,
// look for a faster neighbour for each box, run the signed last mile, then pick where to drive.
import { CAPACITY, CELL_SIZE, DEMAND, MEET_OFFSET, RESEND_EVERY, SPEED, TRANSFER_RADIUS, WEIGHT_TOLERANCE_KG } from '../contracts/config';
import type {
  Action, Agent, AgentSetup, AgentView, Beacon, BreachDump, CarriedBox, CarrierKind, Cert, CellId, Hub, Label, Msg,
  NodeId, NodeState, Receipt, RequestEnvelope, Vec2,
} from '../contracts/types';
import { nonce } from '../privacy/core';
// certAllows comes from ./common (same check, each cert verified once)
import {
  type AcceptBody, ANY_ROLE, BEACON_EVERY, certAllows, RESEND_WITH_SIGNAL, CARRIERS, type ClaimRecord, Guard, type LoadBody, Outbox, type ProposeBody,
  type ReplyBody, type SignedBody, claimKey, envelopeKey, itemsOf, log, receiptKey, screenText, signReceipt, verifyClaim,
  verifyEnvelope,
} from './common';
import {
  type NetObservation, type Peer, type RelaySlot, type SwarmRole, SWARM, flightPhase, netStatus, peerFromBeacon, planRelays,
  bandOf, layerAlt, readSwarm, separate, stepAlt, swarmBeacon, swarmRole, toward,
} from './swarm';
import {
  type Candidate, type DarkPost, type PostClaim, assignPosts, byUrgency, canHandTo, darkPosts, decideHandoff, detourOk, dist,
  droneCanCarry, etaTo, inCoverage, minutes, nearestHub, phoneSpot, POST_CLAIM_TTL, releasePoint, units, vanShouldDeliver,
} from './routing';

/** Vans: how long an empty van waits at its store for a load while requests can still arrive by phone, before a
 *  hub run to pick up requests that mules carried there (no point driving empty while the phones work). */
const VAN_STORE_WAIT_SEC = 120 * RESEND_EVERY;
/** Vans: how long a loaded van waits at the hub for a drone or bike before driving the boxes on itself (vans are slow). */
const VAN_HUB_WAIT_SEC = 8 * RESEND_EVERY;
/** Drones parked away from their hub go home to charge below this battery, and park again once charged. */
const PARK_MIN_BATTERY = 0.6;
const PARK_FULL_BATTERY = 0.95;

/** One hand-off in progress. The meeting point lives only here and is wiped when the deal ends. */
interface Deal {
  packageId: string;
  partner: NodeId;
  meet: Vec2;
  label: Label;
  role: 'give' | 'take';
  accepted: boolean;
  meetBy: number;                                        // when both should be at the meeting point
  expires: number;
}

const kg = (v: number) => v.toFixed(2);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const NO_VEL: Vec2 = { x: 0, y: 0 };

export function createCarrier(s: AgentSetup): Agent {
  const kind = s.kind as CarrierKind;
  const guard = new Guard(s);

  const deals = new Map<string, Deal>();                  // packageId -> hand-off in progress
  const envelopes = new Map<string, RequestEnvelope>();   // packageId -> the clinic's signed request (who to trust at the last mile)
  const mule = new Outbox<RequestEnvelope>();             // requests I carry toward the stores
  const confirms = new Outbox<Receipt>();                 // 'delivered' receipts I carry back
  const claims = new Outbox<ClaimRecord>();               // store claims I carry to stores out of earshot
  const claimed = new Set<string>();                      // requestId#attempt some store has claimed
  const refused = new Set<string>();                      // requestId#attempt that failed a signature or cert check
  const filled = new Set<string>();                       // requestIds known delivered
  const ledger = new Map<string, Receipt>();              // receipts for boxes I touched (pruned once delivered)
  const stamped = new Set<string>();                      // packageId:seq already stamped by me
  const beacons = new Map<NodeId, { b: Beacon; t: number }>();
  const certOk = new Map<NodeId, { ok: boolean; until: number }>();
  const stores = new Map<NodeId, Vec2>();                 // vans only: the stores they load at
  const blocked = new Set<NodeId>();                      // failed a cert or signature check
  const pairCounts: Record<NodeId, number> = {};          // hand-offs per partner (pair rotation)
  const gaveMe = new Map<string, NodeId>();               // never hand a box straight back
  const calls = new Map<string, { challenge: string; t: number }>();
  const clinicFor = new Map<string, NodeId>();            // packageId -> clinic that proved itself
  const declined = new Map<string, number>();             // `${packageId}|${carrier}` -> don't ask again before this time

  let held = new Map<string, CarriedBox>();
  let smallestHeld = 1;                                   // units of the smallest box I hold (1 when empty), per tick
  let muleLog: string[] = [];                             // requests picked up this tick (one log line)
  let muleOut: Action[] = [];                             // where muleEnvelope puts its alerts this tick
  let muleCell: CellId = '';
  let pos: Vec2 = s.home;
  let prevPos: Vec2 = s.home;
  let battery = 1;
  let hubs: Hub[] = [];
  let lastBeacon = -Infinity;
  let lastPlan = -Infinity;
  let lastStatus = -Infinity;
  let lastExpire = -Infinity;
  let patrolIdx = 0;
  let dwellUntil: number | null = null;
  let hadSignal = false;
  let hubSince: number | null = null;                     // vans: when I reached a hub with boxes
  let vanAlone = false;
  let lastHelper = -Infinity;                             // vans: last beacon from a non-van carrier with room
  let atStoreSince: number | null = null;
  let route: { target: Vec2; path: Vec2[]; since: number } | null = null;
  // Vans: did my store have cell signal the last time I was there? While it does (towers up), requests reach the
  // stores by phone and drones hear hand-off offers by phone too, so I drive straight out of the stores' earshot
  // and hand boxes to drones there, then go straight back. Without signal I fall back to the hub shuttle (PLAN 13 #8).
  let storeSignal: boolean | null = null;
  let release: { cell: CellId; at: Vec2 | null } | null = null;   // vans: where this trip leaves the stores' earshot
  // Drones: towers up as far as I know (signal seen since the last time I sat in town coverage without any)?
  let lastSignalT = 0;
  let lastOutageT = -Infinity;
  let charging = false;
  let parkFor: { home: number; spot: Vec2 | null } | null = null;                                   // drones: heading home to charge before parking again
  // Standing relay posts for clinics with no cell coverage (towers up). Clinics are public, so carriers share
  // the clinic positions they have met; post claims are gossiped so a post out of coverage is still known.
  const clinicsKnown = new Map<NodeId, Vec2>();
  const postClaims = new Map<string, PostClaim>();        // `${post}|${by}` -> freshest claim heard
  const clinicsReadAt = new Map<NodeId, number>();
  const postsReadAt = new Map<NodeId, number>();
  let myPost: { post: DarkPost; since: number } | null = null;
  // Swarm (src/agents/swarm.ts): towers up/down from first-hand signal plus gossip, relay drones when the mesh
  // splits with the towers down, altitude layers by direction of travel. Display state goes out as a 'status' action.
  let net: NetObservation | null = null;
  let relay: RelaySlot | null = null;
  let alt = 0;
  let vel: Vec2 = { x: 0, y: 0 };
  let role: SwarmRole = 'idle';
  let phase: NonNullable<NodeState['phase']> = 'idle';
  const said = new Map<string, string>();                 // topic -> last reason logged (no repeats in the inspector)
  let lastLayer = '';
  const swarmOf = new Map<NodeId, { t: number; sw: ReturnType<typeof readSwarm> }>();
  let postsCache: DarkPost[] = [];
  let postsFor = -1;                                      // clinicsKnown.size the cache was built for

  const usedUnits = () =>
    [...held.values()].reduce((n, c) => n + units(c.box.label), 0) +
    [...deals.values()].filter((d) => d.role === 'take').reduce((n, d) => n + units(d.label), 0);
  const spare = () => CAPACITY[kind] - usedUnits();
  /** Vans: towers were up at my store, so this trip runs direct (no hub wait). */
  const direct = () => kind === 'van' && storeSignal === true;
  /** Towers up as far as I know: no first-hand outage since my last signal, and no fresher report of one in beacons. */
  const towersUp = () => lastSignalT > lastOutageT && !net?.down;

  function forget(pkg: string): void {
    deals.delete(pkg); envelopes.delete(pkg); calls.delete(pkg); clinicFor.delete(pkg); gaveMe.delete(pkg);
  }

  // ---------- 1. the hold: weigh, stamp and sign every new box (PLAN 13 #1-3) ----------
  async function checkHold(v: AgentView, out: Action[], cell: CellId): Promise<void> {
    const now = new Map(v.inventory.map((c) => [c.box.label.packageId, c] as const));
    const toGivers = new Map<NodeId, Receipt[]>();
    for (const [pkg] of held) {
      if (now.has(pkg)) continue;
      const d = deals.get(pkg);
      const clinic = clinicFor.get(pkg);
      if (d?.role === 'give') {
        pairCounts[d.partner] = (pairCounts[d.partner] ?? 0) + 1;
        out.push(log(`Handed box ${pkg} to ${d.partner}. Meeting point wiped.`));
      } else if (clinic) out.push(log(`Delivered box ${pkg} to ${clinic}.`));
      else out.push(log(`Box ${pkg} left my hold without a hand-off from me.`));
      forget(pkg);
    }
    for (const [pkg, c] of now) {
      const pp = c.passport;
      const last = pp[pp.length - 1];
      if (last?.to === s.id) continue;                       // already carries my receipt
      const key = `${pkg}:${pp.length}`;
      if (stamped.has(key)) continue;
      stamped.add(key);
      const from = last ? last.to : c.box.packedBy;
      // Live Leak Finder: my scale against the last weight on the box's passport. No network needed.
      if (last && Math.abs(c.measuredKg - last.measuredKg) > WEIGHT_TOLERANCE_KG) {
        const lost = last.measuredKg - c.measuredKg;
        guard.raise(out, 'weight-mismatch', from, v.t, cell,
          `Box ${pkg} ${lost > 0 ? 'lost' : 'gained'} ${kg(Math.abs(lost))} kg while held by ${from} (cell ${last.cell}): my scale says ${kg(c.measuredKg)} kg, its passport says ${kg(last.measuredKg)} kg`,
          { packageId: pkg, kg: Math.round(lost * 1000) / 1000 });
      }
      const l = c.box.label;
      const r = await signReceipt({
        packageId: pkg, requestId: l.requestId, attempt: l.attempt, kind: last ? 'handoff' : 'pickup',
        from, to: s.id, t: v.t, seq: pp.length, cell, measuredKg: c.measuredKg,
      }, s.keys.signPriv);
      out.push({ type: 'stamp', packageId: pkg, receipt: r });
      for (const p of pp) ledger.set(receiptKey(p), p);
      ledger.set(receiptKey(r), r);
      toGivers.set(from, [...(toGivers.get(from) ?? []), r]);   // the giver keeps a copy: proof it handed over
      const d = deals.get(pkg);
      if (d?.role === 'take') { pairCounts[from] = (pairCounts[from] ?? 0) + 1; deals.delete(pkg); }
      gaveMe.set(pkg, from);
      out.push(log(`Got box ${pkg} from ${from} in ${cell}: weighed ${kg(c.measuredKg)} kg, signed the receipt.`));
    }
    held = now;
    for (const [giver, items] of toGivers) out.push(await guard.signed('receipts', giver, { items }));
  }

  // ---------- 2. messages ----------
  async function trustedBeacon(from: NodeId, b: Beacon & { cert?: Cert | null }, t: number, cell: CellId, out: Action[]): Promise<boolean> {
    if (!guard.certsOn) return true;
    const c = certOk.get(from);
    if (c && t < c.until) return c.ok;
    const cert = b.cert ?? null;
    const ok = !!cert && cert.nodeId === from && (await certAllows(cert, CARRIERS, cert.signPub, s.authoritySignPubs, t));
    certOk.set(from, { ok, until: ok && cert ? cert.expires : Infinity });
    if (!ok) {
      blocked.add(from);
      guard.raise(out, 'no-cert', from, t, cell, `Hand-off refused: ${from} has no valid carrier certificate`);
    }
    return ok;
  }

  function keepBeacon(from: NodeId, b: Beacon, t: number): void {
    beacons.set(from, { b, t });
    if (kind === 'drone') mergeGossip(from, b as unknown as Record<string, unknown>, t);   // only drones staff relay posts
    // A helper only counts if it has room for at least one box I hold (a drone can't take a size-L box).
    if (b.kind !== 'van' && b.spareCapacity >= smallestHeld) lastHelper = t;
  }

  /** Beacons are most of the traffic: take them without an async round trip when the sender's cert is already known. */
  function beaconFast(m: Msg, t: number): boolean {
    if (m.kind !== 'beacon') return false;
    const b = m.body as Beacon | null;
    if (!b || b.id !== m.from) return true;                  // malformed: drop, nothing to check
    if (guard.certsOn) {
      const c = certOk.get(m.from);
      if (!c || t >= c.until) return false;                  // first sight or expired: full (async) cert check
      if (!c.ok) return true;
    }
    keepBeacon(m.from, b, t);
    return true;
  }

  async function muleEnvelope(e: RequestEnvelope, t: number): Promise<void> {
    if (!e || typeof e.requestId !== 'string') return;
    const key = envelopeKey(e);
    if (mule.has(key) || claimed.has(key) || refused.has(key) || filled.has(e.requestId) || !(e.deadline > t)) return;
    if (!(await verifyEnvelope(e))) { refused.add(key); return; }   // forged or damaged: don't spread it
    // PLAN 12 #4: with certs on, a request from a clinic without a 2-of-3 cert is refused by the first carrier that hears it.
    if (guard.certsOn && !(e.clinicCert?.nodeId === e.clinicId &&
      (await certAllows(e.clinicCert, ['clinic'], e.clinicSignPub, s.authoritySignPubs, t)))) {
      refused.add(key);
      guard.raise(muleOut, 'no-cert', e.clinicId, t, muleCell, `Request dropped: no valid clinic certificate for ${e.clinicId}`);
      return;
    }
    for (const k of mule.keys()) if (k.startsWith(`${e.requestId}#`)) mule.delete(k);   // newer attempt replaces older
    mule.put(key, e, e.deadline);
    muleLog.push(e.requestId);
  }

  const ledgerHas = (pkg: string) => [...ledger.values()].some((x) => x.packageId === pkg);

  /** `carry` = keep re-sending it toward the stores (not needed when it came over the phone: they have it). */
  function confirm(r: Receipt, t: number, carry = true): void {
    if (filled.has(r.requestId) && confirms.has(receiptKey(r))) return;
    filled.add(r.requestId);
    for (const k of mule.keys()) if (k.startsWith(`${r.requestId}#`)) mule.delete(k);
    for (const k of claims.keys()) if (k.startsWith(`${r.requestId}#`)) claims.delete(k);   // delivered: its claims are moot
    if (carry) confirms.put(receiptKey(r), r, t + DEMAND.deadlineSec[1]);   // carry it back for one full request lifetime
    // PLAN 12 #14: once delivery is confirmed, drop route history for that box (the clinic holds the full passport).
    if (!held.has(r.packageId)) for (const [k, x] of ledger) if (x.packageId === r.packageId) ledger.delete(k);
  }

  async function onPropose(m: Msg, v: AgentView, out: Action[], cell: CellId): Promise<void> {
    const why = await guard.screen(m, v.t, ['store', ...CARRIERS]);
    if (why) {
      if (why === 'no-cert') blocked.add(m.from);
      guard.raise(out, why, m.from, v.t, cell, screenText(why, m, 'carrier or store'));
      return;
    }
    const keep = async (p: ProposeBody) => {
      const e = p?.envelope;
      if (e && p.label && e.requestId === p.label.requestId && e.destCell === p.label.destCell && (await verifyEnvelope(e))) envelopes.set(p.packageId, e);
    };
    const load = (m.body as Partial<LoadBody>).load;
    if (Array.isArray(load)) {                               // a store loads straight onto a parked van
      if ((m.body as SignedBody).fromKind !== 'store' || kind !== 'van') return;
      for (const p of load) await keep(p);
      out.push(log(`${m.from} is loading ${load.length} box(es) onto me: ${load.map((p) => p.packageId).join(', ')}.`));
      return;
    }
    const b = m.body as ProposeBody & SignedBody;
    const pkg = b.packageId;
    if (!b.label || typeof pkg !== 'string') return;
    await keep(b);
    if (held.has(pkg) || deals.has(pkg)) return;
    const refuse = async (why: string) => {
      out.push(log(`Declined box ${pkg} from ${m.from}: ${why}.`));
      // Say no out loud (signed) so the giver asks someone else now rather than waiting out the offer.
      if ((b.fromKind as string) !== 'store') out.push(await guard.signed('handoff-accept', m.from, { packageId: pkg, meet: null, declined: why } satisfies AcceptBody));
    };
    const meet = b.meet;
    if (!canHandTo(b.fromKind, kind)) return void (await refuse('tier rule'));
    if (spare() < units(b.label)) return void (await refuse('no space'));
    if (myPost) return void (await refuse(`holding relay post for ${myPost.post.clinic}`));
    if (relay) return void (await refuse('hovering as a relay while the towers are down'));
    if (!meet || !v.map.passable(kind, meet) || !detourOk(kind, pos, meet)) return void (await refuse('cannot reach the meeting point'));
    if (kind === 'drone' && !droneCanCarry(battery, pos, meet, v.map.cellCenter(b.label.destCell), hubs)) return void (await refuse('battery too low'));
    const meetBy = Math.max(typeof b.meetBy === 'number' ? b.meetBy : 0, v.t + v.map.eta(kind, pos, meet));
    deals.set(pkg, {
      packageId: pkg, partner: m.from, meet, label: b.label, role: 'take', accepted: true, meetBy, expires: meetBy + RESEND_EVERY,
    });
    const body: AcceptBody = { packageId: pkg, meet };
    out.push(await guard.signed('handoff-accept', m.from, body));
    out.push(log(`Taking box ${pkg} from ${m.from}: meeting ${Math.round(dist(pos, meet))} m from here.`));
  }

  async function onAccept(m: Msg, v: AgentView, out: Action[], cell: CellId): Promise<void> {
    // Check the signature before anything else, so a tampered accept is caught even if it names no real deal.
    const why = await guard.screen(m, v.t, CARRIERS);
    if (why) {
      if (why === 'no-cert') blocked.add(m.from);
      for (const d of deals.values()) if (d.partner === m.from && d.role === 'give') deals.delete(d.packageId);
      const text = why === 'no-cert'
        ? `Hand-off refused: ${m.from} has no valid carrier certificate. Keeping my boxes.`
        : `${screenText(why, m, 'carrier')}. Hand-off cancelled.`;
      guard.raise(out, why, m.from, v.t, cell, text);
      return;
    }
    const b = m.body as AcceptBody;
    const d = deals.get(b.packageId);
    if (!d || d.role !== 'give' || d.partner !== m.from || d.accepted) return;
    if (typeof b.declined === 'string') {
      deals.delete(b.packageId);
      declined.set(`${b.packageId}|${m.from}`, v.t + 2 * RESEND_EVERY);
      out.push(log(`${m.from} declined box ${b.packageId} (${b.declined.slice(0, 60)}); asking someone else.`));
      return;
    }
    d.accepted = true;
    d.expires = Math.max(d.meetBy, v.t + v.map.eta(kind, pos, d.meet)) + RESEND_EVERY;
    out.push(log(`${m.from} accepted box ${d.packageId}; heading to the meeting point.`));
  }

  /** PLAN 3.4 step 7: deliver only to a reply signed by the clinic that signed this box's request. */
  async function onReply(m: Msg, v: AgentView, out: Action[], cell: CellId): Promise<void> {
    if (!calls.size) return;                                 // I called nobody: not my business
    const why = await guard.screen(m, v.t, ['clinic']);
    if (why) {
      guard.raise(out, why, m.from, v.t, cell, `Refused to deliver: ${screenText(why, m, 'clinic')}`);
      return;
    }
    const b = m.body as ReplyBody & SignedBody;
    const call = calls.get(b.packageId);
    const c = held.get(b.packageId);
    if (!call || !c || clinicFor.has(b.packageId)) return;
    const pkg = b.packageId;
    if (b.challenge !== call.challenge || b.requestId !== c.box.label.requestId) {
      out.push(log(`Ignored a last-mile reply from ${m.from} for ${pkg}: it does not answer my call.`));
      return;
    }
    const e = envelopes.get(pkg);
    const expected = e ? e.clinicSignPub === b.signPub && e.clinicId === m.from : guard.certsOn;   // with certs on, the cert vouches
    if (!expected) {
      guard.raise(out, 'bad-signature', m.from, v.t, cell,
        `Refused to deliver ${pkg}: ${m.from}'s reply is not signed by the clinic that requested this box`, { packageId: pkg });
      return;
    }
    clinicFor.set(pkg, m.from);
    out.push(log(`${m.from} sent a valid signed reply for box ${pkg}. Delivering.`));
  }

  async function onMsg(m: Msg, v: AgentView, out: Action[], cell: CellId): Promise<void> {
    // Most likely came over the phone network: I have signal, it is one hop, and the sender is not in radio range.
    const phone = v.cellSignal && m.hops === 1 && !v.neighbours.some((n) => n.id === m.from);
    switch (m.kind) {
      case 'beacon': {
        const b = m.body as Beacon & { cert?: Cert | null };
        if (b && b.id === m.from && (await trustedBeacon(m.from, b, v.t, cell, out))) keepBeacon(m.from, b, v.t);
        return;
      }
      case 'request': {
        // Verify the sender only when the bundle brings something new or looks wrong (junk, tampering).
        // Heard over the phone network: it already reached every store with signal, so I don't carry a copy.
        const items = itemsOf<RequestEnvelope>(m.body);
        const fresh = phone ? [] : (items ?? []).filter((e) => !!e && typeof e.requestId === 'string' && e.deadline > v.t &&
          !mule.has(envelopeKey(e)) && !filled.has(e.requestId));
        const junk = !items || items.some((e) => !e || typeof e.requestId !== 'string');
        if (!fresh.length && !junk && !guard.suspicious(m)) return;
        const why = await guard.screen(m, v.t, ANY_ROLE, false);
        if (why) return guard.raise(out, why, m.from, v.t, cell, screenText(why, m, 'carrier'));
        for (const e of fresh) await muleEnvelope(e, v.t);
        return;
      }
      case 'receipts': {
        const items = itemsOf<Receipt>(m.body);
        // A delivery confirmation heard over the phone already reached the stores; it only matters to me if I'm
        // still carrying that request or route history for that box.
        const muled = phone ? new Set(mule.values().map((e) => e.requestId)) : null;
        const mine = (r: Receipt) => !muled || muled.has(r.requestId) || ledgerHas(r.packageId);
        const useful = (items ?? []).filter((r) => !!r && typeof r.packageId === 'string' &&
          (r.kind === 'delivered' ? !confirms.has(receiptKey(r)) && !(phone && filled.has(r.requestId)) && mine(r)
            : (r.from === s.id || r.to === s.id) && !ledger.has(receiptKey(r))));
        const junk = !items || items.some((r) => !r || typeof r.packageId !== 'string');
        if (!useful.length && !junk && !guard.suspicious(m)) return;
        const why = await guard.screen(m, v.t, ANY_ROLE, false);
        if (why) return guard.raise(out, why, m.from, v.t, cell, screenText(why, m, 'node'));
        for (const r of useful) {
          if (r.kind === 'delivered') confirm(r, v.t, !phone);
          else ledger.set(receiptKey(r), r);
        }
        return;
      }
      case 'claim': {
        const list = (m.body as { claims?: ClaimRecord[] })?.claims;
        // By phone, a claim already reached every store with signal: only check it if it lets me stop muling a request.
        const fresh = Array.isArray(list) ? list.filter((c) => c && typeof c.requestId === 'string' && !claims.has(claimKey(c)) &&
          (!phone || mule.has(envelopeKey(c)))) : [];
        if (Array.isArray(list) && !fresh.length && !guard.suspicious(m)) return;
        const why = await guard.screen(m, v.t, ANY_ROLE, false);
        if (why) return guard.raise(out, why, m.from, v.t, cell, screenText(why, m, 'sender'));
        for (const c of fresh) {
          if (filled.has(c.requestId) || !(await verifyClaim(c, s, guard.certsOn, v.t))) continue;
          if (!phone) claims.put(claimKey(c), c, v.t + DEMAND.deadlineSec[1]);
          claimed.add(envelopeKey(c));
          mule.delete(envelopeKey(c));                        // a store has it: stop carrying the request itself
        }
        return;
      }
      case 'handoff-propose': return onPropose(m, v, out, cell);
      case 'handoff-accept': return onAccept(m, v, out, cell);
      case 'lastmile-reply': return onReply(m, v, out, cell);
      default: return;                                       // calls are for clinics
    }
  }

  /** Clinic positions and relay-post claims carried in beacons (checked field by field: beacons are unsigned). */
  function mergeGossip(from: NodeId, b: Record<string, unknown>, t: number): void {
    // Clinic lists change rarely: read each sender's at most once a minute, and only if it might add something.
    if (Array.isArray(b.clinics) && b.clinics.length && t - (clinicsReadAt.get(from) ?? -Infinity) >= 60) {
      clinicsReadAt.set(from, t);
      for (const c of b.clinics.slice(0, 64)) {
        const x = c as { id?: unknown; x?: unknown; y?: unknown };
        if (typeof x?.id === 'string' && x.id.startsWith('clinic') && num(x.x) && num(x.y) && !clinicsKnown.has(x.id)) clinicsKnown.set(x.id, { x: x.x, y: x.y });
      }
    }
    // Claims refresh every beacon but live POST_CLAIM_TTL seconds: reading a sender's every 3rd beacon is plenty.
    if (Array.isArray(b.posts) && b.posts.length && t - (postsReadAt.get(from) ?? -Infinity) >= 3 * BEACON_EVERY) {
      postsReadAt.set(from, t);
      for (const c of b.posts.slice(0, 16)) {
        const x = c as Partial<PostClaim>;
        if (typeof x?.post !== 'string' || typeof x.by !== 'string' || !num(x.since) || !num(x.t) || x.t > t + 1) continue;
        const k = `${x.post}|${x.by}`;
        if ((postClaims.get(k)?.t ?? -Infinity) < x.t) postClaims.set(k, { post: x.post, by: x.by, since: x.since, t: x.t });
      }
    }
  }

  /** Drones, towers up: hold a standing relay post for a clinic with no coverage, if the swarm picks me. */
  function standingPost(v: AgentView, out: Action[]): void {
    if (kind !== 'drone') return;
    for (const [k, c] of postClaims) if (v.t - c.t > POST_CLAIM_TTL) postClaims.delete(k);
    if (postsFor !== clinicsKnown.size) { postsFor = clinicsKnown.size; postsCache = darkPosts([...clinicsKnown].map(([id, p]) => ({ id, pos: p }))); }
    const posts = towersUp() ? postsCache : [];
    const free = !held.size && !deals.size && !clinicFor.size && !charging && battery >= 0.5;
    // Take a new post only while I have signal: then I hear every claim by phone and never double up on one.
    const cands = [{ id: s.id, pos, free: (free && v.cellSignal) || !!myPost, battery }];
    for (const [id, { b, t }] of beacons) {
      if (b.kind !== 'drone' || v.t - t > 2 * BEACON_EVERY || blocked.has(id)) continue;
      const bat = (b as Beacon & { battery?: number }).battery;
      const idle = !b.holding.length && (b as Beacon & { idle?: boolean }).idle === true;
      cands.push({ id, pos: b.pos, free: idle, battery: typeof bat === 'number' ? bat : 1 });
    }
    const claims = [...postClaims.values()].filter((c) => c.by !== s.id);
    if (myPost) claims.push({ post: myPost.post.id, by: s.id, since: myPost.since, t: v.t });
    const who = assignPosts(posts, cands, claims, v.t, hubs);
    const mine = posts.find((p) => who.get(p.id) === s.id) ?? null;
    // Low battery on a post: let it go (someone with charge takes over) and fly home.
    const keep = mine && (battery >= 0.3 || held.size);
    if (keep && mine.id !== myPost?.post.id) {
      myPost = { post: mine, since: v.t };
      out.push(log(`Relay post ${mine.index} of ${mine.of} for ${mine.clinic}, which has no cell signal: I hover in ${v.map.cellOf(mine.pos)} so its requests reach the stores by phone at once.`));
    } else if (!keep && myPost) {
      out.push(log(battery < 0.3 ? `Battery ${Math.round(battery * 100)}%: leaving relay post for ${myPost.post.clinic} to charge.`
        : towersUp() ? `Relay post for ${myPost.post.clinic} is taken by another drone; I'm free again.` : 'Towers are down: leaving my standing relay post.'));
      myPost = null;
    }
  }

  /** Log a swarm reason only when it changed for that topic. */
  function say(out: Action[], topic: string, reasons: string[]): void {
    const text = reasons.join(' ');
    if (!text || said.get(topic) === text) return;
    said.set(topic, text);
    out.push(log(text));
  }

  function peers(v: AgentView): Peer[] {
    const list: Peer[] = [];
    for (const [id, { b, t }] of beacons) {
      if (blocked.has(id)) continue;
      const p = peerFromBeacon(b, t, v.neighbours.find((n) => n.id === id)?.pos);
      if (p) list.push(p);
    }
    for (const [id, p] of clinicsKnown) list.push({ id, kind: 'clinic', pos: p, heardAt: v.t });
    return list;
  }

  /** The towers-up/down report in a beacon, checked field by field (beacons are unsigned). */
  function netOf(b: Beacon): NetObservation | undefined {
    const n = (b as { swarm?: { net?: Partial<NetObservation> } }).swarm?.net;
    return n && typeof n.down === 'boolean' && typeof n.t === 'number' && Number.isFinite(n.t) && typeof n.by === 'string'
      ? { down: n.down, t: n.t, by: n.by } : undefined;
  }

  /** A neighbour drone's swarm fields, parsed once per beacon. */
  function swarmFor(id: NodeId): ReturnType<typeof readSwarm> {
    const e = beacons.get(id);
    if (!e) return undefined;
    const c = swarmOf.get(id);
    if (c && c.t === e.t) return c.sw;
    const sw = readSwarm((e.b as { swarm?: unknown }).swarm);
    swarmOf.set(id, { t: e.t, sw });
    return sw;
  }

  /** Every beacon period: towers up or down, and (drones, towers down) whether I should hover as a relay. */
  function swarmStep(v: AgentView, out: Action[]): void {
    // Only drones act on it (standing posts, relays); everyone else just passes on what it saw first-hand.
    const light: Peer[] = kind === 'drone'
      ? [...beacons].flatMap(([id, { b, t }]) => { const n = netOf(b); return n ? [{ id, kind: b.kind, pos: b.pos, heardAt: t, swarm: { net: n } }] : []; })
      : [];
    const ns = netStatus({ me: s.id, pos, cellSignal: v.cellSignal, now: v.t, peers: light, prev: net });
    net = ns.obs;
    if (kind !== 'drone') return;
    say(out, 'net', ns.reasons);
    if (!ns.down && !relay) return;                         // relays are only for a split mesh with the towers down
    const ps = peers(v);
    const rp = planRelays({
      me: {
        id: s.id, kind, pos, battery, carrying: [...held.values()].map((c) => ({ urgency: c.box.label.urgency })),
        busy: deals.size > 0 || clinicFor.size > 0 || !!myPost || charging, relaySlot: relay?.id ?? null,
      },
      now: v.t, networkDown: ns.down, peers: ps, hubs, cellOf: v.map.cellOf,
    });
    if ((rp.mine?.id ?? null) !== (relay?.id ?? null)) say(out, 'relay', rp.reasons);
    // Low battery: let the post go (another idle drone takes it) and fly home to charge.
    relay = rp.mine && battery >= 0.3 ? rp.mine : null;
  }

  /** Drones: altitude layer by direction of travel (east-ish 110 m, west-ish 130 m), climbing at the swarm's rate. */
  function flight(v: AgentView, out: Action[]): void {
    const goal = route?.path?.[0] ?? route?.target ?? pos;
    const moving = dist(pos, prevPos) > 0.1 || dist(pos, goal) > 1;
    const want = moving ? toward(pos, goal, SPEED.drone, v.dt) : { x: 0, y: 0 };
    let target = 0;
    const near = dist(pos, goal) < 400;
    const handoff = [...deals.values()].some((d) => d.accepted && dist(pos, d.meet) <= 2 * MEET_OFFSET[1]) ||
      [...clinicFor.keys()].some((pkg) => held.has(pkg));
    if (relay || myPost) target = SWARM.RELAY_ALT;
    else if (moving) {
      const others: { id: NodeId; pos: Vec2; vel: Vec2; alt: number }[] = [];
      for (const n of v.neighbours) {
        if (n.kind !== 'drone' || n.dist > SWARM.CONSIDER_R) continue;
        const sw = swarmFor(n.id);
        others.push({ id: n.id, pos: n.pos, vel: sw?.vel ?? NO_VEL, alt: sw?.alt ?? SWARM.ALT_EAST });
      }
      // Nobody near: my direction's base layer, no need to run the full separation check.
      const sep = others.length
        ? separate({ me: { id: s.id, pos, vel, alt }, desired: want, others, cellOf: v.map.cellOf })
        : { alt: layerAlt(bandOf(want), 0), band: bandOf(want), sublayer: 0, reasons: [] as string[] };
      // Log a yield once per change of layer, not every tick (the pass distance changes every tick).
      const layer = `${sep.band}:${sep.sublayer}`;
      if (layer !== lastLayer) {
        lastLayer = layer;
        say(out, 'sep', sep.reasons.filter((r) => r.startsWith('Yielding')).map((r) => r.replace(/, closest pass .*? s\./, '.')));
      }
      target = handoff && near ? 20 : sep.alt;
    }
    vel = want;
    alt = stepAlt(alt, target, v.dt);
    role = swarmRole({ relay: !!(relay || myPost), charging, carrying: held.size, wins: deals.size, patrolling: false });
    phase = handoff && moving && near ? 'handoff'
      : flightPhase({ role, moving: moving || alt > 1, distToGoal: dist(pos, goal), alt, cruiseAlt: target || SWARM.ALT_EAST });
    out.push({ type: 'status', role, phase, alt: Math.round(alt) });
  }

  // ---------- 3. hand-off planning (PLAN 3.5) ----------
  function myEta(v: AgentView, l: Label): number {
    const dest = v.map.cellCenter(l.destCell);
    if (kind === 'drone' && !droneCanCarry(battery, pos, pos, dest, hubs)) return Infinity;
    return etaTo(v.map, kind, pos, dest);
  }

  /** Vans on a direct trip: hand-off spots on my own route, just out of the stores' earshot. */
  function routeAnchors(v: AgentView, top: Label | undefined): Vec2[] {
    if (!direct() || !top) return [];
    const known = [...stores.values()];
    if (releasePoint([pos], known, ['drone'])) return [];              // already clear: meet around where I am
    if (!release || release.cell !== top.destCell) {
      release = { cell: top.destCell, at: releasePoint(v.map.route('van', pos, v.map.cellCenter(top.destCell)), known, ['drone']) };
    }
    return release.at ? [release.at] : [];
  }

  async function plan(v: AgentView, out: Action[]): Promise<void> {
    const promised: Record<NodeId, number> = {};
    const boxes = [...held.values()].map((c) => c.box.label).sort(byUrgency);
    const onMyRoute = routeAnchors(v, boxes[0]);
    for (const l of boxes) {
      if (deals.has(l.packageId) || clinicFor.has(l.packageId)) continue;
      const candidates: Candidate[] = [];
      for (const [id, { b, t }] of beacons) {
        if (v.t - t > 2 * BEACON_EVERY || blocked.has(id) || !CARRIERS.includes(b.kind)) continue;
        const n = v.neighbours.find((x) => x.id === id);
        const bat = (b as Beacon & { battery?: number }).battery;
        candidates.push({ id, kind: b.kind, pos: n?.pos ?? b.pos, battery: typeof bat === 'number' ? bat : 1, spare: b.spareCapacity - (promised[id] ?? 0) });
      }
      if (!candidates.length) return;
      const gaver = gaveMe.get(l.packageId);
      const exclude = new Set(gaver ? [gaver] : []);
      for (const [k, until] of declined) {
        if (until <= v.t) declined.delete(k);
        else if (k.startsWith(`${l.packageId}|`)) exclude.add(k.slice(l.packageId.length + 1));
      }
      const d = decideHandoff({
        me: { id: s.id, kind, pos, battery }, myEta: myEta(v, l), label: l, dest: v.map.cellCenter(l.destCell),
        candidates, map: v.map, rng: s.rng, knownStores: [...stores.values()], pairCounts,
        exclude, onMyRoute,
      });
      if (!d) continue;
      promised[d.to.id] = (promised[d.to.id] ?? 0) + units(l);
      const meetBy = v.t + Math.max(v.map.eta(kind, pos, d.meet), v.map.eta(d.to.kind, d.to.pos, d.meet));
      deals.set(l.packageId, {
        packageId: l.packageId, partner: d.to.id, meet: d.meet, label: l, role: 'give', accepted: false, meetBy, expires: v.t + RESEND_EVERY,
      });
      const body: ProposeBody = { packageId: l.packageId, label: l, meet: d.meet, meetBy, envelope: envelopes.get(l.packageId) };
      out.push(await guard.signed('handoff-propose', d.to.id, body));
      out.push(log(`Offering box ${l.packageId} to ${d.to.id}: its ETA to ${l.destCell} is ${minutes(d.theirEta)} vs my ${minutes(d.myEta)}.`));
    }
  }

  // ---------- 4. last mile (PLAN 3.4 step 7) ----------
  async function lastMile(v: AgentView, out: Action[], cell: CellId): Promise<void> {
    for (const c of held.values()) {
      const l = c.box.label;
      if (deals.get(l.packageId)?.role === 'give') continue;
      const near = cell === l.destCell || dist(pos, v.map.cellCenter(l.destCell)) <= CELL_SIZE;
      if (!near) continue;
      const clinic = clinicFor.get(l.packageId);
      if (clinic) {
        const n = v.neighbours.find((x) => x.id === clinic);
        if (n && n.dist <= TRANSFER_RADIUS) out.push({ type: 'transfer', packageId: l.packageId, to: clinic });
        continue;
      }
      const call = calls.get(l.packageId);
      if (call && v.t - call.t < RESEND_EVERY) continue;
      const challenge = nonce();
      calls.set(l.packageId, { challenge, t: v.t });
      out.push(await guard.signed('lastmile-call', '*', { packageId: l.packageId, requestId: l.requestId, destCell: l.destCell, challenge }));
      out.push(log(`In ${l.destCell} with box ${l.packageId}: calling the clinic for a signed reply.`));
    }
  }

  // ---------- 5. agreed hand-offs: transfer when both are within TRANSFER_RADIUS ----------
  function transfers(v: AgentView, out: Action[]): void {
    for (const d of deals.values()) {
      if (d.role !== 'give' || !d.accepted || !held.has(d.packageId)) continue;
      const n = v.neighbours.find((x) => x.id === d.partner);
      if (n && n.dist <= TRANSFER_RADIUS) out.push({ type: 'transfer', packageId: d.packageId, to: d.partner });
    }
  }

  // ---------- 6. where to go ----------
  function idleTarget(v: AgentView): Vec2 {
    if (kind === 'drone') {
      const home = hubs.find((h) => h.id === s.hubId) ?? nearestHub(hubs, pos);
      const hp = home?.pos ?? s.home;
      // Home hub out of cell coverage while the towers are up: wait where a van can reach me by phone instead,
      // and fly home only to charge (hubs charge drones; a parked drone does not).
      if (!parkFor || parkFor.home !== hp.x * 1e6 + hp.y) parkFor = { home: hp.x * 1e6 + hp.y, spot: phoneSpot(hp, hubs) };
      const park = towersUp() ? parkFor.spot : null;
      if (battery < PARK_MIN_BATTERY) charging = true;
      else if (battery >= PARK_FULL_BATTERY) charging = false;
      return park && !charging ? park : hp;
    }
    // Vans shuttle store <-> hub (collecting requests at the hub, loading at the store) and wait one
    // re-send period at each end. Motorbikes and boats ride their loop past their clinics without stopping.
    const loop = s.patrol?.length ? s.patrol : [s.home];
    if (direct()) {
      // Towers up: requests reach my store by phone, so an empty van simply waits at its store for the next load.
      patrolIdx = 0;
      dwellUntil = null;
      return loop[0];
    }
    const wp = loop[patrolIdx % loop.length];
    const stalled = route !== null && dist(route.target, wp) < 1 && v.t - route.since > 2 * v.dt && dist(prevPos, pos) < 0.01;
    if (dist(pos, wp) <= TRANSFER_RADIUS || stalled) {
      if (kind === 'van' && loop.length > 1) {
        // At the store with cell signal, requests arrive by phone: wait there for a load instead of driving
        // to the hub empty. Without signal (network down), shuttle to the hub to pick up mule-carried requests.
        const atStore = patrolIdx % loop.length === 0;
        const wait = atStore && v.cellSignal ? VAN_STORE_WAIT_SEC : RESEND_EVERY;
        dwellUntil ??= v.t + wait;
        if (atStore && !v.cellSignal) dwellUntil = Math.min(dwellUntil, v.t + RESEND_EVERY);
        if (v.t < dwellUntil) return wp;
        dwellUntil = null;
      }
      if (loop.length > 1) patrolIdx += 1;
    }
    return loop[patrolIdx % loop.length];
  }

  function target(v: AgentView): Vec2 {
    // a. an agreed hand-off: go to the meeting point; if I'm there and they aren't, the more mobile one closes the gap
    const agreed = [...deals.values()].filter((d) => d.accepted).sort((a, b) => byUrgency(a.label, b.label));
    for (const d of agreed) {
      const n = v.neighbours.find((x) => x.id === d.partner);
      const atMeet = dist(pos, d.meet) <= TRANSFER_RADIUS;
      if (atMeet && n && n.dist > TRANSFER_RADIUS && (kind === 'drone' || (d.role === 'give' && n.kind !== 'drone'))) return n.pos;
      return d.meet;
    }
    // b. a clinic proved itself: drive to it
    for (const [pkg, clinic] of clinicFor) {
      const n = v.neighbours.find((x) => x.id === clinic);
      const l = held.get(pkg)?.box.label;
      if (l) return n?.pos ?? v.map.cellCenter(l.destCell);
    }
    // c. carrying boxes: most urgent first
    const boxes = [...held.values()].map((c) => c.box.label).sort(byUrgency);
    const l = boxes[0];
    if (l) {
      const dest = v.map.cellCenter(l.destCell);
      if (kind === 'drone' && !droneCanCarry(battery, pos, pos, dest, hubs)) return nearestHub(hubs, pos)?.pos ?? s.home;
      // Direct trip: drive toward the clinic myself; a drone that beats me takes the box on the way (plan()).
      if (direct()) {
        const clinic = v.neighbours.find((n) => n.kind === 'clinic' && v.map.cellOf(n.pos) === l.destCell);
        return clinic?.pos ?? dest;
      }
      if (kind === 'van' && !vanAlone && !vanShouldDeliver(l.deadline, v.t, v.map.eta('van', pos, dest))) {
        // Wait one re-send period at the store to batch boxes, unless something is urgency 3.
        if (atStoreSince !== null && v.t - atStoreSince < RESEND_EVERY && l.urgency < 3) return pos;
        // Then my own hub (the shortest leg, so I'm back at the store soon); drones and bikes take it from there.
        return (hubs.find((h) => h.id === s.hubId) ?? nearestHub(hubs, dest))?.pos ?? dest;
      }
      const clinic = v.neighbours.find((n) => n.kind === 'clinic' && v.map.cellOf(n.pos) === l.destCell);
      return clinic?.pos ?? dest;
    }
    if (relay) return relay.pos;
    if (myPost) return myPost.post.pos;
    return idleTarget(v);
  }

  function move(v: AgentView, out: Action[]): void {
    const goal = target(v);
    if (route && dist(route.target, goal) <= TRANSFER_RADIUS / 2) return;      // already heading there
    if (dist(pos, goal) < 1) {
      if (route) out.push({ type: 'stop' });
      route = { target: goal, path: [], since: v.t };
      return;
    }
    const path = v.map.route(kind, pos, goal);
    route = { target: goal, path: path.length ? path : [goal], since: v.t };
    out.push({ type: 'moveTo', path: route.path });
  }

  function heading(v: AgentView): CellId[] {
    const here = v.map.cellOf(pos);
    const cells: CellId[] = [];
    for (const p of route?.path ?? []) {
      const c = v.map.cellOf(p);
      if (c !== here && !cells.includes(c)) cells.push(c);
      if (cells.length === 3) break;
    }
    return cells;
  }

  return {
    id: s.id,
    kind: s.kind,
    async tick(v: AgentView): Promise<Action[]> {
      const out: Action[] = [];
      prevPos = pos;
      pos = v.pos;
      battery = v.battery;
      hubs = v.map.hubs();
      for (const n of v.neighbours) if (n.kind === 'clinic' && !clinicsKnown.has(n.id)) clinicsKnown.set(n.id, { x: Math.round(n.pos.x), y: Math.round(n.pos.y) });
      if (v.cellSignal) lastSignalT = v.t;
      else if (inCoverage(pos, 100)) lastOutageT = v.t;      // in town, yet no signal: the towers are down
      const cell = v.map.cellOf(pos);
      if (kind === 'van') for (const n of v.neighbours) if (n.kind === 'store') stores.set(n.id, n.pos);
      if (kind === 'van') atStoreSince = [...stores.values()].some((p) => dist(p, pos) <= TRANSFER_RADIUS) ? (atStoreSince ?? v.t) : null;
      if (kind === 'van' && atStoreSince !== null) {
        if (storeSignal !== v.cellSignal) {
          out.push(log(v.cellSignal
            ? "Cell signal at my store: boxes go out direct, handed to drones as soon as I am out of the stores' earshot."
            : 'No cell signal at my store: shuttling store to hub, where drones and bikes meet me.'));
        }
        storeSignal = v.cellSignal;
      }
      if (!v.inventory.length) release = null;
      if (kind === 'van' && !direct()) {
        const atHub = hubs.some((h) => dist(h.pos, pos) <= MEET_OFFSET[1]);
        if (!v.inventory.length) hubSince = null;
        else if (atHub && hubSince === null) hubSince = v.t;
        // Nobody else in range for a whole re-send period: take the boxes on myself rather than wait.
        if (hubSince !== null && v.t - hubSince >= RESEND_EVERY && v.t - lastHelper >= RESEND_EVERY && !vanAlone) {
          vanAlone = true;
          out.push(log(`No drone or bike with room in range of the hub for ${RESEND_EVERY} s; driving my boxes on myself.`));
        } else if (hubSince !== null && v.t - hubSince >= VAN_HUB_WAIT_SEC && !vanAlone) {
          // Helpers are around but busy: boxes sitting at the hub help nobody. Drive them on, still handing
          // off on the way whenever a drone or bike beats my ETA (PLAN 3.5).
          vanAlone = true;
          out.push(log(`Waited ${Math.round((v.t - hubSince) / 60)} min at the hub with drones and bikes busy; driving my ${v.inventory.length} box(es) on myself.`));
        }
        if (hubSince === null) vanAlone = false;
      }

      if (v.inventory.length || held.size) await checkHold(v, out, cell);
      smallestHeld = held.size ? Math.min(...[...held.values()].map((c) => units(c.box.label))) : 1;
      muleLog = [];
      muleOut = out;
      muleCell = cell;
      // Beacons (most of the traffic) skip the guard: they are never rate-limited and carry no nonce.
      const rest: Msg[] = [];
      for (const m of v.inbox) if (m.kind !== 'beacon' || m.from === s.id || !beaconFast(m, v.t)) rest.push(m);
      if (rest.length) for (const m of await guard.admit(rest, v.t, cell, out)) if (!beaconFast(m, v.t)) await onMsg(m, v, out, cell);
      if (muleLog.length) out.push(log(`Carrying request${muleLog.length > 1 ? 's' : ''} ${muleLog.join(', ')} toward the stores (sealed, I can't read it).`));

      for (const [pkg, d] of deals) {
        if (v.t <= d.expires) continue;
        deals.delete(pkg);
        out.push(log(d.accepted
          ? `Hand-off of box ${pkg} with ${d.partner} did not happen in time; meeting point wiped.`
          : `No answer from ${d.partner} about box ${pkg}; keeping it.`));
      }
      if (v.t - lastExpire >= 5) {                             // lifetimes are minutes to hours: checking every 5 s is plenty
        lastExpire = v.t;
        mule.expire(v.t);
        confirms.expire(v.t);
        claims.expire(v.t);
      }

      if (v.t - lastBeacon >= BEACON_EVERY) { swarmStep(v, out); standingPost(v, out); }
      if (v.t - lastBeacon >= BEACON_EVERY) {
        lastBeacon = v.t;
        const myClaims: PostClaim[] = [...postClaims.values()].filter((c) => c.by !== s.id && v.t - c.t <= POST_CLAIM_TTL);
        if (myPost) myClaims.push({ post: myPost.post.id, by: s.id, since: myPost.since, t: v.t });
        const beacon: Beacon & { cert: Cert | null; battery: number; clinics: { id: NodeId; x: number; y: number }[]; posts: PostClaim[]; idle: boolean } = {
          id: s.id, kind, pos, heading: heading(v), spareCapacity: myPost || relay ? 0 : Math.max(0, spare()),
          holding: [...held.values()].map((c) => ({ packageId: c.box.label.packageId, destCell: c.box.label.destCell, urgency: c.box.label.urgency, size: c.box.label.size })),
          cert: s.cert,
          battery,                                             // so nobody offers a box to a drone that can't fly it
          clinics: [...clinicsKnown].map(([id, p]) => ({ id, x: p.x, y: p.y })),   // clinics are public (PLAN 13 #18)
          posts: myClaims,
          idle: !held.size && !deals.size && !myPost && !relay && !charging,
          swarm: swarmBeacon({
            role, dest: [...held.values()].map((c) => c.box.label).sort(byUrgency)[0]?.destCell ?? null,
            vel, alt: Math.round(alt), relaySlot: relay?.id ?? (myPost ? myPost.post.id : null), net,
          }),
        };
        out.push(guard.beacon(beacon));
      }
      const ids = v.neighbours.map((n) => n.id);
      const gotSignal = v.cellSignal && !hadSignal;
      hadSignal = v.cellSignal;
      // A request I just picked up goes out at once if I have signal (it reaches the stores by phone).
      if (mule.due(v.t, ids, gotSignal || (v.cellSignal && muleLog.length > 0))) out.push(await guard.signed('request', '*', { items: mule.values() }));
      const period = v.cellSignal ? RESEND_WITH_SIGNAL : RESEND_EVERY;
      if (confirms.due(v.t, ids, gotSignal, period)) out.push(await guard.signed('receipts', '*', { items: confirms.values() }));
      if (claims.due(v.t, ids, gotSignal, period)) out.push(await guard.signed('claim', '*', { claims: claims.values() }));

      if (v.t - lastPlan >= BEACON_EVERY) {
        lastPlan = v.t;
        if (held.size) await plan(v, out);
      }
      if (held.size) await lastMile(v, out, cell);
      transfers(v, out);
      move(v, out);
      if (kind === 'drone') flight(v, out);
      else if (v.t - lastStatus >= 5) {
        lastStatus = v.t;
        role = held.size || deals.size ? 'courier' : 'idle';
        out.push({ type: 'status', role });
      }
      return out;
    },

    /** PLAN 3.9: labels, hubs, live meeting points and one next hop. Vans also know their stores. Nothing else. */
    dump(): BreachDump {
      const knownLocations: BreachDump['knownLocations'] = [
        ...(kind === 'van' ? [...stores.values()] : []).map((p) => ({ what: 'store' as const, pos: p })),   // only vans ever know a store
        ...hubs.map((h) => ({ what: 'hub' as const, pos: h.pos })),
        ...[...deals.values()].map((d) => ({ what: 'handoff' as const, pos: d.meet })),
      ];
      const next = [...deals.values()][0]?.partner ?? [...clinicFor.values()][0] ?? null;
      return {
        nodeId: s.id,
        readableLabels: [...held.values()].map((c) => c.box.label),
        knownLocations,
        knownStockLevels: 0,
        readableBeneficiaryNotes: [],
        nextHop: next,
      };
    },

    receipts(): Receipt[] {
      return [...ledger.values()];
    },
  };
}
