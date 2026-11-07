// Breach card: what an attacker gets from one hacked device, mesh vs central side by side.
import type { BreachDump } from '../contracts/types';
import { card, el } from './dom';
import { exposure, exposureLines } from './format';

export function createBreachCard() {
  const c = card('Data exposed');

  function side(name: string, cls: string, d: BreachDump | null): HTMLElement {
    const box = el('div', `rn-side-col ${cls}`);
    box.append(el('h3', '', name));
    if (!d) {
      box.append(el('div', 'rn-empty', 'Not breached yet. Pick the Breach tool and click a node.'));
      return box;
    }
    const e = exposure(d);
    box.append(el('div', 'rn-status', `Hacked device: ${d.nodeId}`));
    const ul = el('ul');
    // The first three lines feed the score; colour them when they leak anything.
    const hot = [e.stores > 0, e.stock > 0, e.notes > 0, false, false];
    exposureLines(e).forEach((line, i) => ul.append(el('li', hot[i] ? 'rn-hot' : '', line)));
    box.append(ul);
    return box;
  }

  return {
    root: c.root,
    show(mesh: BreachDump | null, central: BreachDump | null): void {
      if (!mesh && !central) { c.hide(); return; }
      c.body.innerHTML = '';
      c.body.append(el('div', 'rn-status', 'Information readable on the selected device. Clinic notes contain counts, never names.'));
      const sides = el('div', 'rn-sides');
      // Today left, Runners right: the same order as the maps on the compare page.
      sides.append(side('Today: central dispatch', 'rn-central', central), side('Runners', 'rn-mesh', mesh));
      c.body.append(sides);
      c.show();
    },
  };
}
