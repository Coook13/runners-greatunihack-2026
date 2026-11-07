// One quiet line of key numbers per side, just above the playback bar. No boxes: text with a soft halo.
//   Simulation page: one line for the main run.  Compare page: one line under each map half (Today left, Runners right).
import type { Metrics, Mode, Snapshot } from '../contracts/types';
import { lossStats } from './beforeAfter';
import { el } from './dom';
import { int, pct } from './format';

type Tone = '' | 'rn-good' | 'rn-bad';
export interface LineItem { label: string; value: string; tone: Tone }

/** The numbers that matter, in display order. Exposure appears once a device has been breached. Pure: unit-testable. */
export function lineItems(m: Metrics, exposure: number | null): LineItem[] {
  const { losses, pinned } = lossStats(m);
  const items: LineItem[] = [
    { label: 'Reach', value: pct(m.reachPct), tone: '' },
    losses
      ? { label: 'Losses named', value: `${pinned} of ${losses}`, tone: pinned >= losses ? 'rn-good' : 'rn-bad' }
      : { label: 'Losses', value: '0', tone: '' },
  ];
  if (exposure !== null && Number.isFinite(exposure)) {
    items.push({ label: 'Exposed if stolen', value: String(Math.round(exposure)), tone: exposure > 0 ? 'rn-bad' : 'rn-good' });
  }
  items.push({ label: 'Carriers', value: `${int(m.carriersAlive)}/${int(m.carriersTotal)}`, tone: '' });
  return items;
}

export interface Strip {
  root: HTMLElement;
  update(main: Snapshot, other?: Snapshot): void;
  render(): void;
  setSplit(split: boolean): void;
  setExposure(mode: Mode, score: number | null): void;
  reset(): void;
}

export function createStrip(): Strip {
  const root = el('div', 'rn-lines rn-single');
  const line = { central: el('div', 'rn-line rn-today rn-off'), mesh: el('div', 'rn-line rn-runners') };
  root.append(line.central, line.mesh);   // Today sits under the left map, Runners under the right
  const exposure: Record<Mode, number | null> = { mesh: null, central: null };
  const last: Partial<Record<Mode, Metrics>> = {};
  let mainMode: Mode = 'mesh';
  let split = false;
  const painted: Record<Mode, string> = { mesh: '', central: '' };

  function paint(mode: Mode): void {
    const m = last[mode];
    if (!m) return;
    const items = lineItems(m, exposure[mode]);
    const key = items.map((i) => i.value + i.tone).join('|');
    if (key === painted[mode]) return;      // text unchanged: skip the DOM work
    painted[mode] = key;
    const l = line[mode];
    l.replaceChildren(el('span', 'rn-who', mode === 'mesh' ? 'Runners' : 'Today'));
    items.forEach((it, i) => {
      if (i) l.append(el('i', '', '·'));
      l.append(it.label, el('b', it.tone, it.value));
    });
  }

  function layout(): void {
    root.classList.toggle('rn-single', !split);
    line.mesh.classList.toggle('rn-off', !split && mainMode !== 'mesh');
    line.central.classList.toggle('rn-off', !split && mainMode !== 'central');
  }

  return {
    root,
    update(main, other) {
      mainMode = main.mode;
      last[main.mode] = main.metrics;
      if (other) last[other.mode] = other.metrics;
    },
    render() { layout(); paint('mesh'); paint('central'); },
    setSplit(s) { split = s; layout(); },
    setExposure(mode, score) { exposure[mode] = score; painted[mode] = ''; },
    reset() {
      exposure.mesh = null; exposure.central = null;
      painted.mesh = ''; painted.central = '';
    },
  };
}
