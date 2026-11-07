import { describe, expect, it } from 'vitest';
import { CELL_SIZE, SPEED } from '../src/contracts/config';
import type {
  Action, AgentSetup, AgentView, CarriedBox, CarrierKind, Label, Manifest, MapQuery, Msg, NodeKind, Receipt, RequestEnvelope, Vec2,
} from '../src/contracts/types';
import { generateKeySet, seal, sign, verify } from '../src/privacy/core';
import { createCarrier } from '../src/agents/carrier';
import { createClinic } from '../src/agents/clinic';
import { Guard, envelopePayload, receiptPayload, signReceipt } from '../src/agents/common';
import { beats, canHandTo, chooseMeetPoint, decideHandoff, demandAnomaly, type Candidate } from '../src/agents/routing';

// ---------- a tiny flat world: straight lines everywhere, no hubs ----------
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
let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

async function setup(id: string, kind: NodeKind, home: Vec2, storeSealPub: string): Promise<AgentSetup> {
  return {
    id, kind, keys: await generateKeySet(), cert: null, storeSealPub, storeIds: [], auditorSealPub: '',
    authoritySignPubs: [], home, rng,
  };
}

function view(s: AgentSetup, over: Partial<AgentView>): AgentView {
  return {
    self: s.id, kind: s.kind, t: 100, dt: 0.5, pos: s.home, battery: 1, inventory: [], inbox: [], neighbours: [],
    cellSignal: false, mode: 'mesh', map, ...over,
  };
}

const sent = (acts: Action[], kind: string): Msg[] =>
  acts.flatMap((a) => (a.type === 'send' && a.msg.kind === kind ? [{ ...a.msg, id: 'x', t: 100, hops: 1 } as Msg] : []));
const alerts = (acts: Action[]) => acts.flatMap((a) => (a.type === 'alert' ? [a.alert] : []));

// ---------- 1. hand-off decision (PLAN 3.5) ----------
describe('hand-off decision', () => {
  const dest = { x: 10000, y: 0 };
  const van = { id: 'van-01', kind: 'van' as CarrierKind, pos: { x: 0, y: 0 } };
  const myEta = map.eta('van', van.pos, dest);
  const label = { size: 'S' as const };
  const cand = (id: string, kind: CarrierKind, pos: Vec2, spare = 2): Candidate => ({ id, kind, pos, spare, battery: 1 });

  it('a neighbour more than 20% faster gets the box', () => {
    const d = decideHandoff({ me: van, myEta, label, dest, candidates: [cand('drone-01', 'drone', { x: 300, y: 0 })], map, rng });
    expect(d?.to.id).toBe('drone-01');
    expect(d!.theirEta).toBeLessThan(myEta * 0.8);
  });

  it('a slower neighbour does not, and the 20% margin is strict', () => {
    const d = decideHandoff({ me: van, myEta, label, dest, candidates: [cand('boat-01', 'boat', { x: 200, y: 0 })], map, rng });
    expect(d).toBeNull();
    expect(beats(100, 79)).toBe(true);
    expect(beats(100, 85)).toBe(false);   // only 15% faster: keep the box
  });

  it('tier violations are refused', () => {
    expect(canHandTo('store', 'drone')).toBe(false);       // only vans ever load at a store
    expect(canHandTo('store', 'van')).toBe(true);
    expect(canHandTo('drone', 'clinic')).toBe(false);      // clinics only via the signed last mile
    expect(canHandTo('clinic', 'drone')).toBe(false);
    // A drone may not be called to a meeting inside a store's radio range (it would learn where the store is).
    const storeNearby = [{ x: 0, y: 0 }];
    expect(chooseMeetPoint(van, cand('drone-01', 'drone', { x: 500, y: 0 }), map, rng, storeNearby)).toBeNull();
    const d = decideHandoff({
      me: van, myEta, label, dest, candidates: [cand('drone-01', 'drone', { x: 500, y: 0 })], map, rng, knownStores: storeNearby,
    });
    expect(d).toBeNull();
  });

  it('no room, or the carrier who just gave me the box, means no hand-off', () => {
    const fast = cand('drone-01', 'drone', { x: 300, y: 0 }, 0);
    expect(decideHandoff({ me: van, myEta, label, dest, candidates: [fast], map, rng })).toBeNull();
    const back = cand('drone-02', 'drone', { x: 300, y: 0 });
    expect(decideHandoff({ me: van, myEta, label, dest, candidates: [back], map, rng, exclude: new Set(['drone-02']) })).toBeNull();
  });

  it('pair rotation prefers a partner it has not used before', () => {
    const a = cand('drone-01', 'drone', { x: 300, y: 0 });
    const b = cand('drone-02', 'drone', { x: 320, y: 0 });
    const d = decideHandoff({ me: van, myEta, label, dest, candidates: [a, b], map, rng, pairCounts: { 'drone-01': 3 } });
    expect(d?.to.id).toBe('drone-02');
  });

  it('meeting points are 100-300 m away and never repeat', () => {
    const a = chooseMeetPoint(van, cand('moto-01', 'motorbike', { x: 1000, y: 0 }), map, rng)!;
    const b = chooseMeetPoint(van, cand('moto-01', 'motorbike', { x: 1000, y: 0 }), map, rng)!;
    const off = Math.hypot(a.x - 500, a.y);
    expect(off).toBeGreaterThanOrEqual(100);
    expect(off).toBeLessThanOrEqual(300);
    expect(a).not.toEqual(b);
  });

  it('flags a clinic asking for 3x its usual volume', () => {
    expect(demandAnomaly([5, 5, 5], 16)).toBe(true);
    expect(demandAnomaly([5, 5, 5], 10)).toBe(false);
    expect(demandAnomaly([5], 50)).toBe(false);          // not enough history yet
  });
});

// ---------- shared fixtures for boxes ----------
async function boxFor(clinicSealPub: string, requestId: string, declaredKg: number, cell: string): Promise<{ label: Label; box: CarriedBox['box'] }> {
  const label: Label = { packageId: `p-${requestId}-${Math.floor(rng() * 1e6)}`, requestId, attempt: 1, urgency: 2, size: 'M', cold: false, destCell: cell, deadline: 9999 };
  const manifest: Manifest = { requestId, items: [{ code: 'RUTF-30', qty: 2 }], declaredKg, beneficiaryNote: '9 children 6-59 months, 2 new' };
  const sealed = await seal(manifest, clinicSealPub);
  return { label, box: { label, sealed, packedBy: 'store-A', packSig: 'x' } };
}

// ---------- 2. passport weight check ----------
describe('weight check on receipt', () => {
  it('a lighter box than its passport says raises weight-mismatch naming the last holder, then signs a receipt', async () => {
    const store = await generateKeySet();
    const clinic = await generateKeySet();
    const vanKeys = await generateKeySet();
    const s = await setup('moto-01', 'motorbike', { x: 100, y: 100 }, store.sealPub);
    const moto = createCarrier(s);
    const { label, box } = await boxFor(clinic.sealPub, 'r-c1-1', 5.6, 'C9-9');
    const pickup = await signReceipt({
      packageId: label.packageId, requestId: label.requestId, attempt: 1, kind: 'pickup', from: 'store-A', to: 'van-01',
      t: 10, seq: 0, cell: 'C2-10', measuredKg: 5.6,
    }, vanKeys.signPriv);
    const acts = await moto.tick(view(s, { inventory: [{ box, measuredKg: 4.4, passport: [pickup] }] }));

    const [a] = alerts(acts).filter((x) => x.kind === 'weight-mismatch');
    expect(a).toBeDefined();
    expect(a.suspect).toBe('van-01');
    expect(a.packageId).toBe(label.packageId);
    expect(a.kg).toBeCloseTo(1.2, 5);

    const stamp = acts.find((x) => x.type === 'stamp') as Extract<Action, { type: 'stamp' }>;
    expect(stamp.receipt).toMatchObject({ kind: 'handoff', from: 'van-01', to: 'moto-01', seq: 1, measuredKg: 4.4 });
    expect(await verify(receiptPayload(stamp.receipt), stamp.receipt.sigTo, s.keys.signPub)).toBe(true);
    expect(moto.receipts().length).toBe(2);          // its own receipt + the passport copy
  });

  it('a matching weight raises nothing', async () => {
    const store = await generateKeySet();
    const clinic = await generateKeySet();
    const s = await setup('moto-02', 'motorbike', { x: 100, y: 100 }, store.sealPub);
    const { label, box } = await boxFor(clinic.sealPub, 'r-c1-2', 5.6, 'C9-9');
    const prev: Receipt = { packageId: label.packageId, requestId: label.requestId, attempt: 1, kind: 'pickup', from: 'store-A', to: 'van-01', t: 1, seq: 0, cell: 'C2-10', measuredKg: 5.6, sigTo: 'x' };
    const acts = await createCarrier(s).tick(view(s, { inventory: [{ box, measuredKg: 5.62, passport: [prev] }] }));
    expect(alerts(acts)).toEqual([]);
  });
});

// ---------- 3. signed last mile ----------
describe('last mile', () => {
  async function scene() {
    const storeNet = await generateKeySet();
    const clinicHome = { x: 9 * CELL_SIZE + 500, y: 9 * CELL_SIZE + 500 };
    const cs = await setup('clinic-1', 'clinic', clinicHome, storeNet.sealPub);
    const clinic = createClinic(cs);
    // The engine's scripted demand makes the clinic write a request; grab the envelope it broadcasts.
    const order: Msg = { id: 'o', from: 'scenario', to: 'clinic-1', kind: 'order', body: { type: 'demand', urgency: 2 }, hops: 0, t: 0 };
    const out = await clinic.tick(view(cs, { t: 0, inbox: [order] }));
    const env = ((sent(out, 'request')[0].body as { items: RequestEnvelope[] }).items)[0];
    expect(env.clinicId).toBe('clinic-1');
    expect(await verify(envelopePayload(env), env.sig, cs.keys.signPub)).toBe(true);

    // A store loads the box (with the clinic's signed request) onto a van that is already in the clinic's cell.
    const { label, box } = await boxFor(env.replyPub, env.requestId, 5.6, env.destCell);
    const vs = await setup('van-01', 'van', { x: clinicHome.x + 10, y: clinicHome.y }, storeNet.sealPub);
    const van = createCarrier(vs);
    const ss = await setup('store-A', 'store', { x: 0, y: 0 }, storeNet.sealPub);
    const load = await new Guard(ss).signed('handoff-propose', 'van-01', { load: [{ packageId: label.packageId, label, meet: null, envelope: env }] });
    const loadMsg = { ...(load as Extract<Action, { type: 'send' }>).msg, id: 'l', t: 100, hops: 1 } as Msg;
    const pickup = await signReceipt({ packageId: label.packageId, requestId: label.requestId, attempt: 1, kind: 'pickup', from: 'store-A', to: 'van-01', t: 99, seq: 0, cell: 'C2-10', measuredKg: 5.6 }, vs.keys.signPriv);
    const inv: CarriedBox[] = [{ box, measuredKg: 5.6, passport: [pickup] }];
    const first = await van.tick(view(vs, { inventory: inv, inbox: [loadMsg] }));
    const call = sent(first, 'lastmile-call')[0];
    expect(call).toBeDefined();
    const clinicNb = { id: 'clinic-1', kind: 'clinic' as NodeKind, pos: clinicHome, dist: 10 };
    return { cs, clinic, vs, van, inv, call, label, clinicNb, env };
  }

  it('refuses an unsigned or forged clinic reply and never hands the box over', async () => {
    const { vs, van, inv, call, label, clinicNb } = await scene();
    const challenge = (call.body as { challenge: string }).challenge;
    const fake = await generateKeySet();
    const body = { packageId: label.packageId, requestId: label.requestId, challenge, clinicId: 'clinic-1' };
    // Forged: a well-formed signed reply, but from a key that is not the clinic's.
    const forged: Msg = { id: 'f', from: 'clinic-1', to: 'van-01', kind: 'lastmile-reply', hops: 1, t: 101, nonce: 'n1',
      body: { ...body, signPub: fake.signPub, cert: null, fromKind: 'clinic' } };
    forged.sig = await sign({ from: forged.from, to: forged.to, kind: forged.kind, body: forged.body, nonce: forged.nonce }, fake.signPriv);
    const unsigned: Msg = { id: 'u', from: 'clinic-1', to: 'van-01', kind: 'lastmile-reply', hops: 1, t: 101, nonce: 'n2', body };
    for (const reply of [forged, unsigned]) {
      const acts = await van.tick(view(vs, { t: 101, inventory: inv, inbox: [reply], neighbours: [clinicNb] }));
      expect(acts.some((a) => a.type === 'transfer')).toBe(false);
      expect(alerts(acts).some((a) => a.kind === 'bad-signature')).toBe(true);
    }
  });

  it('delivers only after the real clinic answers with a signed reply', async () => {
    const { cs, clinic, vs, van, inv, call, label, clinicNb } = await scene();
    const answer = await clinic.tick(view(cs, { t: 101, inbox: [call] }));
    const reply = sent(answer, 'lastmile-reply')[0];
    expect(reply?.to).toBe('van-01');
    const acts = await van.tick(view(vs, { t: 102, inventory: inv, inbox: [reply], neighbours: [clinicNb] }));
    expect(acts).toContainEqual({ type: 'transfer', packageId: label.packageId, to: 'clinic-1' });
  });

  it('the clinic stays silent for a call about a request it never made', async () => {
    const { cs, clinic, call } = await scene();
    const g = new Guard(await setup('fake-01', 'motorbike', { x: 0, y: 0 }, ''));
    const other = await g.signed('lastmile-call', '*', { ...(call.body as object), requestId: 'r-c1-999' });
    const m = { ...(other as Extract<Action, { type: 'send' }>).msg, id: 'z', t: 101, hops: 1 } as Msg;
    const acts = await clinic.tick(view(cs, { t: 101, inbox: [m] }));
    expect(sent(acts, 'lastmile-reply')).toEqual([]);
  });
});

// ---------- 4. clinic checks and duplicate counting (PLAN 13 #10) ----------
describe('clinic receiving boxes', () => {
  async function clinicWithRequest() {
    const storeNet = await generateKeySet();
    const cs = await setup('clinic-2', 'clinic', { x: 5 * CELL_SIZE + 300, y: 5 * CELL_SIZE + 300 }, storeNet.sealPub);
    const clinic = createClinic(cs);
    const order: Msg = { id: 'o', from: 'scenario', to: 'clinic-2', kind: 'order', body: { type: 'demand', urgency: 1 }, hops: 0, t: 0 };
    const out = await clinic.tick(view(cs, { t: 0, inbox: [order] }));
    const env = ((sent(out, 'request')[0].body as { items: RequestEnvelope[] }).items)[0];
    return { cs, clinic, env };
  }
  const passport = (l: Label, kg: number): Receipt[] => [
    { packageId: l.packageId, requestId: l.requestId, attempt: 1, kind: 'pickup', from: 'store-A', to: 'van-01', t: 1, seq: 0, cell: 'C2-10', measuredKg: kg, sigTo: 'x' },
    { packageId: l.packageId, requestId: l.requestId, attempt: 1, kind: 'handoff', from: 'van-01', to: 'drone-01', t: 2, seq: 1, cell: 'C4-4', measuredKg: kg, sigTo: 'x' },
  ];

  it('counts a second box for an already-filled request as a duplicate', async () => {
    const { cs, clinic, env } = await clinicWithRequest();
    const a = await boxFor(env.replyPub, env.requestId, 5.6, env.destCell);
    const b = await boxFor(env.replyPub, env.requestId, 5.6, env.destCell);
    b.label.attempt = 2;                                  // the re-request after a missed deadline
    const acts1 = await clinic.tick(view(cs, { t: 50, inventory: [{ box: a.box, measuredKg: 5.6, passport: passport(a.label, 5.6) }] }));
    expect(acts1).toContainEqual({ type: 'consume', packageId: a.label.packageId });
    const delivered = acts1.find((x) => x.type === 'stamp') as Extract<Action, { type: 'stamp' }>;
    expect(delivered.receipt).toMatchObject({ kind: 'delivered', from: 'drone-01', to: 'clinic-2', seq: 2 });
    expect(clinic.duplicates()).toBe(0);
    await clinic.tick(view(cs, { t: 60, inventory: [{ box: b.box, measuredKg: 5.6, passport: passport(b.label, 5.6) }] }));
    expect(clinic.duplicates()).toBe(1);
  });

  it('a box short of its sealed manifest from the first weigh-in names the packer', async () => {
    const { cs, clinic, env } = await clinicWithRequest();
    const a = await boxFor(env.replyPub, env.requestId, 5.6, env.destCell);
    const acts = await clinic.tick(view(cs, { t: 50, inventory: [{ box: a.box, measuredKg: 2.8, passport: passport(a.label, 2.8) }] }));
    const short = alerts(acts).find((x) => x.kind === 'short-delivery');
    expect(short?.suspect).toBe('store-A');
    expect(short?.kg).toBeCloseTo(2.8, 5);
  });

  it('re-requests with attempt + 1 after the deadline passes', async () => {
    const { cs, clinic, env } = await clinicWithRequest();
    const acts = await clinic.tick(view(cs, { t: env.deadline + 1 }));
    const again = sent(acts, 'request').flatMap((m) => (m.body as { items: RequestEnvelope[] }).items).find((e) => e.attempt === 2);
    expect(again?.requestId).toBe(env.requestId);
  });
});

// The breach dump of a mesh carrier: labels and a next hop, never stores, stock or children.
describe('breach dump', () => {
  it('a drone knows nothing worth stealing', async () => {
    const s = await setup('drone-09', 'drone', { x: 0, y: 0 }, (await generateKeySet()).sealPub);
    const d = createCarrier(s);
    await d.tick(view(s, {}));
    const dump = d.dump();
    expect(dump.knownLocations.filter((l) => l.what === 'store')).toEqual([]);
    expect(dump.knownStockLevels).toBe(0);
    expect(dump.readableBeneficiaryNotes).toEqual([]);
  });
});

// ---------- 5. message guard: replay vs tamper (PLAN 12 #5, #6) ----------
describe('message guard', () => {
  it('a repeated nonce is a replay; the same nonce with an edited body is a bad signature', async () => {
    const sender = await setup('moto-07', 'motorbike', { x: 0, y: 0 }, '');
    const receiver = await setup('drone-07', 'drone', { x: 0, y: 0 }, '');
    const act = await new Guard(sender).signed('receipts', '*', { items: [] });
    const msg = { ...(act as Extract<Action, { type: 'send' }>).msg, id: 'a', t: 10, hops: 1 } as Msg;
    const g = new Guard(receiver);
    const out: Action[] = [];
    expect((await g.admit([msg], 10, 'C0-0', out)).length).toBe(1);
    expect(await g.screen(msg, 10, ['motorbike'], false)).toBeNull();
    expect((await g.admit([msg], 11, 'C0-0', out)).length).toBe(0);
    const edited = { ...msg, body: { ...(msg.body as object), fromKind: 'van' } } as Msg;
    expect((await g.admit([edited], 12, 'C0-0', out)).length).toBe(0);
    expect(alerts(out).map((a) => a.kind)).toEqual(['replay', 'bad-signature']);
  });
});
