// Seeded randomness (mulberry32). Every sim decision draws from one of these, never Math.random,
// so the same seed always replays the same run.

export type Rng = () => number;

/** mulberry32: tiny, fast, good enough for a simulation. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string, used to give every agent its own stream from one run seed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Independent stream for one named purpose ('scenario', 'drone-03', ...). */
export const childRng = (seed: number, name: string): Rng => mulberry32((seed ^ hashString(name)) >>> 0);

export const randInt = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive
export const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
