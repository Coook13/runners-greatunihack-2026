// Ledger view: the merged report after NETWORK UP, as a sidebar section. Counts as tiles, then every finding.
import type { LedgerReport, LeakFinding, UiHandlers } from '../contracts/types';
import { el, panel } from './dom';
import { findingKindLabel, findingLine } from './format';

export function createLedgerView(h: UiHandlers) {
  const c = panel('Ledger merged');
  c.root.classList.add('rn-hidden');   // appears with the first merge

  return {
    root: c.root,
    show(r: LedgerReport): void {
      c.body.innerHTML = '';
      c.body.append(el('div', 'rn-headline',
        `${r.boxes} boxes: ${r.deliveredIntact} delivered intact, ${r.skimmed} skimmed (hop named), ${r.stolen} stolen, ` +
        `${r.lostBreakdown} lost in breakdowns, ${r.inTransit} in transit, ${r.duplicates} duplicates caught.`));

      const tiles = el('div', 'rn-ledger');
      const tile = (n: number, label: string, bad = false) => {
        const t = el('div', `rn-tile${bad && n > 0 ? ' rn-bad' : ''}`);
        t.append(el('b', '', String(n)), el('span', '', label));
        tiles.append(t);
      };
      tile(r.boxes, 'boxes');
      tile(r.deliveredIntact, 'delivered intact');
      tile(r.deliveredShort, 'delivered short', true);
      tile(r.skimmed, 'skimmed', true);
      tile(r.stolen, 'stolen', true);
      tile(r.lostBreakdown, 'lost in breakdowns');
      tile(r.inTransit, 'in transit');
      tile(r.duplicates, 'duplicates');
      tile(r.badSignatures, 'bad signatures', true);
      c.body.append(tiles);

      const ul = el('ul', 'rn-list');
      if (!r.findings.length) ul.append(el('li', 'rn-empty', 'No losses: every box is accounted for.'));
      for (const f of r.findings) ul.append(findingRow(f));
      c.body.append(ul);
      c.root.classList.remove('rn-hidden', 'rn-collapsed');
    },
  };

  function findingRow(f: LeakFinding): HTMLElement {
    const li = el('li', 'rn-finding');
    li.append(el('span', 'rn-tag', findingKindLabel[f.kind]), findingLine(f));
    li.addEventListener('click', () => h.onFindingClick(f));
    return li;
  }
}
