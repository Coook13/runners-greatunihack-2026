// Before / after: the card that opens and closes the demo. Today's paper manifests on the left,
// Runners' black box on the right, with live numbers from both runs filled in.
import type { Metrics } from '../contracts/types';
import { pct } from './format';
import { h, icon, injectStoryStyles, type IconName } from './storyStyles';

export interface BeforeAfterStats { today: Metrics; runners: Metrics; todayExposure: number; runnersExposure: number }

const TODAY = [
  'Every crew member carries the full manifest',
  'Losses found at month-end stock count',
  'A stolen phone or clipboard exposes every clinic and child count',
  'Network down: dispatch stops',
];
const RUNNERS = [
  'Crew follows the black box; contents sealed',
  'Loss pinned to the exact hand-off within minutes',
  'A stolen device exposes one next stop',
  'Network down: the swarm keeps delivering',
];

/** Losses so far and how many an alert pinned to a named holder. */
export function lossStats(m: Metrics): { losses: number; pinned: number } {
  const n = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const losses = n(m.skimmed) + n(m.stolen) + n(m.deliveredShort);
  return { losses, pinned: Math.min(n(m.leaksPinpointed), losses) };
}

/** The three live numbers under each side. */
export function sideStats(m: Metrics | undefined, exposure: number): { value: string; label: string }[] {
  if (!m) return [{ value: '-', label: 'Reach' }, { value: '-', label: 'Losses pinned to a hand-off' }, { value: '-', label: 'Exposure from one stolen device' }];
  const { losses, pinned } = lossStats(m);
  return [
    { value: pct(m.reachPct), label: 'Reach: requests filled intact' },
    losses ? { value: `${pinned} of ${losses}`, label: 'Losses pinned to a hand-off' } : { value: '0', label: 'Losses so far' },
    { value: Number.isFinite(exposure) ? String(Math.round(exposure)) : '-', label: 'Exposure score from one stolen device' },
  ];
}

export function createBeforeAfter(root: HTMLElement, opts: { onClose?: () => void } = {}) {
  injectStoryStyles();
  const wrap = h('section', 'sb sb-ba sb-hidden');
  wrap.setAttribute('aria-label', 'Before and after');
  root.append(wrap);

  function side(cls: string, ic: IconName, name: string, sub: string, lines: string[], mark: IconName, m: Metrics | undefined, exposure: number): HTMLElement {
    const s = h('div', `sb-ba-side ${cls}`);
    const head = h('div', 'sb-ba-head');
    const txt = h('div');
    txt.append(h('h3', '', name), h('p', '', sub));
    head.append(icon(ic, 56), txt);
    const ul = h('ul', 'sb-ba-lines');
    for (const l of lines) {
      const li = h('li');
      li.append(icon(mark, 20), h('span', '', l));
      ul.append(li);
    }
    const stats = h('div', 'sb-ba-stats');
    for (const st of sideStats(m, exposure)) {
      const b = h('div', 'sb-ba-stat');
      b.append(h('b', '', st.value), h('span', '', st.label));
      stats.append(b);
    }
    s.append(head, ul, stats);
    return s;
  }

  function show(stats: BeforeAfterStats): void {
    const card = h('div', 'sb-ba-card');
    const top = h('div', 'sb-ba-top');
    const titles = h('div');
    titles.append(h('div', 'sb-ba-kicker', 'Hawassa, Ethiopia · the change we are making'), h('div', 'sb-ba-title', 'Today vs Runners'));
    const close = h('button', '', 'Close');
    close.addEventListener('click', () => { hide(); opts.onClose?.(); });
    top.append(titles, h('span', 'sb-space'), close);
    const sides = h('div', 'sb-ba-sides');
    sides.append(
      side('sb-today', 'clipboard', 'Today', 'Paper and spreadsheet manifests, central dispatch', TODAY, 'cross', stats.today, stats.todayExposure),
      side('sb-runners', 'blackbox', 'Runners', 'A black box in every vehicle', RUNNERS, 'check', stats.runners, stats.runnersExposure),
    );
    card.append(top, sides, h('div', 'sb-ba-foot', 'Numbers are live from this run. Exposure score = store locations + stock levels + readable notes on children.'));
    wrap.replaceChildren(card);
    wrap.classList.remove('sb-hidden');
  }

  function hide(): void {
    wrap.classList.add('sb-hidden');
  }

  return { root: wrap, show, hide, isShown: () => !wrap.classList.contains('sb-hidden') };
}
