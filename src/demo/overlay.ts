// Caption overlay for the auto-play demo: one large line, bottom centre, fades between captions.
// It lifts itself above any open bottom card (breach, ledger, sweep) so it never covers the numbers.
// Plain DOM, no dependencies. Readable from the back of a room at 1920x1080.

export interface CaptionOverlay {
  show(text: string): void;
  hide(): void;
  setStatus(text: string | null): void;   // small pill above the caption, e.g. "Paused"
  dispose(): void;
  readonly root: HTMLElement;
}

const FADE_MS = 260;
const STYLE_ID = 'rn-demo-caption-style';
const CSS = `
.rn-demo-cap-wrap { position: fixed; left: 50%; bottom: 44px; transform: translateX(-50%); z-index: 1000;
  display: flex; flex-direction: column; align-items: center; gap: 10px; pointer-events: none;
  width: max(560px, min(1180px, calc(100vw - 780px))); transition: bottom 300ms ease; }
.rn-demo-cap { font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: clamp(22px, 1.9vw, 40px); font-weight: 600; line-height: 1.3; color: #ffffff; text-align: center;
  background: rgba(8, 12, 10, 0.84); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px;
  padding: 16px 30px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  opacity: 0; transform: translateY(8px); transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease; }
.rn-demo-cap.rn-on { opacity: 1; transform: translateY(0); }
.rn-demo-pill { font: 600 14px/1 Inter, system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase;
  color: #0f1412; background: #f2c14e; border-radius: 999px; padding: 7px 14px; }
.rn-demo-pill[hidden] { display: none; }
`;

export function createCaptionOverlay(parent: HTMLElement = document.body): CaptionOverlay {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }
  const root = document.createElement('div');
  root.className = 'rn-demo-cap-wrap';
  root.setAttribute('aria-live', 'polite');
  const pill = document.createElement('div');
  pill.className = 'rn-demo-pill';
  pill.hidden = true;
  const cap = document.createElement('div');
  cap.className = 'rn-demo-cap';
  root.append(pill, cap);
  parent.append(root);

  let token = 0;            // a newer show() or hide() cancels an older fade
  let visible = false;

  // Sit above the open bottom card, if there is one.
  const lift = () => {
    let bottom = 44;
    for (const c of Array.from(document.querySelectorAll<HTMLElement>('.rn-card'))) {
      if (c.classList.contains('rn-hidden') || c.offsetParent === null) continue;
      const r = c.getBoundingClientRect();
      if (r.height > 0 && r.top < innerHeight) bottom = Math.max(bottom, innerHeight - r.top + 16);
    }
    root.style.bottom = `${Math.round(bottom)}px`;
  };
  const liftTimer = setInterval(() => visible && lift(), 400);

  return {
    root,
    show(text: string) {
      const my = ++token;
      lift();
      if (!visible || cap.textContent === text) {
        cap.textContent = text;
        cap.classList.add('rn-on');
        visible = true;
        return;
      }
      cap.classList.remove('rn-on');          // fade out, swap, fade in
      setTimeout(() => {
        if (my !== token) return;
        cap.textContent = text;
        cap.classList.add('rn-on');
      }, FADE_MS);
      visible = true;
    },
    hide() {
      ++token;
      visible = false;
      cap.classList.remove('rn-on');
    },
    setStatus(text: string | null) {
      pill.hidden = !text;
      pill.textContent = text ?? '';
    },
    dispose() {
      ++token;
      clearInterval(liftTimer);
      root.remove();
    },
  };
}
