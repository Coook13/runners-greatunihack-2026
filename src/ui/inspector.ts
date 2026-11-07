// Inspector: what the selected node is, what it can read, and its last decisions.
import type { BreachDump, NodeId, NodeKind } from '../contracts/types';
import { el, panel } from './dom';
import { labelLine, LOG_LINES } from './format';

export type InspectInfo = { id: NodeId; kind: NodeKind; dump: BreachDump; logs: string[] };

export function createInspector() {
  const p = panel('Inspector');
  const empty = el('div', 'rn-empty', 'Click a node on the map to inspect it.');
  p.body.append(empty);

  function show(info: InspectInfo | null): void {
    p.body.innerHTML = '';
    if (!info) { p.body.append(empty); return; }
    const d = info.dump;
    const stores = d.knownLocations.filter((l) => l.what === 'store').length;

    const kv = el('div', 'rn-kv');
    const row = (k: string, v: string | HTMLElement) => {
      kv.append(el('span', 'rn-k', k));
      const cell = typeof v === 'string' ? el('span', '', v) : v;
      kv.append(cell);
    };
    row('Node', info.id);
    row('Kind', info.kind);
    row('Labels it can read', String(d.readableLabels.length));
    row('Next hop', d.nextHop ?? 'none');
    row('Contents', d.readableBeneficiaryNotes.length
      ? el('span', 'rn-bad-text', `readable (${d.readableBeneficiaryNotes.length} clinic notes)`)
      : el('span', 'rn-sealed', 'sealed'));
    row('Knows stores', String(stores));
    p.body.append(kv);

    if (d.readableLabels.length) {
      const ul = el('ul', 'rn-list');
      for (const l of d.readableLabels) ul.append(el('li', '', labelLine(l)));
      p.body.append(ul);
    }

    const logs = el('div', 'rn-logs');
    const last = info.logs.slice(-LOG_LINES);
    if (!last.length) logs.append(el('div', 'rn-empty', 'No decisions logged yet.'));
    for (const line of last) logs.append(el('div', '', line));
    p.body.append(logs);
    logs.scrollTop = logs.scrollHeight;
  }

  return { root: p.root, show };
}
