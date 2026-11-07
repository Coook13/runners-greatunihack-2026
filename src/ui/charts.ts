// Sweep chart: reach % vs share of carriers lost, mesh vs central, network down.
import { Chart, registerables } from 'chart.js';
import { card, CHART_FONT, COLORS, el } from './dom';
import { killLabel, parseSweep } from './format';

Chart.register(...registerables);
Chart.defaults.font.family = CHART_FONT;

export function createSweepCard() {
  const c = card('Sweep: network down, carriers lost');
  let chart: Chart | null = null;

  return {
    root: c.root,
    show(data: unknown): void {
      const d = parseSweep(data);
      chart?.destroy();
      chart = null;
      c.body.innerHTML = '';
      if (!d) {
        c.body.append(el('div', 'rn-empty', 'Sweep data missing or malformed (run npm run sweep).'));
        c.show();
        return;
      }
      c.body.append(el('div', 'rn-status', 'Share of requests reaching clinics intact, as more carriers break down'));
      const wrap = el('div', 'rn-sweep');
      const canvas = el('canvas');
      wrap.append(canvas);
      c.body.append(wrap);
      c.show(); // must be visible before chart.js measures the canvas
      const line = (label: string, data: number[], color: string) => ({
        label, data, borderColor: color, backgroundColor: color, borderWidth: 2.5, pointRadius: 3, tension: 0.2,
      });
      chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: d.kill.map(killLabel),
          datasets: [line('Today', d.central, COLORS.central), line('Runners', d.mesh, COLORS.mesh)],
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { title: { display: true, text: 'Carriers lost', color: COLORS.dim, font: { size: 14 } },
                 ticks: { color: COLORS.dim, font: { size: 13 } }, grid: { color: COLORS.grid } },
            y: { min: 0, max: 100, title: { display: true, text: 'Reach', color: COLORS.dim, font: { size: 14 } },
                 ticks: { color: COLORS.dim, font: { size: 13 }, callback: (v) => `${v}%` }, grid: { color: COLORS.grid } },
          },
          plugins: { legend: { align: 'end', labels: { color: COLORS.text, font: { size: 13 }, usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7 } } },
        },
      });
    },
  };
}
