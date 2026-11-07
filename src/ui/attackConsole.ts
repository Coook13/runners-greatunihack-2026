// Attack Console (PLAN 12.3): one button per attack. The engine fires it; the outcome line comes back
// through showAttackResult, and security alerts from snapshots show here too.
import type { Alert, UiHandlers } from '../contracts/types';
import { el, panel } from './dom';
import { RESEND_EVERY } from '../contracts/config';
import { ATTACKS, alertKey, clock, isLossAlert } from './format';

const MAX_LINES = 6;

export function createAttackConsole(h: UiHandlers) {
  const p = panel('Attack Console');
  const grid = el('div', 'rn-attacks');
  for (const a of ATTACKS) {
    const b = el('button', '', a.label);
    b.title = a.hint;
    b.addEventListener('click', () => {
      h.onEvent({ type: a.type });
      result(`${a.label}: ${a.hint.toLowerCase()}...`);
    });
    grid.append(b);
  }
  const out = el('div', 'rn-result');
  p.body.append(grid, out);
  const seen = new Set<string>();

  function result(line: string): void {
    const row = el('div', '', line);
    out.prepend(row);  // newest first, shown bold
    while (out.children.length > MAX_LINES) out.lastElementChild?.remove();
  }

  return {
    root: p.root,
    showResult: result,
    /** Security alerts (bad signature, replay, no cert...) are the visible proof an attack was blocked. */
    addAlerts(alerts: Alert[]): void {
      for (const a of alerts) {
        if (isLossAlert(a)) continue;
        // Same alert re-raised by several nodes within one resend window shows once.
        const k = `${alertKey(a)}|${Math.floor(a.t / RESEND_EVERY)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        result(`${clock(a.t)} ${a.text}`);
      }
    },
    reset(): void { out.innerHTML = ''; seen.clear(); },
  };
}
