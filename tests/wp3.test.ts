import { describe, expect, it } from 'vitest';
import { CERT_TTL_SEC, RATE_LIMIT_PER_MIN, SPEED } from '../src/contracts/config';
import type { BreachDump, Manifest, Msg } from '../src/contracts/types';
import { generateKeySet } from '../src/privacy/core';
import { certAllows, issueCert, verifyCert } from '../src/privacy/certs';
import { exposureScore, summarise } from '../src/privacy/breach';
import { openAuditorCopy, sealForClinicAndAuditor } from '../src/privacy/auditor';
import { NonceCache, RateLimiter, positionJump, screenMsg, signMsg, verifyMsg } from '../src/privacy/guard';

describe('certs (2 of 3)', () => {
  it('1 of 3 fails, 2 of 3 passes, expired fails, outsiders and copies do not count', async () => {
    const auth = await Promise.all([generateKeySet(), generateKeySet(), generateKeySet()]);
    const pubs = auth.map((a) => a.signPub);
    const node = await generateKeySet();
    const now = 100;
    const exp = now + CERT_TTL_SEC;

    const one = await issueCert('clinic-1', 'clinic', node.signPub, exp, [auth[0]]);
    expect(await verifyCert(one, pubs, now)).toBe(false);
    const two = await issueCert('clinic-1', 'clinic', node.signPub, exp, [auth[0], auth[2]]);
    expect(await verifyCert(two, pubs, now)).toBe(true);
    expect(await verifyCert(two, pubs, exp + 1)).toBe(false);

    // Same signature twice must not count as two authorities.
    expect(await verifyCert({ ...one, sigs: [one.sigs[0], one.sigs[0]] }, pubs, now)).toBe(false);
    // A self-made "authority" is ignored.
    const rogue = await generateKeySet();
    const ghost = await issueCert('clinic-x', 'clinic', node.signPub, exp, [auth[0], rogue]);
    expect(await verifyCert(ghost, pubs, now)).toBe(false);
    // Edited role breaks the signatures.
    expect(await verifyCert({ ...two, role: 'store' }, pubs, now)).toBe(false);

    expect(await certAllows(two, ['clinic'], node.signPub, pubs, now)).toBe(true);
    expect(await certAllows(two, ['drone'], node.signPub, pubs, now)).toBe(false);
    expect(await certAllows(two, ['clinic'], rogue.signPub, pubs, now)).toBe(false);
    expect(await certAllows(null, ['clinic'], node.signPub, pubs, now)).toBe(false);
  });
});

describe('guard', () => {
  it('signed messages verify; tampering and unsigned fail', async () => {
    const k = await generateKeySet();
    const other = await generateKeySet();
    const out = await signMsg({ from: 'moto-01', to: '*' as const, kind: 'beacon' as const, body: { spare: 2 } }, k.signPriv);
    // The network adds id, t and hops after signing; that must not break it.
    const msg: Msg = { ...out, id: 'm1', t: 5, hops: 3 };
    expect(await verifyMsg(msg, k.signPub)).toBe(true);
    expect(await verifyMsg({ ...msg, body: { spare: 9 } }, k.signPub)).toBe(false);
    expect(await verifyMsg({ ...msg, to: 'van-01' }, k.signPub)).toBe(false);
    expect(await verifyMsg(msg, other.signPub)).toBe(false);
    expect(await verifyMsg({ ...msg, sig: undefined }, k.signPub)).toBe(false);
  });

  it('nonce cache rejects replays and evicts oldest', () => {
    const c = new NonceCache(3);
    expect(c.check('a')).toBe(false);
    expect(c.check('a')).toBe(true);
    c.check('b'); c.check('c'); c.check('d');
    expect(c.has('a')).toBe(false);
    expect(c.check('d')).toBe(true);
  });

  it('rate limiter trips per node per sim-minute', () => {
    const r = new RateLimiter();
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) expect(r.allow('flood-1', 10)).toBe(true);
    expect(r.allow('flood-1', 10)).toBe(false);
    expect(r.allow('moto-02', 10)).toBe(true);
    expect(r.allow('flood-1', 61)).toBe(true);
  });

  it('position jump flags impossible moves', () => {
    expect(positionJump({ x: 0, y: 0 }, { x: 5000, y: 0 }, 0.5, SPEED.motorbike)).toBe(true);
    expect(positionJump({ x: 0, y: 0 }, { x: 5, y: 0 }, 0.5, SPEED.motorbike)).toBe(false);
  });

  it('screenMsg runs all checks in order', async () => {
    const k = await generateKeySet();
    const nonces = new NonceCache();
    const lim = new RateLimiter();
    const msg: Msg = { ...(await signMsg({ from: 'clinic-1', to: '*' as const, kind: 'request' as const, body: 1 }, k.signPriv)), id: 'x', t: 0, hops: 0 };
    expect(await screenMsg(msg, undefined, nonces, lim)).toBe('no-cert');
    expect(await screenMsg({ ...msg, body: 2 }, k.signPub, nonces, lim)).toBe('bad-signature');
    expect(await screenMsg(msg, k.signPub, nonces, lim)).toBe(null);
    expect(await screenMsg(msg, k.signPub, nonces, lim)).toBe('replay');
  });
});

describe('breach', () => {
  it('mesh dump scores lower than central dump', () => {
    const mesh: BreachDump = {
      nodeId: 'moto-01',
      readableLabels: [{ packageId: 'p1', requestId: 'r1', attempt: 0, urgency: 3, size: 'S', cold: false, destCell: 'C3-4', deadline: 900 }],
      knownLocations: [{ what: 'hub', pos: { x: 1, y: 1 } }],
      knownStockLevels: 0, readableBeneficiaryNotes: [], nextHop: 'drone-02',
    };
    const central: BreachDump = {
      nodeId: 'dispatch', readableLabels: [],
      knownLocations: [0, 1, 2].map((i) => ({ what: 'store' as const, pos: { x: i, y: i } })),
      knownStockLevels: 3, readableBeneficiaryNotes: ['12 children 6-59 months', '4 children, 1 new'], nextHop: null,
    };
    expect(exposureScore(mesh)).toBe(0);
    expect(exposureScore(central)).toBe(8);
    expect(exposureScore(mesh)).toBeLessThan(exposureScore(central));
    expect(summarise(central)[1]).toBe('3 store locations exposed');
    expect(summarise(mesh).at(-1)).toBe('Next hop: drone-02');
  });
});

describe('auditor copy', () => {
  it('opens with the auditor key only', async () => {
    const clinic = await generateKeySet();
    const auditor = await generateKeySet();
    const carrier = await generateKeySet();
    const m: Manifest = { requestId: 'r1', items: [{ code: 'RUTF-30', qty: 2 }], declaredKg: 5.6, beneficiaryNote: '12 children' };
    const { sealed, auditorCopy } = await sealForClinicAndAuditor(m, clinic.sealPub, auditor.sealPub);
    expect(await openAuditorCopy(auditorCopy, auditor.sealPriv)).toEqual(m);
    await expect(openAuditorCopy(auditorCopy, clinic.sealPriv)).rejects.toThrow();
    await expect(openAuditorCopy(auditorCopy, carrier.sealPriv)).rejects.toThrow();
    await expect(openAuditorCopy(sealed, auditor.sealPriv)).rejects.toThrow();
  });
});
