// Certificates: who is allowed in the network (PLAN section 12, threats 2-4).
// A cert is valid only with signatures from at least 2 of the 3 authorities
// (health ministry, NGO, auditor), so no single party can mint a ghost clinic or fake carrier.
import type { Cert, KeySet, NodeId, NodeKind } from '../contracts/types';
import { sign, verify } from './core';

/** The part of a cert the authorities sign. */
const certBody = (c: Pick<Cert, 'nodeId' | 'role' | 'signPub' | 'expires'>) =>
  ({ nodeId: c.nodeId, role: c.role, signPub: c.signPub, expires: c.expires });

/** Each authority signs the cert body. `authority` is the signer's public key, so verifiers can match it. */
export async function issueCert(
  nodeId: NodeId, role: NodeKind, signPub: string, expires: number, authorities: KeySet[],
): Promise<Cert> {
  const body = certBody({ nodeId, role, signPub, expires });
  const sigs = await Promise.all(authorities.map(async (a) => ({ authority: a.signPub, sig: await sign(body, a.signPriv) })));
  return { ...body, sigs };
}

/** True when the cert is unexpired and carries valid signatures from at least `threshold` distinct known authorities. */
export async function verifyCert(
  cert: Cert | null | undefined, authoritySignPubs: string[], now: number, threshold = 2,
): Promise<boolean> {
  if (!cert || !Array.isArray(cert.sigs) || !(cert.expires > now)) return false;
  const body = certBody(cert);
  const good = new Set<string>();
  for (const s of cert.sigs) {
    // Only count authorities we trust, and each one once (a copied sig must not count twice).
    if (!authoritySignPubs.includes(s.authority) || good.has(s.authority)) continue;
    if (await verify(body, s.sig, s.authority)) good.add(s.authority);
  }
  return good.size >= threshold;
}

/** Full check for a hand-off or request: valid cert, an allowed role, and it vouches for this signing key. */
export async function certAllows(
  cert: Cert | null | undefined, roles: NodeKind[], signPub: string, authoritySignPubs: string[], now: number,
): Promise<boolean> {
  if (!cert || !roles.includes(cert.role) || cert.signPub !== signPub) return false;
  return verifyCert(cert, authoritySignPubs, now);
}
