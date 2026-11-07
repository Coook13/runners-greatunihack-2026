// 2D minimap of the other run in split mode (PLAN 13 #13: one 3D scene + one flat map keeps laptops cool).
import { WORLD_SIZE } from '../contracts/config';
import type { NodeKind, Snapshot } from '../contracts/types';
import { COLORS, el, panel } from './dom';

const KIND_COLOR: Record<NodeKind, string> = {
  drone: '#b9d7e8', motorbike: '#e6ebe8', van: '#c9b48a', boat: '#8fb3d9',
  store: '#d4a05e', clinic: '#7fc2a6', dispatch: '#de8a76',
};
const KIND_SIZE: Record<NodeKind, number> = { drone: 2.5, motorbike: 2.5, van: 3.5, boat: 3.5, store: 6, clinic: 5, dispatch: 7 };

export function createMinimap() {
  const p = panel('Other run');
  p.root.classList.add('rn-hidden');
  const wrap = el('div', 'rn-mini');
  const canvas = el('canvas');
  canvas.width = 600; canvas.height = 600;  // drawn at 2x for sharpness, CSS scales it down
  const tag = el('div', 'rn-tagline');
  wrap.append(canvas, tag);
  p.body.append(wrap);
  const ctx = canvas.getContext('2d');

  // World metres to canvas pixels; y flips because the world origin is bottom-left.
  const sx = (x: number) => (x / WORLD_SIZE) * canvas.width;
  const sy = (y: number) => canvas.height - (y / WORLD_SIZE) * canvas.height;
  const sr = (r: number) => (r / WORLD_SIZE) * canvas.width;

  function draw(s: Snapshot): void {
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(222,138,118,0.18)';
    for (const z of s.deadZones) { ctx.beginPath(); ctx.arc(sx(z.pos.x), sy(z.pos.y), sr(z.radius), 0, Math.PI * 2); ctx.fill(); }

    const pos = new Map(s.nodes.map((n) => [n.id, n.pos]));
    ctx.strokeStyle = 'rgba(230,235,232,0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [a, b] of s.links) {
      const pa = pos.get(a), pb = pos.get(b);
      if (!pa || !pb) continue;
      ctx.moveTo(sx(pa.x), sy(pa.y)); ctx.lineTo(sx(pb.x), sy(pb.y));
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(230,235,232,0.45)';
    for (const hub of s.hubs) { ctx.strokeRect(sx(hub.pos.x) - 7, sy(hub.pos.y) - 7, 14, 14); }

    for (const n of s.nodes) {
      const r = KIND_SIZE[n.kind] * 2;
      ctx.globalAlpha = n.alive ? 1 : 0.3;
      ctx.fillStyle = n.fake ? COLORS.bad : KIND_COLOR[n.kind];
      ctx.beginPath(); ctx.arc(sx(n.pos.x), sy(n.pos.y), r, 0, Math.PI * 2); ctx.fill();
      if (n.boxes.length) { ctx.strokeStyle = COLORS.text; ctx.lineWidth = 2; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;

    const name = s.mode === 'mesh' ? 'Runners mesh' : 'Central dispatch';
    tag.textContent = `${name}: reach ${Math.round(s.metrics.reachPct)}%${s.cellNetworkUp ? '' : ', network down'}`;
    tag.style.color = s.mode === 'mesh' ? COLORS.mesh : COLORS.central;
    p.title.textContent = name;
  }

  return {
    root: p.root,
    draw,
    setVisible(on: boolean): void { p.root.classList.toggle('rn-hidden', !on); },
  };
}
