// Live metrics panel plus the reach-over-time chart (one line, or two in split mode).
import { Chart, registerables } from 'chart.js';
import type { Metrics, Mode, Snapshot } from '../contracts/types';
import { CHART_FONT, COLORS, el, panel } from './dom';
import { metricRows, newSeries, pushPoint, type Series } from './format';

Chart.register(...registerables);
Chart.defaults.font.family = CHART_FONT;

const modeName = (m: Mode) => (m === 'mesh' ? 'Runners' : 'Today');
const modeColor = (m: Mode) => (m === 'mesh' ? COLORS.mesh : COLORS.central);

export interface MetricsPanel {
  roots: HTMLElement[];
  update(main: Snapshot, other?: Snapshot): void;   // cheap: records points every call
  render(): void;                                   // DOM + chart redraw, throttled by the caller
  reset(): void;
}

export function createMetrics(): MetricsPanel {
  const p = panel('Numbers');
  const grid = el('div', 'rn-metrics');
  p.body.append(grid);

  const c = panel('Reach over time');
  const wrap = el('div', 'rn-chart');
  const canvas = el('canvas');
  wrap.append(canvas);
  c.body.append(wrap);

  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      elements: { point: { radius: 0 }, line: { borderWidth: 2.5, tension: 0.2 } },
      scales: {
        x: { type: 'linear', ticks: { color: COLORS.dim, maxTicksLimit: 5, callback: (v) => `${Math.round(Number(v) / 60)}m` },
             grid: { color: COLORS.grid } },
        y: { min: 0, max: 100, ticks: { color: COLORS.dim, stepSize: 25, callback: (v) => `${v}%` }, grid: { color: COLORS.grid } },
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  });

  // One series per mode so a mode switch doesn't mix lines.
  const series: Record<Mode, Series> = { mesh: newSeries(), central: newSeries() };
  let main: Snapshot | null = null;
  let other: Snapshot | undefined;

  const renderGrid = () => {
    if (!main) return;
    grid.innerHTML = '';
    grid.classList.toggle('rn-two', !!other);
    const a = metricRows(main.metrics);
    const b = other ? metricRows(other.metrics) : null;
    // Two columns: Today first, Runners second, matching the left/right maps on the compare page.
    const cols = b && other ? (main.mode === 'mesh' ? [b, a] : [a, b]) : [a];
    if (b && other) grid.append(el('span'), head('central'), head('mesh'));
    a.forEach((row, i) => {
      grid.append(el('span', 'rn-k', row.label));
      for (const c of cols) grid.append(value(c[i], i === 0));
    });
  };

  const head = (m: Mode) => {
    const h = el('span', 'rn-colhead', m === 'mesh' ? 'Runners' : 'Today');
    h.style.color = modeColor(m);
    return h;
  };

  const value = (row: ReturnType<typeof metricRows>[number], big: boolean) => {
    const v = el('span', `rn-v${big ? ' rn-big' : ''}${row.tone === 'bad' ? ' rn-bad' : ''}`, row.value);
    return v;
  };

  const renderChart = () => {
    if (!main) return;
    const shown: Mode[] = other ? [main.mode, other.mode] : [main.mode];
    chart.data.datasets = shown.map((m) => ({
      label: modeName(m),
      data: series[m].t.map((t, i) => ({ x: t, y: series[m].v[i] })),
      borderColor: modeColor(m),
      backgroundColor: modeColor(m),
    }));
    chart.update('none');
    c.title.textContent = other ? `Reach over time: ${legend(shown)}` : 'Reach over time';
  };

  const legend = (ms: Mode[]) => ms.map((m) => (m === 'mesh' ? 'teal Runners' : 'amber Today')).join(', ');

  return {
    roots: [p.root, c.root],
    update(m, o) {
      main = m;
      other = o;
      record(m.mode, m.metrics);
      if (o) record(o.mode, o.metrics);
    },
    render() { renderGrid(); renderChart(); },
    reset() { series.mesh = newSeries(); series.central = newSeries(); },
  };

  function record(mode: Mode, mt: Metrics) {
    pushPoint(series[mode], mt.t, mt.reachPct);
  }
}
