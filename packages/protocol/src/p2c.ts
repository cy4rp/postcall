// @postcall/protocol — Pay-to-Contract (P2C) commitment primitive
//
// REQ-COMMIT-001: the canonical commitment mechanism. Embeds an arbitrary message
// into a public key: P' = P + H(tag ‖ m)·G. The output locked to P' is an ordinary
// spendable output — no OP_RETURN. Anyone with m (and P) can verify the commitment.

import { secp256k1 } from '@noble/curves/secp256k1';
import { taggedHash, HASH_TAGS, type HashTag } from './hash.js';
import { toHex } from './encoding.js';

const POINT = secp256k1.ProjectivePoint;
const ORDER = secp256k1.CURVE.n;

export interface P2CCommitment {
  readonly tweakedPub: Uint8Array;   // P' — 65B uncompressed. Lock funds here.
  readonly tweakedPubCompressed: Uint8Array; // 33B compressed form
  readonly tweak: Uint8Array;        // H(tag ‖ m) — 32B scalar
  readonly basePub: Uint8Array;      // original P — needed for verification
}

/**
 * Create a P2C commitment: P' = P + H(tag ‖ m)·G
 *
 * @param basePub  65B uncompressed public key (the agent's base key)
 * @param message  arbitrary bytes to commit
 * @param tag      domain-separation tag (defaults to 'postcall/msg/v1')
 */
export function commitP2C(
  basePub: Uint8Array,
  message: Uint8Array,
  tag: HashTag = HASH_TAGS.message,
): P2CCommitment {
  if (basePub.length !== 65 || basePub[0] !== 0x04) {
    throw new Error('basePub must be 65B uncompressed (0x04 prefix)');
  }

  const tweak = taggedHash(tag, message);
  const tweakScalar = bytesToBigInt(tweak) % ORDER;
  if (tweakScalar === 0n) throw new Error('degenerate tweak (zero mod n)');

  const basePoint = POINT.fromHex(basePub);
  const tweakPoint = POINT.BASE.multiply(tweakScalar);
  const tweakedPoint = basePoint.add(tweakPoint);

  return {
    tweakedPub: tweakedPoint.toRawBytes(false),
    tweakedPubCompressed: tweakedPoint.toRawBytes(true),
    tweak,
    basePub,
  };
}

/**
 * Verify a P2C commitment: check that P' = P + H(tag ‖ m)·G
 *
 * @param tweakedPub  the public key that was used on-chain (33B or 65B)
 * @param basePub     the original base public key (65B uncompressed)
 * @param message     the committed message
 * @param tag         domain-separation tag
 */
export function verifyP2C(
  tweakedPub: Uint8Array,
  basePub: Uint8Array,
  message: Uint8Array,
  tag: HashTag = HASH_TAGS.message,
): boolean {
  try {
    const recomputed = commitP2C(basePub, message, tag);
    const expectedHex = toHex(
      tweakedPub.length === 33
        ? recomputed.tweakedPubCompressed
        : recomputed.tweakedPub,
    );
    return expectedHex === toHex(tweakedPub);
  } catch {
    return false;
  }
}

/**
 * Derive the tweaked private key: s' = s + H(tag ‖ m)
 * Needed to spend the P2C output.
 */
export function tweakPrivateKey(
  priv: Uint8Array,
  message: Uint8Array,
  tag: HashTag = HASH_TAGS.message,
): Uint8Array {
  if (priv.length !== 32) throw new Error('priv must be 32 bytes');
  const tweak = taggedHash(tag, message);
  const privScalar = bytesToBigInt(priv);
  const tweakScalar = bytesToBigInt(tweak) % ORDER;
  const result = (privScalar + tweakScalar) % ORDER;
  if (result === 0n) throw new Error('degenerate tweaked key (zero)');
  return bigIntToBytes(result, 32);
}

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
