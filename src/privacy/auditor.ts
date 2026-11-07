// Auditor copy of each manifest (PLAN section 12, threat 8 "pack short").
// The store seals the manifest twice: once to the clinic, once to the auditor. Carriers can read neither.
import type { Manifest, Sealed, SealedBox } from '../contracts/types';
import { open, seal } from './core';

export async function sealForClinicAndAuditor(
  manifest: Manifest, clinicPub: string, auditorPub: string,
): Promise<{ sealed: Sealed; auditorCopy: Sealed }> {
  const [sealed, auditorCopy] = await Promise.all([seal(manifest, clinicPub), seal(manifest, auditorPub)]);
  return { sealed, auditorCopy };
}

/** Opens the auditor copy (from a box or a raw Sealed). Throws on the wrong key or a tampered copy. */
export async function openAuditorCopy(src: SealedBox | Sealed, auditorPriv: CryptoKey): Promise<Manifest> {
  const sealed = 'label' in src ? src.auditorCopy : src;
  if (!sealed) throw new Error('box has no auditor copy');
  return open<Manifest>(sealed, auditorPriv);
}
