// Leak Finder: live list of pinpointed losses from Snapshot.newAlerts. Click one to highlight the holder.
import type { Alert, LeakFinding, UiHandlers } from '../contracts/types';
import { el, panel } from './dom';
import { alertToFinding, clock, findingKey, findingKindLabel, findingLine, isLossAlert } from './format';

const MAX_ROWS = 40;

export function createLeakFinder(h: UiHandlers) {
  const p = panel('Leak Finder');
  const ul = el('ul', 'rn-list');
  const empty = el('div', 'rn-empty', 'No losses detected. Skim or steal a box to test it.');
  p.body.append(empty, ul);
  const seen = new Set<string>();
  let count = 0;

  function addFinding(f: LeakFinding, fresh: boolean): boolean {
    const key = findingKey(f);
    if (seen.has(key)) return false;
    seen.add(key);
    count++;
    empty.classList.add('rn-hidden');
    const li = el('li', `rn-finding${fresh ? ' rn-fresh' : ''}`);
    li.append(el('span', 'rn-tag', findingKindLabel[f.kind]), findingLine(f), el('span', 'rn-meta', clock(f.t)));
    li.addEventListener('click', () => h.onFindingClick(f));
    ul.prepend(li);  // newest on top
    while (ul.children.length > MAX_ROWS) ul.lastElementChild?.remove();
    p.title.textContent = `Leak Finder (${count})`;
    return true;
  }

  return {
    root: p.root,
    /** Feed every snapshot's newAlerts; non-loss alerts are ignored here. Returns how many new losses were listed. */
    addAlerts(alerts: Alert[]): number {
      let added = 0;
      for (const a of alerts) if (isLossAlert(a) && addFinding(alertToFinding(a), true)) added++;
      return added;
    },
    count: () => count,
    /** Ledger findings after NETWORK UP; skips boxes already listed live. */
    addFindings(fs: LeakFinding[]): void {
      for (const f of fs) addFinding(f, false);
    },
    reset(): void {
      seen.clear(); count = 0; ul.innerHTML = '';
      empty.classList.remove('rn-hidden');
      p.title.textContent = 'Leak Finder';
    },
  };
}
