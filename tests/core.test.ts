import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeySet, open, seal, sign, verify } from '../src/privacy/core';

describe('core crypto', () => {
  it('seal/open round-trips and rejects the wrong key or tampering', async () => {
    const a = await generateKeySet();
    const b = await generateKeySet();
    const s = await seal({ hello: 'clinic', n: 3 }, a.sealPub);
    expect(await open(s, a.sealPriv)).toEqual({ hello: 'clinic', n: 3 });
    await expect(open(s, b.sealPriv)).rejects.toThrow();
    const tampered = { ...s, ct: s.ct.slice(0, -4) + (s.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(open(tampered, a.sealPriv)).rejects.toThrow();
  });

  it('sign/verify is key-order independent and catches edits', async () => {
    const k = await generateKeySet();
    const sig = await sign({ b: 2, a: 1 }, k.signPriv);
    expect(await verify({ a: 1, b: 2 }, sig, k.signPub)).toBe(true);
    expect(await verify({ a: 1, b: 3 }, sig, k.signPub)).toBe(false);
    expect(await verify({ a: 1, b: 2 }, 'garbage', k.signPub)).toBe(false);
  });
});

// Proof of decentralisation: agent code never reaches into the simulator's global state.
describe('decentralisation', () => {
  it('src/agents never imports from src/sim', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const offenders = walk('src/agents').filter((f) => /from\s+['"][^'"]*\/sim(\/|['"])/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
