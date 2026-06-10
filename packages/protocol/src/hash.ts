// @postcall/protocol — domain-separated hashing + commit/reveal

import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8 } from './encoding.js';

export function sha256(b: Uint8Array): Uint8Array {
  return nobleSha256(b);
}

export const HASH_TAGS = {
  commit: 'postcall/commit/v1',
  message: 'postcall/msg/v1',
  state: 'postcall/state/v1',
  envelope: 'postcall/envelope/v1',
  transcript: 'postcall/transcript/v1',
  merkle: 'postcall/merkle/v1',
} as const;

export type HashTag = (typeof HASH_TAGS)[keyof typeof HASH_TAGS];

/** Domain-separated hash: H(tag ‖ 0x00 ‖ data). */
export function taggedHash(tag: HashTag, ...parts: Uint8Array[]): Uint8Array {
  return sha256(concatBytes(utf8(tag), new Uint8Array([0x00]), ...parts));
}

/** Commitment to a secret. */
export function commit(secret: Uint8Array): Uint8Array {
  return taggedHash(HASH_TAGS.commit, secret);
}

/** Constant-time reveal check. */
export function verifyReveal(secret: Uint8Array, commitment: Uint8Array): boolean {
  const c = commit(secret);
  if (c.length !== commitment.length) return false;
  let d = 0;
  for (let i = 0; i < c.length; i++) d |= c[i]! ^ commitment[i]!;
  return d === 0;
}
