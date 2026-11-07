// Store brain (PLAN 3.4 steps 4-5, 12 #8, 13 #4). Opens requests, claims them, packs sealed boxes, loads vans.
import { CAPACITY, RESEND_EVERY, TRANSFER_RADIUS } from '../contracts/config';
import type {
  Action, Agent, AgentSetup, AgentView, Beacon, BreachDump, CellId, Label, Manifest, Msg, NodeId, Receipt,
  RequestEnvelope, SealedBox,
} from '../contracts/types';
import { open, seal, sign } from '../privacy/core';
// certAllows comes from ./common (same check, each cert verified once)
import {
  ANY_ROLE, certAllows, type ClaimRecord, Guard, type LoadBody, type ProposeBody, envelopeKey, itemsOf, log, makeClaim, receiptKey,
  screenText, verifyClaim, verifyEnvelope,
} from './common';
import { byUrgency, demandAnomaly, units } from './routing';

interface Open { env: RequestEnvelope; manifest: Manifest; claimT: number; packAt: number; cost: number }

/** Deterministic tie-break rank for simultaneous claims (FNV-1a of requestId + store id, then fmix32). */
export function tieRank(requestId: string, store: NodeId): string {
  let h = 0x811c9dc5;
  for (const ch of `${requestId}|${store}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  // Finalizer (murmur3 fmix32) so ids that differ only in their last character still spread evenly.
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return `${h.toString(16).padStart(8, '0')}|${store}`;
}

export function createStore(s: AgentSetup): Agent {
  const guard = new Guard(s);
  const pending = new Map<string, Open>();             // requestId#attempt -> opened, claimed, not packed yet
  const handled = new Set<string>();                   // requestId#attempt packed here, claimed elsewhere, or refused
  const filled = new Set<string>();                    // requestIds confirmed delivered
  const envByBox = new Map<string, RequestEnvelope>(); // packageId -> request, passed to the van with the box
  const offered = new Map<string, { van: NodeId; t: number }>();
  const vans = new Map<NodeId, { spare: number; t: number }>();
  const volume = new Map<NodeId, number[]>();          // kg per request, per clinic (demand anomaly check)
  const ledger = new Map<string, Receipt>();
  let stock: Label[] = [];
  let lastVan: NodeId | null = null;

  /** Box ids are random-looking so a label never reveals which store packed it or how many it has packed. */
  const newPackageId = () => `p-${Math.floor(s.rng() * 36 ** 7).toString(36).padStart(7, '0')}`;

  const isNew = (e: RequestEnvelope, t: number) =>
    !!e && typeof e.requestId === 'string' && e.deadline > t &&
    !pending.has(envelopeKey(e)) && !handled.has(envelopeKey(e)) && !filled.has(e.requestId);

  async function openRequest(e: RequestEnvelope, v: AgentView, cell: CellId, out: Action[]): Promise<void> {
    const key = envelopeKey(e);
    handled.add(key);                                  // whatever happens next, never look at this one again
    if (!(await verifyEnvelope(e))) {
      guard.raise(out, 'bad-signature', e.clinicId, v.t, cell, `Request dropped: bad signature on ${e.requestId} (claims to be from ${e.clinicId})`);
      return;
    }
    if (guard.certsOn) {
      const ok = !!e.clinicCert && e.clinicCert.nodeId === e.clinicId &&
        (await certAllows(e.clinicCert, ['clinic'], e.clinicSignPub, s.authoritySignPubs, v.t));
      if (!ok) {
        guard.raise(out, 'no-cert', e.clinicId, v.t, cell, `Request dropped: no valid clinic certificate for ${e.clinicId}`);
        return;
      }
    }
    let manifest: Manifest;
    try {
      manifest = await open<Manifest>(e.sealed, s.storeSealPriv!);
    } catch {
      out.push(log(`Could not open request ${e.requestId}: not sealed to the store network key.`));
      return;
    }
    // PLAN 12 #4: unusual volume is flagged for a human; the box is still packed.
    const hist = volume.get(e.clinicId) ?? [];
    if (demandAnomaly(hist, manifest.declaredKg)) {
      guard.raise(out, 'demand-anomaly', e.clinicId, v.t, cell,
        `${e.clinicId} asked for ${manifest.declaredKg.toFixed(1)} kg, far above its usual volume: flagged for a human check`);
    }
    volume.set(e.clinicId, [...hist, manifest.declaredKg]);
    handled.delete(key);
    // My van's ETA to the clinic's cell: the nearest store should pack (ties only; earlier claims still win).
    const eta = v.map.eta('van', v.pos, v.map.cellCenter(e.destCell));
    const cost = Number.isFinite(eta) ? Math.round(eta) : 1e9;
    pending.set(key, { env: e, manifest, claimT: v.t, packAt: v.t + v.dt, cost });
    // Claim it so other stores that can hear me don't pack it too. Out of earshot, both pack: a counted duplicate.
    // Broadcast: stores in range hear it now, carriers carry it to the others (store ids are on every box anyway).
    const claim = await makeClaim(s, { requestId: e.requestId, attempt: e.attempt, claimT: v.t, sealedCost: await seal({ cost }, s.storeSealPub) });
    out.push(await guard.signed('claim', '*', { claims: [claim] }));
    out.push(log(`Opened request ${e.requestId} (attempt ${e.attempt}, urgency ${e.urgency}) and claimed it.`));
  }

  async function onRequest(m: Msg, v: AgentView, out: Action[]): Promise<void> {
    const cell = v.map.cellOf(v.pos);
    const items = itemsOf<RequestEnvelope>(m.body);
    const fresh = (items ?? []).filter((e) => isNew(e, v.t));
    const junk = !items || items.some((e) => !e || typeof e.requestId !== 'string');
    if (!fresh.length && !junk && !guard.suspicious(m)) return;   // mules repeat a lot: nothing new, nothing to check
    const why = await guard.screen(m, v.t, ANY_ROLE, false);   // the clinic's cert is checked on the envelope itself
    if (why) return guard.raise(out, why, m.from, v.t, cell, screenText(why, m, 'sender'));
    for (const e of fresh) if (isNew(e, v.t)) await openRequest(e, v, cell, out);
  }

  async function onClaim(m: Msg, v: AgentView, out: Action[]): Promise<void> {
    const cell = v.map.cellOf(v.pos);
    const claims = (m.body as { claims?: ClaimRecord[] })?.claims;
    const fresh = Array.isArray(claims) ? claims.filter((c) => c && c.store !== s.id && !handled.has(envelopeKey(c))) : [];
    if (Array.isArray(claims) && !fresh.length && !guard.suspicious(m)) return;
    const why = await guard.screen(m, v.t, ANY_ROLE, false);           // a store, or a mule carrying it
    if (why) return guard.raise(out, why, m.from, v.t, cell, screenText(why, m, 'sender'));
    for (const c of fresh) {
      if (!s.storeIds.includes(c.store) || !(await verifyClaim(c, s, guard.certsOn, v.t))) {
        guard.raise(out, 'bad-signature', c.store, v.t, cell, `Ignored a claim for ${c.requestId}: not signed by a known store`);
        continue;
      }
      const key = envelopeKey(c);
      const mine = pending.get(key);
      // The earlier claim wins; on a tie (every store heard it at once over the phone network) a hash of
      // request + store picks the winner, so work spreads over all stores without revealing where any store is.
      // Both stores reach the same answer.
      const theirs = mine && c.claimT === mine.claimT ? await claimCost(c) : null;
      const tieWon = theirs !== null && mine && (theirs < mine.cost ||
        (theirs === mine.cost && tieRank(c.requestId, c.store) < tieRank(c.requestId, s.id)));
      if (mine && (c.claimT < mine.claimT || tieWon)) {
        pending.delete(key);
        out.push(log(`${c.store} claimed ${c.requestId} first; not packing it.`));
      }
      if (!mine || !pending.has(key)) handled.add(key);
    }
  }

  /** The other store's sealed cost (only stores hold the key). Unreadable or missing = treat as far away. */
  async function claimCost(c: ClaimRecord): Promise<number> {
    if (!c.sealedCost || !s.storeSealPriv) return 1e9;
    try {
      const { cost } = await open<{ cost: number }>(c.sealedCost, s.storeSealPriv);
      return typeof cost === 'number' ? cost : 1e9;
    } catch { return 1e9; }
  }

  async function pack(o: Open, out: Action[]): Promise<void> {
    const e = o.env;
    const label: Label = {
      packageId: newPackageId(), requestId: e.requestId, attempt: e.attempt, urgency: e.urgency,
      size: e.size, cold: e.cold, destCell: e.destCell, deadline: e.deadline,
    };
    const sealed = await seal(o.manifest, e.replyPub);                        // only the clinic can open it
    const auditorCopy = s.auditorSealPub ? await seal(o.manifest, s.auditorSealPub) : undefined;   // P1 #8
    const packSig = await sign({ label, sealed }, s.keys.signPriv);           // proves which store packed it
    const box: SealedBox = { label, sealed, auditorCopy, packedBy: s.id, packSig };
    envByBox.set(label.packageId, e);
    out.push({ type: 'spawnBox', box, kg: o.manifest.declaredKg });
    out.push(log(`Packed box ${label.packageId} for ${e.requestId} (urgency ${e.urgency}, size ${e.size}), sealed to the clinic's key.`));
  }

  /** Load parked vans, most urgent boxes first, up to each van's spare capacity. One message per van. */
  async function loadVans(v: AgentView, out: Action[]): Promise<void> {
    if (!stock.length) return;
    const parked = v.neighbours.filter((n) => n.kind === 'van' && n.dist <= TRANSFER_RADIUS).sort((a, b) => (a.id < b.id ? -1 : 1));
    const queue = [...stock].sort(byUrgency);
    for (const van of parked) {
      let room = vans.get(van.id)?.spare ?? CAPACITY.van;
      const load: ProposeBody[] = [];
      for (const l of [...queue]) {
        const o = offered.get(l.packageId);
        if (o && o.van === van.id && v.t - o.t < RESEND_EVERY) continue;     // already offered; give the engine time
        if (units(l) > room) continue;
        room -= units(l);
        queue.splice(queue.indexOf(l), 1);
        offered.set(l.packageId, { van: van.id, t: v.t });
        load.push({ packageId: l.packageId, label: l, meet: null, envelope: envByBox.get(l.packageId) });
      }
      vans.set(van.id, { spare: room, t: v.t });
      if (!load.length) continue;
      const body: LoadBody = { load };
      out.push(await guard.signed('handoff-propose', van.id, body));
      for (const p of load) out.push({ type: 'transfer', packageId: p.packageId, to: van.id });
      out.push(log(`Loading ${load.length} box(es) onto ${van.id}, most urgent first: ${load.map((p) => `${p.packageId} (u${p.label.urgency})`).join(', ')}.`));
      lastVan = van.id;
    }
  }

  return {
    id: s.id,
    kind: s.kind,
    async tick(v: AgentView): Promise<Action[]> {
      const out: Action[] = [];
      const cell = v.map.cellOf(v.pos);
      const nowStock = v.inventory.map((c) => c.box.label);
      for (const l of stock) {
        if (nowStock.some((x) => x.packageId === l.packageId)) continue;
        envByBox.delete(l.packageId);                  // loaded: forget its request
        offered.delete(l.packageId);
      }
      stock = nowStock;

      for (const m of await guard.admit(v.inbox, v.t, cell, out)) {
        if (m.kind === 'request') await onRequest(m, v, out);
        else if (m.kind === 'claim') await onClaim(m, v, out);
        else if (m.kind === 'beacon') {
          const b = m.body as Beacon;
          if (b?.kind === 'van' && b.id === m.from) vans.set(m.from, { spare: b.spareCapacity, t: v.t });
        } else if (m.kind === 'receipts') {
          const items = itemsOf<Receipt>(m.body) ?? [];
          const useful = items.filter((r) => r && typeof r.packageId === 'string' &&
            ((r.kind === 'delivered' && !filled.has(r.requestId)) || (r.from === s.id && !ledger.has(receiptKey(r)))));
          if (!useful.length && !guard.suspicious(m)) continue;
          const why = await guard.screen(m, v.t, ANY_ROLE, false);
          if (why) { guard.raise(out, why, m.from, v.t, cell, screenText(why, m, 'sender')); continue; }
          for (const r of useful) {
            if (r.kind === 'delivered') filled.add(r.requestId);
            if (r.from === s.id) ledger.set(receiptKey(r), r);   // a van's pickup receipt: proof I handed it over
          }
        }
      }

      for (const [key, o] of [...pending].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (o.packAt > v.t) continue;
        pending.delete(key);
        handled.add(key);
        await pack(o, out);
      }
      await loadVans(v, out);
      return out;
    },

    /** A breached store leaks its own location, its stock and the notes of requests it has opened but not packed. */
    dump(): BreachDump {
      return {
        nodeId: s.id,
        readableLabels: stock,
        knownLocations: [{ what: 'store', pos: s.home }],
        knownStockLevels: 1,
        readableBeneficiaryNotes: [...pending.values()].map((o) => o.manifest.beneficiaryNote),
        nextHop: lastVan,
      };
    },

    receipts(): Receipt[] {
      return [...ledger.values()];
    },
  };
}
