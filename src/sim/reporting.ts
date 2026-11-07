// Reports travel home. An alert only counts as RECEIVED when it physically reaches the district office over
// the network: radio links hop by hop, or the cell network when both ends have signal. Until then the reporting
// node carries it (a mule), so jammed or remote areas report late, honestly.
import type { Alert, NodeId, ReportReceived, Snapshot } from '../contracts/types';

export interface Reporting {
  step(s: Snapshot): ReportReceived[];
  pending(): number;
}

export function createReporting(office: NodeId = 'store-A'): Reporting {
  const queue: { alert: Alert; carrier: NodeId }[] = [];
  const seen = new Set<string>();

  return {
    pending: () => queue.length,
    step(s) {
      for (const a of s.newAlerts) {
        const key = `${a.t}|${a.kind}|${a.reportedBy}|${a.packageId ?? ''}`;
        if (!seen.has(key)) { seen.add(key); queue.push({ alert: a, carrier: a.reportedBy }); }
      }
      if (!queue.length) return [];

      // Hop counts from the office over this tick's radio links (breadth-first).
      const adj = new Map<NodeId, NodeId[]>();
      for (const [a, b] of s.links) {
        (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
        (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
      }
      const hops = new Map<NodeId, number>([[office, 0]]);
      const frontier = [office];
      while (frontier.length) {
        const cur = frontier.shift()!;
        for (const nb of adj.get(cur) ?? []) if (!hops.has(nb)) { hops.set(nb, hops.get(cur)! + 1); frontier.push(nb); }
      }
      const signal = new Map(s.nodes.map((n) => [n.id, s.cellNetworkUp && n.cellSignal]));
      const officeSignal = signal.get(office) ?? false;

      const out: ReportReceived[] = [];
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        const h = hops.get(q.carrier);
        const viaCell = officeSignal && (signal.get(q.carrier) ?? false);
        if (h !== undefined || viaCell) {
          out.push({ alert: q.alert, receivedAt: s.t, hops: h ?? 1 });
          queue.splice(i, 1);
        }
      }
      return out.reverse();
    },
  };
}
