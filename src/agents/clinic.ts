// Clinic brain (PLAN 3.4 steps 1-2, 7-8, 13 #10). Makes sealed requests with counts only, answers the signed
// last mile, opens each box against its sealed manifest, re-requests after a missed deadline, counts duplicates.
import { CATALOGUE, COUNTS, DEMAND, SIZE_FOR_KG, WEIGHT_TOLERANCE_KG } from '../contracts/config';
import type {
  Action, Agent, AgentSetup, AgentView, BreachDump, CarriedBox, CellId, Manifest, Msg, Receipt, RequestEnvelope, Urgency,
} from '../contracts/types';
import { open, seal, sign } from '../privacy/core';
import {
  ANY_ROLE, type CallBody, CARRIERS, type DemandOrder, Guard, Outbox, type ReplyBody, envelopeKey, envelopePayload, itemsOf, log,
  receiptKey, RESEND_WITH_SIGNAL, screenText, signReceipt, verifyEnvelope,
} from './common';
import { demandAnomaly } from './routing';

interface Req { manifest: Manifest; env: RequestEnvelope; filled: boolean }

/** A clinic agent also reports how many boxes arrived for requests it had already had filled (PLAN 13 #10). */
export interface ClinicAgent extends Agent { duplicates(): number }

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Seeded demand: a few new admissions, mostly therapeutic food. Counts only, never names. */
export function makeManifest(rng: () => number, requestId: string, order?: DemandOrder): Manifest {
  if (order?.items?.length && order.beneficiaryNote) {     // scripted demand from the engine, already detailed
    const declaredKg = round(order.declaredKg ?? order.items.reduce((s, i) => s + (CATALOGUE[i.code]?.kg ?? 0) * i.qty, 0));
    return { requestId, items: order.items.map((i) => ({ ...i })), declaredKg, beneficiaryNote: order.beneficiaryNote };
  }
  const kids = order?.children ?? 3 + Math.floor(rng() * 13);
  const fresh = Math.floor(rng() * Math.min(kids, 6));
  const items: Manifest['items'] = [{ code: 'RUTF-30', qty: kids >= 10 ? 2 : 1 }];
  if (rng() < 0.5) items.push({ code: 'ORS-ZN', qty: 1 });
  if (rng() < 0.3) items.push({ code: 'AMOX', qty: 1 });
  if (fresh > 0 && rng() < 0.5) items.push({ code: 'MUAC', qty: 1 });
  if (rng() < 0.1) items.push({ code: 'VAX-MR', qty: 1 });
  const declaredKg = round(items.reduce((s, i) => s + CATALOGUE[i.code].kg * i.qty, 0));
  return { requestId, items, declaredKg, beneficiaryNote: `${kids} children 6-59 months, ${fresh} new` };
}

const pickUrgency = (r: number): Urgency => (r < 0.25 ? 3 : r < 0.6 ? 2 : 1);

export function createClinic(s: AgentSetup): ClinicAgent {
  const guard = new Guard(s);
  const requests = new Map<string, Req>();      // requestId -> my request (latest attempt)
  const outbox = new Outbox<RequestEnvelope>();  // open requests, re-sent until filled or re-requested
  const confirms = new Outbox<Receipt>();        // 'delivered' receipts, carried back by mules
  const seen = new Set<string>();                // packageIds already processed
  const ledger = new Map<string, Receipt>();
  const kgHistory: number[] = [];
  const relayed = new Set<string>();             // other clinics' requests I passed on over the cell network
  let myCell: CellId = '';
  let n = 0;
  let dupes = 0;
  const shortId = s.id.replace(/^clinic-?/, 'c');

  async function envelope(req: Omit<RequestEnvelope, 'sig' | 'sealed' | 'replyPub' | 'clinicId' | 'clinicSignPub' | 'clinicCert'>, m: Manifest): Promise<RequestEnvelope> {
    const body: Omit<RequestEnvelope, 'sig'> = {
      ...req, replyPub: s.keys.sealPub, clinicId: s.id, clinicSignPub: s.keys.signPub, clinicCert: s.cert ?? undefined,
      sealed: await seal(m, s.storeSealPub),       // only the store network can read the manifest
    };
    return { ...body, sig: await sign(envelopePayload(body as RequestEnvelope), s.keys.signPriv) };
  }

  async function newRequest(v: AgentView, out: Action[], urgency: Urgency, order?: DemandOrder): Promise<void> {
    const requestId = `r-${shortId}-${++n}`;
    const m = makeManifest(s.rng, requestId, order);
    const cold = m.items.some((i) => CATALOGUE[i.code].cold);
    const env = await envelope({
      requestId, attempt: 1, urgency, size: SIZE_FOR_KG(m.declaredKg), cold, destCell: myCell,
      deadline: v.t + DEMAND.deadlineSec[urgency], createdAt: v.t,
    }, m);
    if (demandAnomaly(kgHistory, m.declaredKg)) {
      guard.raise(out, 'demand-anomaly', s.id, v.t, myCell,
        `${s.id} is asking for ${m.declaredKg.toFixed(1)} kg, over ${DEMAND.demandAnomalyX}x its usual volume: flagged for a human check`);
    }
    kgHistory.push(m.declaredKg);
    requests.set(requestId, { manifest: m, env, filled: false });
    outbox.put(envelopeKey(env), env, env.deadline);
    out.push(await guard.signed('request', '*', { items: [env] }));
    out.push(log(`New request ${requestId}: ${m.beneficiaryNote}, urgency ${urgency}, sealed to the stores.`));
  }

  async function onCall(m: Msg, v: AgentView, out: Action[]): Promise<void> {
    // Signature first, so a call with a tampered cell or request id is caught rather than silently ignored.
    const why = await guard.screen(m, v.t, CARRIERS);
    if (why) {
      guard.raise(out, why, m.from, v.t, myCell, screenText(why, m, 'carrier'));
      return;
    }
    const b = m.body as CallBody;
    if (b.destCell !== myCell || !requests.has(b.requestId)) return;    // not for me: stay silent
    const reply: ReplyBody = { packageId: b.packageId, requestId: b.requestId, challenge: b.challenge, clinicId: s.id };
    out.push(await guard.signed('lastmile-reply', m.from, reply));
    out.push(log(`Answered ${m.from}'s last-mile call for ${b.requestId} with a signed reply.`));
  }

  /**
   * A neighbouring clinic with no signal (a remote village) is in radio range and I have signal: pass its sealed
   * request on over the cell network once, so it reaches the stores now instead of waiting for a passing mule.
   * I can't read it (sealed to the stores); its own signature is checked so forgeries don't spread.
   */
  async function relayRequests(m: Msg, v: AgentView, out: Action[]): Promise<void> {
    if (!v.cellSignal || m.from === s.id) return;
    const items = itemsOf<RequestEnvelope>(m.body);
    const fresh = (items ?? []).filter((e) => !!e && typeof e.requestId === 'string' && e.clinicId !== s.id &&
      e.deadline > v.t && !relayed.has(envelopeKey(e)) && v.neighbours.some((n) => n.id === e.clinicId));
    if (!fresh.length) return;
    if (await guard.screen(m, v.t, ANY_ROLE, false)) return;
    const ok: RequestEnvelope[] = [];
    for (const e of fresh) {
      relayed.add(envelopeKey(e));
      if (await verifyEnvelope(e)) ok.push(e);
    }
    if (!ok.length) return;
    out.push(await guard.signed('request', '*', { items: ok }));
    out.push(log(`Passed on ${ok.map((e) => e.requestId).join(', ')} from ${m.from} over the cell network (sealed, I can't read it).`));
  }

  /** Open the box, weigh it against the sealed manifest and its passport, sign the delivery, consume. */
  async function receive(c: CarriedBox, v: AgentView, out: Action[]): Promise<void> {
    const box = c.box;
    const pkg = box.label.packageId;
    const pp = c.passport;
    const last = pp[pp.length - 1];
    const from = last?.to ?? box.packedBy;
    let manifest: Manifest;
    try {
      manifest = await open<Manifest>(box.sealed, s.keys.sealPriv);
    } catch {
      out.push(log(`Box ${pkg} does not open with my key: it is not for this clinic. Holding it for pickup.`));
      return;
    }
    // A skim by the last carrier shows up like any hand-off: my scale against the passport.
    if (last && Math.abs(c.measuredKg - last.measuredKg) > WEIGHT_TOLERANCE_KG) {
      const lost = last.measuredKg - c.measuredKg;
      guard.raise(out, 'weight-mismatch', from, v.t, myCell,
        `Box ${pkg} lost ${lost.toFixed(2)} kg while held by ${from}: clinic scale ${c.measuredKg.toFixed(2)} kg, passport ${last.measuredKg.toFixed(2)} kg`,
        { packageId: pkg, kg: round(lost) });
    }
    // Against the sealed manifest: catches packing short and carriers who agreed on a fake weight.
    const short = manifest.declaredKg - c.measuredKg;
    if (short > WEIGHT_TOLERANCE_KG) {
      const firstShort = pp.findIndex((r) => manifest.declaredKg - r.measuredKg > WEIGHT_TOLERANCE_KG);
      let suspect = from;
      let text = `Box ${pkg} arrived ${short.toFixed(2)} kg short of its sealed manifest; lost while held by ${from}`;
      if (firstShort === 0) {
        suspect = box.packedBy;
        text = `Box ${pkg} short at ${s.id} by ${short.toFixed(2)} kg from its very first weigh-in; packer key ${box.packedBy} named`;
      } else if (firstShort > 0) {
        suspect = pp[firstShort].from;
        text = `${s.id} found ${short.toFixed(2)} kg short in box ${pkg}; loss pinned between ${suspect} and ${s.id}`;
      }
      guard.raise(out, 'short-delivery', suspect, v.t, myCell, text, { packageId: pkg, kg: round(short) });
    }
    const r = await signReceipt({
      packageId: pkg, requestId: box.label.requestId, attempt: box.label.attempt, kind: 'delivered',
      from, to: s.id, t: v.t, seq: pp.length, cell: myCell, measuredKg: c.measuredKg,
    }, s.keys.signPriv);
    out.push({ type: 'stamp', packageId: pkg, receipt: r });
    out.push({ type: 'consume', packageId: pkg });
    for (const p of pp) ledger.set(receiptKey(p), p);
    ledger.set(receiptKey(r), r);
    confirms.put(receiptKey(r), r, v.t + DEMAND.deadlineSec[1]);
    out.push(await guard.signed('receipts', from, { items: [r] }));

    const req = requests.get(manifest.requestId);
    if (req?.filled) {
      dupes += 1;
      out.push(log(`Duplicate: box ${pkg} is for ${manifest.requestId}, which was already filled. Counted (${dupes} so far).`));
    } else {
      if (req) {
        req.filled = true;
        for (const k of outbox.keys()) if (k.startsWith(`${manifest.requestId}#`)) outbox.delete(k);
      }
      out.push(log(`Delivered: box ${pkg} for ${manifest.requestId}, ${c.measuredKg.toFixed(2)} kg, checked against the sealed manifest.`));
    }
  }

  /** PLAN 3.4 step 8: deadline passed with nothing delivered, so ask again (attempt + 1, one level more urgent). */
  async function reRequest(v: AgentView, out: Action[]): Promise<void> {
    for (const [id, req] of [...requests].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (req.filled || v.t < req.env.deadline) continue;
      const urgency = Math.min(3, req.env.urgency + 1) as Urgency;
      const { sig: _s, sealed: _x, replyPub: _r, clinicId: _c, clinicSignPub: _p, clinicCert: _k, ...rest } = req.env;
      const env = await envelope({ ...rest, attempt: req.env.attempt + 1, urgency, deadline: v.t + DEMAND.deadlineSec[urgency], createdAt: v.t }, req.manifest);
      outbox.delete(envelopeKey(req.env));
      req.env = env;
      outbox.put(envelopeKey(env), env, env.deadline);
      out.push(await guard.signed('request', '*', { items: [env] }));
      out.push(log(`${id} missed its deadline with nothing delivered: re-requesting (attempt ${env.attempt}, urgency ${urgency}).`));
    }
  }

  const agent: ClinicAgent = {
    id: s.id,
    kind: s.kind,
    async tick(v: AgentView): Promise<Action[]> {
      const out: Action[] = [];
      myCell = v.map.cellOf(v.pos);

      // Demand comes only from the engine's seeded scenario ('order' from 'scenario'), so mesh and central
      // see the same admissions for the same seed (lead integration: one owner for demand).

      for (const m of await guard.admit(v.inbox, v.t, myCell, out)) {
        if (m.kind === 'lastmile-call') await onCall(m, v, out);
        else if (m.kind === 'request' && m.hops > 0) await relayRequests(m, v, out);
        else if (m.kind === 'order' && m.to === s.id && m.from === 'scenario') {   // scripted demand from the engine
          const o = m.body as DemandOrder;
          if (o?.type === 'demand') await newRequest(v, out, o.urgency ?? pickUrgency(s.rng()), o);
        }
      }

      for (const c of v.inventory) {
        const pkg = c.box.label.packageId;
        if (seen.has(pkg)) continue;
        seen.add(pkg);
        await receive(c, v, out);
      }

      await reRequest(v, out);
      outbox.expire(v.t);
      confirms.expire(v.t);
      const ids = v.neighbours.map((x) => x.id);
      if (outbox.due(v.t, ids)) out.push(await guard.signed('request', '*', { items: outbox.values() }));
      if (confirms.due(v.t, ids, false, v.cellSignal ? RESEND_WITH_SIGNAL : undefined)) out.push(await guard.signed('receipts', '*', { items: confirms.values() }));
      return out;
    },

    /** A breached clinic leaks its own place and its own counts. Names never exist in the system at all. */
    dump(): BreachDump {
      return {
        nodeId: s.id,
        readableLabels: [],
        knownLocations: [{ what: 'clinic', pos: s.home }],
        knownStockLevels: 0,
        readableBeneficiaryNotes: [...requests.values()].filter((r) => !r.filled).map((r) => r.manifest.beneficiaryNote),
        nextHop: null,
      };
    },

    receipts(): Receipt[] {
      return [...ledger.values()];
    },

    duplicates(): number {
      return dupes;
    },
  };
  return agent;
}
