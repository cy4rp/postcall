// @postcall/protocol — BSV transaction primitives
//
// Constructs and signs BSV transactions using BIP143 sighash (SIGHASH_ALL | SIGHASH_FORKID).
// No OP_RETURN — data is embedded in P2C spendable outputs.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from './hash.js';
import { concatBytes, toHex, fromHex } from './encoding.js';
import { hash160 } from './crypto.js';

// ---- constants ----

const SIGHASH_ALL = 0x01;
const SIGHASH_FORKID = 0x40;
const SIGHASH_TYPE = SIGHASH_ALL | SIGHASH_FORKID; // 0x41

// P2PKH opcodes
const OP_DUP = 0x76;
const OP_HASH160 = 0xa9;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;

// Base58 alphabet (Bitcoin standard)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Dust threshold (BSV allows 1 sat, but 546 is standard)
export const DUST_SATOSHIS = 546n;
// Default fee rate: 1 sat/byte (BSV is very cheap)
export const DEFAULT_FEE_RATE = 1n;

// ---- types ----

export interface TxInput {
  readonly txid: string;     // 64 hex chars (big-endian)
  readonly vout: number;     // output index
  readonly value: bigint;    // satoshis of this UTXO
  readonly scriptPubKey: Uint8Array; // locking script of the UTXO
}

export interface TxOutput {
  readonly value: bigint;    // satoshis
  readonly scriptPubKey: Uint8Array;
}

export interface SignedInput extends TxInput {
  readonly scriptSig: Uint8Array;
}

export interface BuiltTransaction {
  readonly txid: string;
  readonly hex: string;
  readonly inputs: readonly SignedInput[];
  readonly outputs: readonly TxOutput[];
  readonly fee: bigint;
}

// ---- varint ----

export function writeVarInt(n: number): Uint8Array {
  if (n < 0) throw new Error('varint must be non-negative');
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  if (n <= 0xffffffff) return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  throw new Error('varint too large');
}

// ---- little-endian helpers ----

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff; b[1] = (n >> 8) & 0xff; b[2] = (n >> 16) & 0xff; b[3] = (n >> 24) & 0xff;
  return b;
}

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** Reverse a txid from big-endian hex to little-endian bytes. */
function reverseTxid(txidHex: string): Uint8Array {
  const bytes = fromHex(txidHex);
  const reversed = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) reversed[i] = bytes[bytes.length - 1 - i]!;
  return reversed;
}

// ---- P2PKH scripts ----

/** Create a P2PKH locking script: OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG */
export function p2pkhScript(pubkeyHash: Uint8Array): Uint8Array {
  if (pubkeyHash.length !== 20) throw new Error('pubkeyHash must be 20 bytes');
  return new Uint8Array([OP_DUP, OP_HASH160, 0x14, ...pubkeyHash, OP_EQUALVERIFY, OP_CHECKSIG]);
}

/** Create a P2PKH locking script from a compressed public key. */
export function p2pkhScriptFromPub(compressedPub: Uint8Array): Uint8Array {
  if (compressedPub.length !== 33) throw new Error('must be 33-byte compressed pubkey');
  return p2pkhScript(hash160(compressedPub));
}

/** Create a P2PKH scriptSig: <sig + sighashType> <pubkey> */
export function p2pkhScriptSig(derSig: Uint8Array, compressedPub: Uint8Array): Uint8Array {
  const sigWithType = concatBytes(derSig, new Uint8Array([SIGHASH_TYPE]));
  return concatBytes(
    writeVarInt(sigWithType.length), sigWithType,
    writeVarInt(compressedPub.length), compressedPub,
  );
}

// ---- BIP143 sighash (BSV SIGHASH_FORKID) ----

function hashPrevouts(inputs: readonly TxInput[]): Uint8Array {
  const parts = inputs.map(i => concatBytes(reverseTxid(i.txid), u32le(i.vout)));
  return doubleSha256(concatBytes(...parts));
}

function hashSequence(inputs: readonly TxInput[]): Uint8Array {
  const parts = inputs.map(() => u32le(0xffffffff));
  return doubleSha256(concatBytes(...parts));
}

function hashOutputs(outputs: readonly TxOutput[]): Uint8Array {
  const parts = outputs.map(o => concatBytes(
    u64le(o.value),
    writeVarInt(o.scriptPubKey.length),
    o.scriptPubKey,
  ));
  return doubleSha256(concatBytes(...parts));
}

/** Construct BIP143 sighash preimage for one input. */
export function sighashPreimage(
  inputs: readonly TxInput[],
  outputs: readonly TxOutput[],
  inputIndex: number,
  version = 1,
  locktime = 0,
): Uint8Array {
  const inp = inputs[inputIndex]!;
  const scriptCode = concatBytes(writeVarInt(inp.scriptPubKey.length), inp.scriptPubKey);

  return concatBytes(
    u32le(version),                           // 1. nVersion
    hashPrevouts(inputs),                     // 2. hashPrevouts
    hashSequence(inputs),                     // 3. hashSequence
    reverseTxid(inp.txid), u32le(inp.vout),   // 4. outpoint
    scriptCode,                               // 5. scriptCode
    u64le(inp.value),                         // 6. value
    u32le(0xffffffff),                        // 7. nSequence
    hashOutputs(outputs),                     // 8. hashOutputs
    u32le(locktime),                          // 9. nLockTime
    u32le(SIGHASH_TYPE),                      // 10. sighashType
  );
}

// ---- transaction serialization ----

/** Serialize a fully signed transaction to hex. */
export function serializeTransaction(
  signedInputs: readonly SignedInput[],
  outputs: readonly TxOutput[],
  version = 1,
  locktime = 0,
): Uint8Array {
  const parts: Uint8Array[] = [
    u32le(version),
    writeVarInt(signedInputs.length),
  ];

  for (const inp of signedInputs) {
    parts.push(
      reverseTxid(inp.txid),
      u32le(inp.vout),
      writeVarInt(inp.scriptSig.length),
      inp.scriptSig,
      u32le(0xffffffff), // sequence
    );
  }

  parts.push(writeVarInt(outputs.length));
  for (const out of outputs) {
    parts.push(
      u64le(out.value),
      writeVarInt(out.scriptPubKey.length),
      out.scriptPubKey,
    );
  }

  parts.push(u32le(locktime));
  return concatBytes(...parts);
}

/** Compute txid from a serialized transaction. */
export function computeTxid(rawTx: Uint8Array): string {
  const hash = doubleSha256(rawTx);
  // txid is displayed big-endian (reversed)
  const reversed = new Uint8Array(hash.length);
  for (let i = 0; i < hash.length; i++) reversed[i] = hash[hash.length - 1 - i]!;
  return toHex(reversed);
}

// ---- sign + build ----

/** Sign a single input and return the scriptSig. */
export function signInput(
  priv: Uint8Array,
  compressedPub: Uint8Array,
  inputs: readonly TxInput[],
  outputs: readonly TxOutput[],
  inputIndex: number,
): Uint8Array {
  const preimage = sighashPreimage(inputs, outputs, inputIndex);
  const hash = doubleSha256(preimage);
  const sig = secp256k1.sign(hash, priv, { lowS: true });
  const derSig = Uint8Array.from(sig.toDERRawBytes());
  return p2pkhScriptSig(derSig, compressedPub);
}

/**
 * Build a P2C commitment transaction.
 *
 * Creates a transaction with:
 * - Output 0: P2C commitment (spendable, dust amount) locked to HASH160(tweakedPubCompressed)
 * - Output 1: Change back to the gateway address
 *
 * @param gatewayPriv     32-byte private key of the gateway wallet
 * @param gatewayPubCompressed  33-byte compressed pubkey of the gateway
 * @param utxo            the UTXO to spend
 * @param p2cPubCompressed 33-byte tweaked P2C pubkey (the commitment carrier)
 * @param feeRate         satoshis per byte
 */
export function buildP2CTransaction(
  gatewayPriv: Uint8Array,
  gatewayPubCompressed: Uint8Array,
  utxo: TxInput,
  p2cPubCompressed: Uint8Array,
  feeRate: bigint = DEFAULT_FEE_RATE,
): BuiltTransaction {
  // Build outputs
  const p2cOutput: TxOutput = {
    value: DUST_SATOSHIS,
    scriptPubKey: p2pkhScriptFromPub(p2cPubCompressed),
  };

  const changeScript = p2pkhScriptFromPub(gatewayPubCompressed);

  // Estimate fee: ~1 input (148B) + 2 outputs (34B each) + overhead (10B) ≈ 226B
  const estimatedSize = 226n;
  const fee = estimatedSize * feeRate;

  const changeValue = utxo.value - DUST_SATOSHIS - fee;
  if (changeValue < 0n) throw new Error(`insufficient funds: need ${DUST_SATOSHIS + fee}, have ${utxo.value}`);

  const outputs: TxOutput[] = [p2cOutput];
  if (changeValue >= DUST_SATOSHIS) {
    outputs.push({ value: changeValue, scriptPubKey: changeScript });
  }

  const inputs: TxInput[] = [utxo];

  // Sign
  const scriptSig = signInput(gatewayPriv, gatewayPubCompressed, inputs, outputs, 0);
  const signedInputs: SignedInput[] = [{ ...utxo, scriptSig }];

  // Serialize
  const rawTx = serializeTransaction(signedInputs, outputs);
  const txid = computeTxid(rawTx);
  const actualFee = utxo.value - outputs.reduce((sum, o) => sum + o.value, 0n);

  return { txid, hex: toHex(rawTx), inputs: signedInputs, outputs, fee: actualFee };
}

// ---- address encoding ----

/** Base58Check encode. */
export function base58Check(version: number, payload: Uint8Array): string {
  const data = concatBytes(new Uint8Array([version]), payload);
  const checksum = doubleSha256(data).slice(0, 4);
  const full = concatBytes(data, checksum);

  // Convert to base58
  let num = 0n;
  for (const byte of full) num = num * 256n + BigInt(byte);

  let result = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    result = BASE58_ALPHABET[rem] + result;
  }

  // Preserve leading zeros
  for (const byte of full) {
    if (byte !== 0) break;
    result = '1' + result;
  }

  return result;
}

/** Decode Base58Check, returning {version, payload}. */
export function base58CheckDecode(s: string): { version: number; payload: Uint8Array } {
  let num = 0n;
  for (const ch of s) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base58 char: ${ch}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert bigint to bytes
  const hex = num.toString(16).padStart(2, '0');
  const rawBytes = fromHex(hex.length % 2 ? '0' + hex : hex);

  // Restore leading zeros
  let leadingZeros = 0;
  for (const ch of s) { if (ch === '1') leadingZeros++; else break; }

  const full = concatBytes(new Uint8Array(leadingZeros), rawBytes);

  // Verify length: version(1) + payload(?) + checksum(4)
  if (full.length < 5) throw new Error('base58check too short');

  const data = full.slice(0, full.length - 4);
  const checksum = full.slice(full.length - 4);
  const computed = doubleSha256(data).slice(0, 4);

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== computed[i]) throw new Error('base58check checksum mismatch');
  }

  return { version: data[0]!, payload: data.slice(1) };
}

/** Convert a compressed public key to a BSV address. */
export function pubkeyToAddress(compressedPub: Uint8Array, testnet = true): string {
  if (compressedPub.length !== 33) throw new Error('must be 33-byte compressed pubkey');
  const pkHash = hash160(compressedPub);
  return base58Check(testnet ? 0x6f : 0x00, pkHash);
}

/** Encode a private key as WIF. */
export function privkeyToWif(priv: Uint8Array, testnet = true, compressed = true): string {
  const prefix = testnet ? 0xef : 0x80;
  const payload = compressed ? concatBytes(priv, new Uint8Array([0x01])) : priv;
  return base58Check(prefix, payload);
}

/** Decode a WIF private key. */
export function wifToPrivkey(wif: string): { priv: Uint8Array; testnet: boolean; compressed: boolean } {
  const { version, payload } = base58CheckDecode(wif);
  const testnet = version === 0xef;
  if (version !== 0x80 && version !== 0xef) throw new Error(`unexpected WIF version: 0x${version.toString(16)}`);
  const compressed = payload.length === 33 && payload[32] === 0x01;
  const priv = compressed ? payload.slice(0, 32) : payload;
  if (priv.length !== 32) throw new Error('invalid WIF payload length');
  return { priv, testnet, compressed };
}

/** Get compressed public key from private key. */
export function privToCompressedPub(priv: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(priv, true);
}
