// Message hardening helpers that agents call (PLAN section 12, threats 5, 6, 9, 11).
// Signed messages, a replay (nonce) cache, a per-node rate limiter and a GPS jump check.
import { NONCE_CACHE, RATE_LIMIT_PER_MIN } from '../contracts/config';
import type { AlertKind, Msg, NodeId, Vec2 } from '../contracts/types';
import { nonce as freshNonce, sign, verify } from './core';

/** What an agent hands to a 'send' action. The network fills in id, t and hops later. */
export type OutMsg = Omit<Msg, 'id' | 't' | 'hops'>;

// The signature covers what the sender decided. id, t and hops are set or changed by the network, so they are left out.
const signedPart = (m: OutMsg | Msg) => ({ from: m.from, to: m.to, kind: m.kind, body: m.body, nonce: m.nonce });

/** Adds a fresh nonce (if missing) and the sender's signature. */
export async function signMsg<T extends OutMsg | Msg>(msg: T, signPriv: CryptoKey): Promise<T> {
  const withNonce = { ...msg, nonce: msg.nonce ?? freshNonce() };
  return { ...withNonce, sig: await sign(signedPart(withNonce), signPriv) };
}

/** False when unsigned, signed by another key, or edited in transit. */
export async function verifyMsg(msg: OutMsg | Msg, signPub: string): Promise<boolean> {
  if (!msg.sig || !msg.nonce) return false;
  return verify(signedPart(msg), msg.sig, signPub);
}

/** Remembers the last NONCE_CACHE nonces; the oldest are forgotten first. */
export class NonceCache {
  private seen = new Set<string>();
  private order: string[] = [];
  constructor(private size = NONCE_CACHE) {}

  /** True if this nonce was already seen (a replay). Otherwise records it and returns false. */
  check(n: string): boolean {
    if (this.seen.has(n)) return true;
    this.seen.add(n);
    this.order.push(n);
    if (this.order.length > this.size) this.seen.delete(this.order.shift()!);
    return false;
  }

  has(n: string): boolean { return this.seen.has(n); }
}

/** Counts messages per sender per sim-minute; anything past RATE_LIMIT_PER_MIN is refused. */
export class RateLimiter {
  private counts = new Map<NodeId, { minute: number; n: number }>();
  constructor(private perMin = RATE_LIMIT_PER_MIN) {}

  /** Records one message from `from` at sim time t (seconds). False once the limit is passed. */
  allow(from: NodeId, t: number): boolean {
    const minute = Math.floor(t / 60);
    const c = this.counts.get(from);
    if (!c || c.minute !== minute) {
      this.counts.set(from, { minute, n: 1 });
      return true;
    }
    c.n += 1;
    return c.n <= this.perMin;
  }
}

/** True when a node moved further than it physically could in dt seconds (spoofed GPS). `slackM` allows sensor noise. */
export function positionJump(prev: Vec2, next: Vec2, dt: number, maxSpeed: number, slackM = 0): boolean {
  return Math.hypot(next.x - prev.x, next.y - prev.y) > maxSpeed * Math.max(dt, 0) + slackM;
}

/**
 * One-call inbox filter: signature, then replay, then rate limit.
 * Returns null when the message is fine, or the alert kind to raise when dropping it.
 * Pass signPub = undefined when the sender has no known key (no valid cert seen yet).
 */
export async function screenMsg(
  msg: Msg, signPub: string | undefined, nonces: NonceCache, limiter: RateLimiter,
): Promise<AlertKind | null> {
  if (!signPub) return 'no-cert';
  if (!(await verifyMsg(msg, signPub))) return 'bad-signature';
  if (nonces.check(msg.nonce!)) return 'replay';
  if (!limiter.allow(msg.from, msg.t)) return 'rate-limited';
  return null;
}
