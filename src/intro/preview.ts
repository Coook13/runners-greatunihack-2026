// Dev preview for the intro (/?dev=intro). Plays the fly-in over a stand-in for the main map,
// with Replay / Skip buttons and a duration picker. R replays, Esc or a click skips.
import { playIntro, type IntroHandle } from './index';

export function mountIntroPreview(root: HTMLElement): () => void {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;z-index:5;background:linear-gradient(#8fb8d8,#f3dfbf 60%,#e9dcc4);overflow:hidden';
  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#3b3a33;font:500 18px system-ui;opacity:.75';
  backdrop.textContent = 'Main map takes over here';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;top:12px;right:12px;z-index:10;display:flex;gap:6px;align-items:center;font:12px system-ui;color:#fff';
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.35);background:rgba(10,14,20,.55);color:#fff;cursor:pointer';
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    bar.appendChild(b);
    return b;
  };
  const dur = document.createElement('select');
  for (const s of [8, 12, 16, 20]) dur.add(new Option(`${s}s`, String(s), s === 12, s === 12));
  dur.style.cssText = 'padding:5px;border-radius:6px;background:rgba(10,14,20,.55);color:#fff;border:1px solid rgba(255,255,255,.35)';
  const hold = document.createElement('label');
  hold.innerHTML = '<input type="checkbox"> hold last frame';
  wrap.append(backdrop, canvas, bar);
  root.appendChild(wrap);

  let intro: IntroHandle | null = null;
  const start = () => {
    intro?.dispose();
    canvas.style.pointerEvents = '';
    intro = playIntro(canvas, {
      durationSec: Number(dur.value),
      fadeOutSec: (hold.querySelector('input') as HTMLInputElement).checked ? 0 : 0.9,
      onDone: () => console.info('[intro] done'),
    });
  };
  btn('Replay', start);
  btn('Skip', () => intro?.skip());
  bar.append(dur, hold);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'r' || e.key === 'R') start(); };
  window.addEventListener('keydown', onKey);
  start();

  return () => {
    window.removeEventListener('keydown', onKey);
    intro?.dispose();
    wrap.remove();
  };
}
