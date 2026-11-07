import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Alert, EngineApi, LedgerReport, Metrics, Mode, NodeState, Snapshot, WorldEvent } from '../src/contracts/types';
import { STATIC_CAPTIONS } from '../src/demo/captions';
import {
  createDirector, DEMO_DONE, droneLinks, findLeakAlert, pickHandoffSoon, pickRider, pickVan, totalSec, type Director,
} from '../src/demo/director';
import { custodyChain } from '../src/demo/cards';
import { findOptional, findView } from '../src/demo/optional';

const metrics = (over: Partial<Metrics> = {}): Metrics => ({
  t: 0, requestsOpen: 0, boxesTotal: 0, deliveredIntact: 0, deliveredShort: 0, skimmed: 0, stolen: 0, lostBreakdown: 0,
  inTransit: 0, duplicates: 0, leaksPinpointed: 0, attacksBlocked: 0, reachPct: 0, meanDeliverySec: 0, carriersAlive: 0,
  carriersTotal: 0, ...over,
});
const node = (id: string, kind: NodeState['kind'], boxes: string[] = [], over: Partial<NodeState> = {}): NodeState => ({
  id, kind, pos: { x: 1000, y: 1000 }, alive: true, boxes, battery: 1, cellSignal: true, ...over,
});
const snapshot = (mode: Mode, nodes: NodeState[], links: [string, string][] = [], t = 100): Snapshot => ({
  t, mode, nodes, links, cellNetworkUp: true, deadZones: [], hubs: [], metrics: metrics({ t }), newAlerts: [], newLogs: [],
});
const dump = (id: string) => ({ nodeId: id, readableLabels: [], knownLocations: [], knownStockLevels: 0, readableBeneficiaryNotes: [], nextHop: null });

function fakeEngine(mode: Mode, alerts: Alert[] = []) {
  const applied: WorldEvent[] = [];
  const engine: EngineApi = {
    mode, seed: 7,
    step: async () => snapshot(mode, []),
    apply: (ev) => { applied.push(ev); },
    inspect: (id) => ({ kind: 'motorbike', dump: dump(id), logs: [`log of ${id}`] }),
    ledgerInput: () => ({ receipts: [], dead: [], alerts, signPubs: {} }),
    trackHistory: () => ({}),
    auditorSealPriv: () => { throw new Error('not in tests'); },
  };
  return { engine, applied };
}

const report: LedgerReport = { boxes: 12, deliveredIntact: 9, deliveredShort: 0, skimmed: 1, stolen: 0, lostBreakdown: 0, inTransit: 2, duplicates: 0, badSignatures: 0, findings: [] };

let director: Director | null = null;
afterEach(() => { director?.dispose(); director = null; vi.useRealTimers(); });

function setup() {
  const central = fakeEngine('central');
  const mesh = fakeEngine('mesh');
  const snaps = [
    snapshot('central', [node('van-01', 'van', ['a', 'b']), node('moto-02', 'motorbike', ['c']), node('dispatch', 'dispatch')]),
    snapshot('mesh', [node('van-01', 'van', ['a']), node('moto-02', 'motorbike', ['c']), node('drone-01', 'drone'), node('clinic-1', 'clinic')],
      [['moto-02', 'drone-01'], ['drone-01', 'clinic-1']]),
  ];
  const ui = { update: vi.fn(), showInspect: vi.fn(), showBreach: vi.fn(), showLedger: vi.fn(), showSweep: vi.fn(), showAttackResult: vi.fn() };
  const captions: string[] = [];
  const black = vi.fn();
  const glass = vi.fn();
  const logs: string[] = [];
  let clock = 0;
  director = createDirector({
    engines: [central.engine, mesh.engine],
    getSnapshot: (i) => snaps[i],
    ui,
    onCaption: (t) => captions.push(t),
    buildReport: async () => report,
    playIntro: () => undefined,                       // keep the tests off the real optional modules
    showBlackBox: black,
    showGlassBox: glass,
    keys: false,
    cards: false,
    now: () => clock,
    log: (l) => logs.push(l),
  });
  return { central, mesh, ui, captions, logs, black, glass, director, tick: (ms: number) => { clock += ms; } };
}

describe('timeline', () => {
  it('beats are sorted, ids unique, and the whole demo fits in 3 minutes', () => {
    const { director } = setup();
    const t = director.timeline;
    expect(t.length).toBeGreaterThan(10);
    for (let i = 1; i < t.length; i++) expect(t[i].atSec).toBeGreaterThan(t[i - 1].atSec);
    expect(new Set(t.map((b) => b.id)).size).toBe(t.length);
    expect(t[0].atSec).toBe(0);
    expect(totalSec(t)).toBeLessThan(180);
  });

  it('covers every story beat the lead asked for', () => {
    const ids = setup().director.timeline.map((b) => b.id);
    for (const id of ['intro', 'clipboard', 'theft', 'today-blind', 'black-box', 'handoff', 'breach-runners', 'network-down', 'swarm', 'glass-box', 'scoreboard', 'done']) {
      expect(ids).toContain(id);
    }
  });

  it('static captions follow the writing rules', () => {
    for (const c of STATIC_CAPTIONS) {
      expect(c).not.toMatch(/—|–/);           // no em or en dashes
      expect(c.length).toBeLessThan(120);               // readable from the back of a room
    }
  });
});

describe('controls', () => {
  it('next() advances one beat at a time and fires its events in every run', async () => {
    const { director, central, mesh, logs } = setup();
    expect(director.state().index).toBe(0);
    director.next();
    expect(director.state().index).toBe(1);
    const at = (id: string) => director.timeline.findIndex((b) => b.id === id);
    while (director.state().index <= at('network-down')) director.next();
    expect(central.applied.some((e) => e.type === 'networkDown')).toBe(true);
    expect(mesh.applied.some((e) => e.type === 'networkDown')).toBe(true);
    // same sim time in both runs
    expect(central.applied.find((e) => e.type === 'networkDown')!.t).toBe(mesh.applied.find((e) => e.type === 'networkDown')!.t);
    // the skim went to both runs with 1.2 kg
    expect(central.applied.find((e) => e.type === 'skim')?.kg).toBe(1.2);
    expect(mesh.applied.find((e) => e.type === 'skim')?.target).toBe('moto-02');
    while (!director.state().done) director.next();
    await new Promise((r) => setTimeout(r, 0));
    expect(logs).toContain(DEMO_DONE);
  });

  it('runs on the clock, pauses, and resets to the start', async () => {
    vi.useFakeTimers();
    const { director, tick, captions } = setup();
    director.start();
    expect(director.state().index).toBe(1);             // beat 0 fires at once
    await vi.advanceTimersByTimeAsync(200);            // let the intro beat finish (no intro module in tests)
    tick(13_500); await vi.advanceTimersByTimeAsync(200);
    expect(director.state().index).toBe(2);
    director.pause();
    tick(60_000); await vi.advanceTimersByTimeAsync(200);
    expect(director.state().index).toBe(2);             // paused: nothing fires
    director.toggle();
    tick(8_000); await vi.advanceTimersByTimeAsync(200);
    expect(director.state().index).toBe(3);
    expect(captions.length).toBeGreaterThan(0);
    director.reset();
    expect(director.state()).toMatchObject({ index: 0, started: false, done: false });
  });

  it('the breach beats show both sides and the ledger beat shows the report', async () => {
    const { director, ui, black } = setup();
    while (!director.state().done) director.next();
    await new Promise((r) => setTimeout(r, 0));
    expect(black).toHaveBeenCalledWith(expect.objectContaining({ id: 'moto-02', kind: 'motorbike' }));
    expect(ui.showBreach).toHaveBeenCalled();
    expect(ui.showLedger).toHaveBeenCalledWith(report);
    expect(ui.showInspect).toHaveBeenCalled();
  });
});

describe('pickers', () => {
  const s = snapshot('mesh', [
    node('van-01', 'van', ['a', 'b', 'c']), node('moto-01', 'motorbike', ['d']), node('moto-02', 'motorbike', ['e', 'f']),
    node('drone-01', 'drone'), node('moto-03', 'motorbike', ['g'], { alive: false }), node('clinic-1', 'clinic'),
  ], [['moto-01', 'clinic-1'], ['drone-01', 'moto-02']]);

  it('picks the most loaded van for the paperwork', () => expect(pickVan(s)).toBe('van-01'));
  it('picks a loaded rider, never a van, never a dead one', () => {
    expect(pickRider(s)).toBe('moto-02');
    expect(pickRider(s, 'moto-01')).toBe('moto-01');
    expect(pickRider(s, 'moto-03')).toBe('moto-02');
  });
  it('prefers a loaded vehicle that is about to meet someone', () => expect(['moto-01', 'moto-02']).toContain(pickHandoffSoon(s)));
  it('counts drone relay links', () => expect(droneLinks(s)).toEqual({ count: 1, drones: ['drone-01'] }));
  it('finds the alert that names the skimmed holder', () => {
    const a = (over: Partial<Alert>): Alert => ({ t: 50, kind: 'weight-mismatch', reportedBy: 'van-02', suspect: 'moto-04', cell: 'C1-1', text: '', ...over });
    expect(findLeakAlert([a({ t: 10 }), a({ suspect: 'moto-09' }), a({})], 20, 'moto-04')?.suspect).toBe('moto-04');
    expect(findLeakAlert([a({ t: 10 })], 20, 'moto-04')).toBeNull();
  });
  it('orders a chain of custody and finds the weight drop', () => {
    const r = (seq: number, kg: number, to: string) => ({ packageId: 'p-1', requestId: 'r', attempt: 1, kind: 'handoff' as const, from: 'x', to, t: seq, seq, cell: 'C1-1', measuredKg: kg, sigTo: '' });
    const { chain, dropAt } = custodyChain([r(2, 4.8, 'moto-01'), r(1, 6, 'van-01'), r(3, 4.8, 'clinic-1')], 'p-1');
    expect(chain.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(dropAt).toBe(1);
  });
});

describe('optional modules', () => {
  it('finds a named export and ignores missing modules', async () => {
    const mods = { '../ui/blackbox.ts': async () => ({ showBlackBox: () => 'ok' }) };
    expect(await findOptional('blackbox', mods)).toBeTypeOf('function');
    expect(await findOptional('glassbox', mods)).toBeNull();
  });
  it('builds a view from a create...View factory', async () => {
    const shown: unknown[] = [];
    const mods = { '../ui/blackbox.ts': async () => ({ createBlackBoxView: () => ({ show: (x: unknown) => shown.push(x) }) }) };
    const view = await findView('blackbox', {} as HTMLElement, mods);
    view!.show({ id: 'moto-01' });
    view!.hide();
    expect(shown).toEqual([{ id: 'moto-01' }, null]);
  });
});
