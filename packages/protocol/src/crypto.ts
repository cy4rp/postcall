// @postcall/protocol — secp256k1 key management + signing (mirrors bsv-universal-sdk crypto)

import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 as nobleRipemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from './hash.js';
import { concatBytes } from './encoding.js';

export function randomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 1 << 20) throw new Error('randomBytes length out of range');
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export interface KeyPair {
  readonly priv: Uint8Array; // 32 bytes
  readonly pub: Uint8Array;  // 65 bytes, uncompressed 0x04||X||Y
}

/** Generate a new agent key pair. */
export function genKeyPair(): KeyPair {
  const priv = secp256k1.utils.randomPrivateKey();
  return { priv, pub: secp256k1.getPublicKey(priv, false) };
}

/** Reconstruct a key pair from a private key. */
export function keyPairFromPriv(priv: Uint8Array): KeyPair {
  if (priv.length !== 32) throw new Error('priv must be 32 bytes');
  return { priv, pub: secp256k1.getPublicKey(priv, false) };
}

/** 33-byte compressed public key — the canonical agent identifier. */
export function partyId(pub: Uint8Array): Uint8Array {
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('pub must be uncompressed 65B');
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const prefix = (y[31]! & 1) === 0 ? 0x02 : 0x03;
  return concatBytes(new Uint8Array([prefix]), x);
}

/** Sign a payload with the agent's own key. Returns a DER ECDSA signature (low-s). */
export function signData(payload: Uint8Array, kp: KeyPair): Uint8Array {
  const sig = secp256k1.sign(sha256(payload), kp.priv);
  return Uint8Array.from(sig.toDERRawBytes());
}

/** Verify a payload signature against an agent public key. Total: never throws. */
export function verifyData(payload: Uint8Array, sig: Uint8Array, pub: Uint8Array): boolean {
  try {
    return secp256k1.verify(sig, sha256(payload), pub);
  } catch {
    return false;
  }
}

/** Sign a Bitcoin sighash preimage (double-SHA256). */
export function signBitcoin(preimage: Uint8Array, kp: KeyPair): Uint8Array {
  const sig = secp256k1.sign(sha256(sha256(preimage)), kp.priv);
  return Uint8Array.from(sig.toDERRawBytes());
}

/** Verify a Bitcoin-sighash DER signature. */
export function verifyBitcoin(preimage: Uint8Array, derSig: Uint8Array, pub: Uint8Array): boolean {
  try {
    if (pub.length !== 65 || pub[0] !== 0x04) return false;
    return secp256k1.verify(derSig, sha256(sha256(preimage)), pub);
  } catch {
    return false;
  }
}

/** HASH160 = RIPEMD160(SHA256(x)) — the P2PKH key hash. */
export function hash160(b: Uint8Array): Uint8Array {
  return nobleRipemd160(sha256(b));
}
