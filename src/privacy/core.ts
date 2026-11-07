// Core crypto, written by the lead so every WP can use it from minute one. WP3 builds on top of this file.
// WebCrypto only (built into browsers and Node 24). P-256 ECDH + HKDF + AES-GCM to seal, ECDSA P-256 to sign.
import type { KeySet, Sealed } from '../contracts/types';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export const toB64 = (u8: Uint8Array): string => {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
};
export const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Sorted keys at every level, so the same object always signs to the same bytes.
export const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

const exportRaw = async (k: CryptoKey) => toB64(new Uint8Array(await subtle.exportKey('raw', k)));

export async function generateKeySet(): Promise<KeySet> {
  const s = (await subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  const g = (await subtle.generateKey(ECDSA, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { sealPub: await exportRaw(s.publicKey), sealPriv: s.privateKey, signPub: await exportRaw(g.publicKey), signPriv: g.privateKey };
}

async function aesKey(priv: CryptoKey, pubRawB64: string, salt: Uint8Array<ArrayBuffer>, usage: KeyUsage): Promise<CryptoKey> {
  const pub = await subtle.importKey('raw', fromB64(pubRawB64), ECDH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('runners-v1') },
    hk, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

/** Seal any JSON-able object so only the holder of recipientSealPub's private key can open it. */
export async function seal(obj: unknown, recipientSealPub: string): Promise<Sealed> {
  const eph = (await subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  const epk = await exportRaw(eph.publicKey);
  const key = await aesKey(eph.privateKey, recipientSealPub, fromB64(epk), 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { epk, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Open a sealed object. Throws if the key is wrong or a single byte was changed. */
export async function open<T = unknown>(sealed: Sealed, sealPriv: CryptoKey): Promise<T> {
  const key = await aesKey(sealPriv, sealed.epk, fromB64(sealed.epk), 'decrypt');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv) }, key, fromB64(sealed.ct));
  return JSON.parse(dec.decode(pt)) as T;
}

/** Sign the canonical form of obj. */
export async function sign(obj: unknown, signPriv: CryptoKey): Promise<string> {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signPriv, enc.encode(canonical(obj)));
  return toB64(new Uint8Array(sig));
}

/** Imported public keys, by their base64 (importing costs as much as a verify; every node meets the same few keys). */
const verifyKeys = new Map<string, Promise<CryptoKey>>();
const verifyKey = (b64: string): Promise<CryptoKey> => {
  let k = verifyKeys.get(b64);
  if (!k) {
    k = subtle.importKey('raw', fromB64(b64), ECDSA, false, ['verify']);
    k.catch(() => verifyKeys.delete(b64));
    if (verifyKeys.size > 2000) verifyKeys.clear();
    verifyKeys.set(b64, k);
  }
  return k;
};

/** Verify a signature made by sign(). Returns false (never throws) on any problem. */
export async function verify(obj: unknown, sigB64: string, signPubB64: string): Promise<boolean> {
  try {
    const pub = await verifyKey(signPubB64);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64(sigB64), enc.encode(canonical(obj)));
  } catch {
    return false;
  }
}

/** Random id for nonces and message ids (crypto randomness is fine: it never changes a sim decision). */
export const nonce = (): string => toB64(globalThis.crypto.getRandomValues(new Uint8Array(12)));
