// Playback bar: play/pause, speed presets, skip ahead, reset, and the sim clock. Bottom centre, above the maps.
// Keyboard: Space = play/pause, + / - = faster / slower, ] = skip ahead one sim-hour.

export const SPEEDS = [1, 10, 30, 60, 120, 300];

const CSS = `
.pb { position:absolute; left:50%; bottom:16px; transform:translateX(-50%); z-index:6; display:flex; align-items:center; gap:6px;
  padding:8px 10px; border-radius:14px; background:rgba(14,20,18,.86); backdrop-filter:blur(8px);
  border:1px solid rgba(255,255,255,.09); box-shadow:0 8px 30px rgba(0,0,0,.4); color:#e8ece9;
  font:600 clamp(15px,1.2vw,19px)/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; user-select:none; }
.pb button { border:0; border-radius:10px; background:rgba(255,255,255,.06); color:inherit; font:inherit; padding:10px 14px; cursor:pointer; }
.pb button:hover { background:rgba(255,255,255,.14); }
.pb button.on { background:#2f8f83; color:#fff; }
.pb .play { width:54px; font-size:1.25em; background:#2f8f83; color:#fff; }
.pb .play.paused { background:#c98a2b; }
.pb .clock { min-width:9.5em; text-align:center; font-variant-numeric:tabular-nums; color:#cfe3da; padding:0 6px; }
.pb .sep { width:1px; height:22px; background:rgba(255,255,255,.12); margin:0 2px; }
`;

export interface PlaybackHandlers {
  onPlayPause(playing: boolean): void;
  onSpeed(x: number): void;
  onSkip(simSec: number): void;
  onReset(): void;
}

export interface Playback {
  setTime(simSec: number): void;
  setPlaying(p: boolean): void;
  setSpeed(x: number): void;
  playing(): boolean;
  speed(): number;
}

const clock = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  const day = Math.floor(s / 86400) + 1;
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `Day ${day}  ${hh}:${mm}`;
};

export function createPlayback(root: HTMLElement, h: PlaybackHandlers, init: { speed: number; playing?: boolean; keys?: boolean }): Playback {
  if (!document.getElementById('pb-css')) {
    const st = document.createElement('style');
    st.id = 'pb-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  let playing = init.playing ?? true;
  let speed = init.speed;
  const bar = document.createElement('div');
  bar.className = 'pb';
  bar.innerHTML = `<button class="reset" title="Reset to the start (same seed)">&#x23EE;</button>
    <button class="play" title="Play / pause (Space)"></button>
    <span class="clock"></span><span class="sep"></span>
    ${SPEEDS.map((x) => `<button class="sp" data-x="${x}" title="${x} sim-seconds per second">${x}x</button>`).join('')}
    <span class="sep"></span><button class="skip" title="Skip ahead one sim-hour (])">+1 h</button>`;
  root.appendChild(bar);
  const playBtn = bar.querySelector<HTMLButtonElement>('.play')!;
  const clockEl = bar.querySelector<HTMLSpanElement>('.clock')!;

  const paint = () => {
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.classList.toggle('paused', !playing);
    bar.querySelectorAll<HTMLButtonElement>('.sp').forEach((b) => b.classList.toggle('on', Number(b.dataset.x) === speed));
  };
  const setPlaying = (p: boolean) => { playing = p; paint(); h.onPlayPause(p); };
  const setSpeed = (x: number) => { speed = x; paint(); h.onSpeed(x); };

  playBtn.onclick = () => setPlaying(!playing);
  bar.querySelector<HTMLButtonElement>('.reset')!.onclick = () => h.onReset();
  bar.querySelector<HTMLButtonElement>('.skip')!.onclick = () => h.onSkip(3600);
  bar.querySelectorAll<HTMLButtonElement>('.sp').forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.x))));

  if (init.keys !== false) {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
      else if (e.key === '+' || e.key === '=') setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)] ?? speed);
      else if (e.key === '-') setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)] ?? speed);
      else if (e.key === ']') h.onSkip(3600);
    });
  }
  paint();
  return {
    setTime: (t) => { clockEl.textContent = clock(t); },
    setPlaying: (p) => { playing = p; paint(); },
    setSpeed: (x) => { speed = x; paint(); },
    playing: () => playing,
    speed: () => speed,
  };
}
