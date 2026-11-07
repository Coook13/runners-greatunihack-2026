// Small shared pieces for every mesh agent: message guard, outbox, receipt and envelope signing.
import { RATE_LIMIT_PER_MIN, RESEND_EVERY } from '../contracts/config';
import type {
  Action, AgentSetup, Alert, AlertKind, Cert, CellId, Label, Msg, MsgKind, NodeId, NodeKind, Receipt, RequestEnvelope, Sealed, Vec2,
} from '../contracts/types';
import { sign, verify } from '../privacy/core';
import { verifyCert } from '../privacy/certs';
import { NonceCache, RateLimiter, signMsg, verifyMsg } from '../privacy/guard';

/** Beacons use half of each node's message budget: with 60 a minute allowed, one beacon every 2 sim-seconds. */
export const BEACON_EVERY = 60 / (RATE_LIMIT_PER_MIN / 2);
/** Someone new in range triggers an early re-send, but at most every third of RESEND_EVERY (keeps under the rate limit). */
export const NEW_NEIGHBOUR_GAP = RESEND_EVERY / 3;
/** With cell signal a broadcast already reached everyone else with signal, so the regular re-send can wait longer. */
export const RESEND_WITH_SIGNAL = 10 * RESEND_EVERY;
export const CARRIERS: NodeKind[] = ['drone', 'motorbike', 'van', 'boat'];

/** Added to the body of every signed message so the receiver can check who sent it. */
export interface SignedBody { signPub: string; cert: Cert | null; fromKind: NodeKind }

// Message bodies the mesh agents exchange (Msg.body is `unknown` in the contract; these are WP2's shapes).
/** meetBy = sim time by which both sides should reach the meeting point (the slower one sets it). */
export interface ProposeBody { packageId: string; label: Label; meet: Vec2 | null; meetBy?: number; envelope?: RequestEnvelope }
/** A store loading a parked van sends one message per van per tick: no meeting, just the boxes' requests. */
export interface LoadBody { load: ProposeBody[] }
/** `declined` = a signed "no" (with the reason), so the giver can ask someone else at once instead of timing out. */
export interface AcceptBody { packageId: string; meet: Vec2 | null; declined?: string }
export interface CallBody { packageId: string; requestId: string; destCell: CellId; challenge: string }
export interface ReplyBody { packageId: string; requestId: string; challenge: string; clinicId: NodeId }
export interface ClaimBody {
  requestId: string; attempt: number; claimT: number;
  /** The claiming store's van ETA to the request's cell, sealed to the store-network key: other stores use it to
   *  break ties (nearest store packs), mules carrying the claim can't read it, so it reveals nothing about where stores are. */
  sealedCost?: Sealed;
}
/** A store's claim, signed by the store itself so any mule can carry it to stores out of earshot. */
export interface ClaimRecord extends ClaimBody { store: NodeId; signPub: string; cert: Cert | null; sig: string }
/** Engine -> clinic scripted demand (WorldEvent 'demand'), an 'order' message from 'scenario'. Detail is optional. */
export interface DemandOrder {
  type: 'demand'; urgency?: 1 | 2 | 3; children?: number;
  items?: { code: string; qty: number }[]; declaredKg?: number; beneficiaryNote?: string;
}

/** Re-sent data travels as one signed message: { items: [...] } plus the SignedBody fields. */
export interface Bundle<T> { items: T[] }
/** Items of a bundle, or null when the body is not a bundle at all (junk or tampered). */
export const itemsOf = <T>(body: unknown): T[] | null =>
  body && typeof body === 'object' && Array.isArray((body as Bundle<T>).items) ? (body as Bundle<T>).items : null;
export const ANY_ROLE: NodeKind[] = ['drone', 'motorbike', 'van', 'boat', 'store', 'clinic', 'dispatch'];
export const log = (text: string): Action => ({ type: 'log', text });

// ---------- certificate checks, verified once per certificate ----------
/**
 * Same answer as privacy/certs certAllows, but each distinct certificate's 2-of-3 authority signatures are
 * checked once and remembered (a cert is immutable: same bytes, same answer; expiry is still checked every time).
 * Every node meets the same ~40 certs thousands of times, so this removes most of the crypto in a run.
 */
const certMemo = new Map<string, boolean>();
export async function certAllows(
  cert: Cert | null | undefined, roles: NodeKind[], signPub: string, authoritySignPubs: string[], now: number,
): Promise<boolean> {
  if (!cert || !roles.includes(cert.role) || cert.signPub !== signPub || !(cert.expires > now) || !Array.isArray(cert.sigs)) return false;
  const key = `${cert.nodeId}|${cert.role}|${cert.signPub}|${cert.expires}|${cert.sigs.map((x) => `${x?.authority}:${x?.sig}`).join(',')}|${authoritySignPubs.join(',')}`;
  let ok = certMemo.get(key);
  if (ok === undefined) {
    ok = await verifyCert(cert, authoritySignPubs, now);
    if (certMemo.size > 5000) certMemo.clear();
    certMemo.set(key, ok);
  }
  return ok;
}

// ---------- receipts ----------
/** The receiver signs every field except the two signatures (same bytes the ledger verifies). */
export const receiptPayload = (r: Receipt | Omit<Receipt, 'sigTo'>): Omit<Receipt, 'sigTo' | 'sigFrom'> => {
  const { sigTo: _a, sigFrom: _b, ...rest } = r as Receipt;
  return rest;
};
export async function signReceipt(r: Omit<Receipt, 'sigTo' | 'sigFrom'>, priv: CryptoKey): Promise<Receipt> {
  return { ...r, sigTo: await sign(receiptPayload(r), priv) };
}
export const receiptKey = (r: Receipt): string => `${r.packageId}:${r.kind}:${r.from}:${r.to}:${r.seq}`;

// ---------- request envelopes ----------
export const envelopePayload = (e: RequestEnvelope): Omit<RequestEnvelope, 'sig'> => {
  const { sig: _s, ...rest } = e;
  return rest;
};
export const envelopeKey = (e: Pick<RequestEnvelope, 'requestId' | 'attempt'>): string => `${e.requestId}#${e.attempt}`;

/** The clinic's own signature over the envelope. Says nothing about whether the clinic is real (that's the cert). */
export async function verifyEnvelope(e: RequestEnvelope): Promise<boolean> {
  if (!e || typeof e.sig !== 'string' || typeof e.clinicSignPub !== 'string') return false;
  return verify(envelopePayload(e), e.sig, e.clinicSignPub);
}

// ---------- claims ----------
const claimPayload = (c: ClaimBody & { store: NodeId }) => ({
  requestId: c.requestId, attempt: c.attempt, claimT: c.claimT, store: c.store, ...(c.sealedCost ? { sealedCost: c.sealedCost } : {}),
});
export const claimKey = (c: ClaimRecord): string => `${envelopeKey(c)}@${c.store}`;

export async function makeClaim(s: AgentSetup, c: ClaimBody): Promise<ClaimRecord> {
  const rec = { ...c, store: s.id };
  return { ...rec, signPub: s.keys.signPub, cert: s.cert, sig: await sign(claimPayload(rec), s.keys.signPriv) };
}

/** Signed by the key it carries, and (with certs on) that key belongs to a certified store. */
export async function verifyClaim(c: ClaimRecord, s: AgentSetup, certsOn: boolean, t: number): Promise<boolean> {
  if (!c || typeof c.sig !== 'string' || typeof c.signPub !== 'string' || typeof c.store !== 'string') return false;
  if (!(await verify(claimPayload(c), c.sig, c.signPub))) return false;
  if (!certsOn) return true;
  return !!c.cert && c.cert.nodeId === c.store && certAllows(c.cert, ['store'], c.signPub, s.authoritySignPubs, t);
}

// ---------- message guard (PLAN 12 #3-6, #9) ----------
export class Guard {
  private nonces = new NonceCache();
  private limiter = new RateLimiter();
  private lastAlert = new Map<string, number>();
  private knownKeys = new Map<NodeId, string>();          // sender -> signing key that last verified

  constructor(private s: AgentSetup) {}

  /**
   * Cheap test (no crypto) for "this needs a full check even though it repeats known content":
   * malformed signed fields, an unknown role, or a key that differs from the one this sender used before.
   */
  suspicious(m: Msg): boolean {
    const b = m.body as Partial<SignedBody> | null;
    if (!b || typeof b !== 'object' || typeof b.signPub !== 'string' || !b.fromKind || !ANY_ROLE.includes(b.fromKind)) return true;
    const known = this.knownKeys.get(m.from);
    return known !== undefined && known !== b.signPub;
  }

  /** Certificates are only enforced once setup hands out certs (P1). Before that, signatures still are. */
  get certsOn(): boolean { return this.s.cert !== null && this.s.authoritySignPubs.length >= 2; }

  /** A signed message: body gets my public key, my cert and my kind, then the whole thing is signed. */
  async signed(kind: MsgKind, to: NodeId | '*', body: object): Promise<Action> {
    const extra: SignedBody = { signPub: this.s.keys.signPub, cert: this.s.cert, fromKind: this.s.kind };
    const msg = await signMsg({ from: this.s.id, to, kind, body: { ...body, ...extra } }, this.s.keys.signPriv);
    return { type: 'send', msg };
  }

  /** Beacons go out every 2 s, so they stay unsigned (no crypto on every tick, PLAN 13 #11). */
  beacon(body: unknown): Action {
    return { type: 'send', msg: { from: this.s.id, to: '*', kind: 'beacon', body } };
  }

  /**
   * First pass: drop my own echoes and messages for someone else, rate-limit each sender (beacons excluded,
   * same as the network), and drop any nonce seen before. A repeated nonce is either a replay or a copy that
   * was edited in transit; only then do we spend a signature check to tell which.
   */
  async admit(inbox: Msg[], t: number, cell: CellId, out: Action[]): Promise<Msg[]> {
    const ok: Msg[] = [];
    for (const m of inbox) {
      if (m.from === this.s.id || (m.to !== '*' && m.to !== this.s.id)) continue;
      if (m.kind !== 'beacon' && !this.limiter.allow(m.from, Number.isFinite(m.t) ? m.t : t)) {
        this.raise(out, 'rate-limited', m.from, t, cell, `Rate-limited ${m.from}: more than ${RATE_LIMIT_PER_MIN} messages a minute, extra ones dropped`);
        continue;
      }
      if (m.nonce && this.nonces.check(m.nonce)) {
        const pub = (m.body as Partial<SignedBody> | null)?.signPub;
        if (typeof pub !== 'string' || !(await verifyMsg(m, pub))) {
          this.raise(out, 'bad-signature', m.from, t, cell, `Dropped ${m.kind}: bad signature from ${m.from} (edited in transit)`);
        } else {
          this.raise(out, 'replay', m.from, t, cell, `Dropped ${m.kind} from ${m.from}: nonce already seen (replay)`);
        }
        continue;
      }
      ok.push(m);
    }
    return ok;
  }

  /**
   * Full check before acting on a message: valid signature, and (with certs on and requireCert) a cert signed by
   * 2 of 3 authorities that names this sender, this key and an allowed role. Returns null when fine.
   */
  async screen(m: Msg, t: number, roles: NodeKind[], requireCert = true): Promise<AlertKind | null> {
    const b = m.body as Partial<SignedBody> | null;
    if (!b || typeof b !== 'object' || typeof b.signPub !== 'string' || !(await verifyMsg(m, b.signPub))) return 'bad-signature';
    if (this.certsOn && requireCert) {
      const ok = await certAllows(b.cert, roles, b.signPub, this.s.authoritySignPubs, t);
      if (!ok || b.cert?.nodeId !== m.from) return 'no-cert';
    } else if (!b.fromKind || !roles.includes(b.fromKind)) {
      return 'no-cert';
    }
    this.knownKeys.set(m.from, b.signPub);
    return null;
  }

  /** Raise an alert at most once per kind and sender per sim-minute (keeps a flood from flooding the UI too). */
  raise(out: Action[], kind: AlertKind, suspect: NodeId | undefined, t: number, cell: CellId, text: string, extra: Partial<Alert> = {}): void {
    const key = `${kind}:${suspect ?? ''}:${extra.packageId ?? ''}`;
    const minute = Math.floor(t / 60);
    if (kind === 'rate-limited' || kind === 'replay' || kind === 'bad-signature' || kind === 'no-cert') {
      if (this.lastAlert.get(key) === minute) return;
      this.lastAlert.set(key, minute);
    }
    out.push({ type: 'alert', alert: { t, kind, reportedBy: this.s.id, suspect, cell, text, ...extra } });
    out.push(log(text));
  }
}

/** Plain-English reason for a failed screen, for the log and the Attack Console. */
export function screenText(why: AlertKind, m: Msg, role: string): string {
  switch (why) {
    case 'no-cert': return `Refused ${m.kind} from ${m.from}: no valid ${role} certificate`;
    case 'replay': return `Dropped ${m.kind} from ${m.from}: nonce already seen (replay)`;
    case 'bad-signature': return `Dropped ${m.kind}: bad signature from ${m.from}`;
    default: return `Dropped ${m.kind} from ${m.from}: ${why}`;
  }
}

// ---------- outbox (PLAN 13 #9) ----------
/**
 * Things a node keeps re-sending until they expire: open requests, envelopes it is muling, confirmations.
 * Due every RESEND_EVERY seconds, or sooner when someone new comes into range (a chance to carry data across).
 */
export class Outbox<T> {
  private items = new Map<string, { item: T; expires: number }>();
  private lastSent = -Infinity;
  private metAtLastSend = new Set<NodeId>();

  put(key: string, item: T, expires: number): void { this.items.set(key, { item, expires }); }
  has(key: string): boolean { return this.items.has(key); }
  delete(key: string): void { this.items.delete(key); }
  keys(): string[] { return [...this.items.keys()].sort(); }
  values(): T[] { return this.keys().map((k) => this.items.get(k)!.item); }
  get size(): number { return this.items.size; }

  expire(t: number): void { for (const [k, v] of this.items) if (v.expires <= t) this.items.delete(k); }

  /**
   * `now` forces a send (e.g. I just came into cell coverage: with signal it arrives instantly).
   * `period` = the regular re-send interval (longer while I have signal: everyone with signal already heard it).
   */
  due(t: number, neighbours: NodeId[], now = false, period = RESEND_EVERY): boolean {
    if (!this.items.size) return false;
    const someoneNew = neighbours.some((n) => !this.metAtLastSend.has(n));
    if (now || t - this.lastSent >= period || (someoneNew && t - this.lastSent >= NEW_NEIGHBOUR_GAP)) {
      this.lastSent = t;
      this.metAtLastSend = new Set(neighbours);
      return true;
    }
    return false;
  }
}
