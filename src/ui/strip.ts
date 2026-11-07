// One quiet line of key numbers per side, just above the playback bar. No boxes: text with a soft halo.
//   Simulation page: one line for the main run.  Compare page: one line under each map half (Today left, Runners right).
import type { Metrics, Mode, Snapshot } from '../contracts/types';
import { lossStats } from './beforeAfter';
import { el } from './dom';
import { int, type Exposure } from './format';

type Tone = '' | 'rn-good' | 'rn-bad';
export interface LineItem { label: string; value: string; tone: Tone }

/** The numbers that matter, in display order. Exposure appears once a device has been breached. Pure: unit-testable. */
export function lineItems(m: Metrics, exposure: Exposure | null): LineItem[] {
  const { losses, pinned } = lossStats(m);
  const items: LineItem[] = [
    { label: 'Delivered intact', value: int(m.deliveredIntact), tone: '' },
    losses
      ? { label: 'Losses detected', value: `${pinned} / ${losses}`, tone: pinned >= losses ? 'rn-good' : 'rn-bad' }
      : { label: 'Losses detected', value: '0 / 0', tone: '' },
    { label: 'Data exposed', value: exposure ? `${exposure.stores} stores / ${exposure.notes} notes` : 'Not tested',
      tone: exposure ? (exposure.score > 0 ? 'rn-bad' : 'rn-good') : '' },
  ];
  return items;
}

export interface Strip {
  root: HTMLElement;
  update(main: Snapshot, other?: Snapshot): void;
  render(): void;
  setSplit(split: boolean): void;
  setExposure(mode: Mode, data: Exposure | null): void;
  reset(): void;
}

export function createStrip(): Strip {
  const root = el('div', 'rn-lines rn-single');
  const line = { central: el('div', 'rn-line rn-today rn-off'), mesh: el('div', 'rn-line rn-runners') };
  root.append(line.central, line.mesh);   // Today sits under the left map, Runners under the right
  const exposure: Record<Mode, Exposure | null> = { mesh: null, central: null };
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
    items.forEach((it) => {
      const metric = el('span', 'rn-kpi');
      metric.append(el('span', 'rn-kpi-label', it.label), el('b', it.tone, it.value));
      l.append(metric);
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
