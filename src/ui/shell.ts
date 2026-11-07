// Page shell: the top row (wordmark, page switch slot, right cluster), the one sidebar that holds every panel,
// keyboard shortcuts, hide-all and a small toast. No sim knowledge: index.ts wires the panels in.
import { el } from './dom';

const SIDEBAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/></svg>';

export interface Shell {
  /** Top row right cluster: put the tool chip and network pill here (the sidebar button is already last). */
  cluster: HTMLElement;
  side: HTMLElement;
  sideButton: HTMLButtonElement;
  toastEl: HTMLElement;
  /** Register a section; it goes at the end, or before `before` when given. */
  addSection(id: string, node: HTMLElement, before?: HTMLElement): void;
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Open the sidebar at a section. auto = opened by an event: closes itself after `ms` unless someone uses it. */
  focus(id: string, opts?: { auto?: boolean; ms?: number }): void;
  setHidden(on: boolean): void;
  hidden(): boolean;
  toast(parts: (string | HTMLElement)[], ms?: number): void;
  onOpenChange(fn: (open: boolean) => void): void;
}

export function createShell(host: HTMLElement, ui: HTMLElement): Shell {
  const mark = el('div', 'rn-mark', 'Runners');
  const cluster = el('div', 'rn-tr');
  const sideButton = el('button', 'rn-iconbtn');
  sideButton.innerHTML = SIDEBAR_ICON;
  sideButton.dataset.tip = 'Panels (Tab or \\)';
  sideButton.setAttribute('aria-label', 'Panels');
  const badge = el('span', 'rn-badge');
  sideButton.append(badge);
  cluster.append(sideButton);

  const side = el('aside', 'rn-side');
  side.setAttribute('aria-label', 'Panels');
  const toastEl = el('div', 'rn-toast');
  ui.append(mark, cluster, side, toastEl);

  const sections = new Map<string, HTMLElement>();
  const openListeners: ((open: boolean) => void)[] = [];
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let autoOpened = false;
  let hovering = false;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  side.addEventListener('pointerenter', () => { hovering = true; });
  side.addEventListener('pointerleave', () => { hovering = false; });
  // Any click inside means someone is using it: keep it open.
  side.addEventListener('pointerdown', () => { autoOpened = false; clearTimeout(autoTimer); });

  // One source of truth for open/closed: body.sb-closed (main.ts toggles it too), so every toggle agrees.
  const body = document.body;
  const paint = () => {
    const on = !body.classList.contains('sb-closed');
    if (side.classList.contains('rn-open') === on) return;
    side.classList.toggle('rn-open', on);
    sideButton.classList.toggle('rn-on', on);
    host.classList.toggle('rn-side-on', on);
    if (!on) { autoOpened = false; clearTimeout(autoTimer); }
    openListeners.forEach((f) => f(on));
  };
  const setOpen = (on: boolean) => { body.classList.toggle('sb-closed', !on); paint(); };
  body.classList.add('sb-closed');   // closed by default
  new MutationObserver(paint).observe(body, { attributes: true, attributeFilter: ['class'] });
  const open = () => { autoOpened = false; clearTimeout(autoTimer); setOpen(true); };
  const close = () => { autoOpened = false; clearTimeout(autoTimer); setOpen(false); };
  const isOpen = () => side.classList.contains('rn-open');
  sideButton.addEventListener('click', () => (isOpen() ? close() : open()));

  const autoClose = () => {
    if (!autoOpened) return;
    if (hovering) { autoTimer = setTimeout(autoClose, 1500); return; }
    autoOpened = false;
    setOpen(false);
  };

  function focus(id: string, opts: { auto?: boolean; ms?: number } = {}): void {
    const s = sections.get(id);
    if (opts.auto) {
      if (!isOpen()) { setOpen(true); autoOpened = true; }
      if (autoOpened) { clearTimeout(autoTimer); autoTimer = setTimeout(autoClose, opts.ms ?? 8000); }
    } else {
      open();
    }
    if (!s) return;
    s.classList.remove('rn-collapsed');
    s.classList.add('rn-flash');
    setTimeout(() => s.classList.remove('rn-flash'), 1800);
    // Wait a frame so a just-expanded section has its height before scrolling to it.
    requestAnimationFrame(() => side.scrollTo({ top: Math.max(0, s.offsetTop - 6), behavior: 'smooth' }));
  }

  return {
    cluster,
    side,
    sideButton,
    toastEl,
    addSection(id, node, before) { sections.set(id, node); if (before) side.insertBefore(node, before); else side.append(node); },
    isOpen,
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
    focus,
    setHidden(on) {
      host.classList.toggle('rn-ui-off', on);
      document.documentElement.classList.toggle('rn-ui-off', on);
    },
    hidden: () => host.classList.contains('rn-ui-off'),
    toast(parts, ms = 4000) {
      toastEl.replaceChildren(...parts);
      toastEl.classList.add('rn-on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('rn-on'), ms);
    },
    onOpenChange: (fn) => { openListeners.push(fn); },
  };
}

/** A keyboard hint chip for toasts. */
export const kbd = (k: string): HTMLElement => el('span', 'rn-kbd', k);

/** True when a key press belongs to a text field, not to the page shortcuts. */
export function typing(t: EventTarget | null): boolean {
  const n = t as HTMLElement | null;
  if (!n || !n.tagName) return false;
  return n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable;
}
