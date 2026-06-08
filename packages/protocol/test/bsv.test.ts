// @postcall/protocol — BSV transaction primitives tests

import { describe, it, expect } from 'vitest';
import {
  writeVarInt,
  p2pkhScript,
  p2pkhScriptFromPub,
  p2pkhScriptSig,
  sighashPreimage,
  serializeTransaction,
  computeTxid,
  signInput,
  buildP2CTransaction,
  base58Check,
  base58CheckDecode,
  pubkeyToAddress,
  privkeyToWif,
  wifToPrivkey,
  privToCompressedPub,
  DUST_SATOSHIS,
} from '../src/bsv.js';
import { genKeyPair, partyId, commitP2C, toHex, fromHex, hash160 } from '../src/index.js';

describe('BSV transaction primitives', () => {
  // ---- varint ----
  it('should encode varints correctly', () => {
    expect(toHex(writeVarInt(0))).toBe('00');
    expect(toHex(writeVarInt(1))).toBe('01');
    expect(toHex(writeVarInt(0xfc))).toBe('fc');
    expect(toHex(writeVarInt(0xfd))).toBe('fdfd00');
    expect(toHex(writeVarInt(0xffff))).toBe('fdffff');
    expect(toHex(writeVarInt(0x10000))).toBe('fe00000100');
  });

  // ---- P2PKH scripts ----
  it('should create P2PKH locking script', () => {
    const hash = new Uint8Array(20).fill(0xab);
    const script = p2pkhScript(hash);
    // OP_DUP(76) OP_HASH160(a9) PUSH20(14) <hash> OP_EQUALVERIFY(88) OP_CHECKSIG(ac)
    expect(script.length).toBe(25);
    expect(script[0]).toBe(0x76); // OP_DUP
    expect(script[1]).toBe(0xa9); // OP_HASH160
    expect(script[2]).toBe(0x14); // push 20 bytes
    expect(script[23]).toBe(0x88); // OP_EQUALVERIFY
    expect(script[24]).toBe(0xac); // OP_CHECKSIG
  });

  it('should create P2PKH script from compressed pubkey', () => {
    const kp = genKeyPair();
    const compressed = partyId(kp.pub); // 33-byte compressed
    const script = p2pkhScriptFromPub(compressed);
    expect(script.length).toBe(25);

    // Verify the hash matches
    const expectedHash = hash160(compressed);
    expect(toHex(script.slice(3, 23))).toBe(toHex(expectedHash));
  });

  // ---- Base58Check ----
  it('should encode/decode Base58Check', () => {
    const payload = new Uint8Array(20).fill(0x42);
    const encoded = base58Check(0x6f, payload); // testnet version
    const decoded = base58CheckDecode(encoded);
    expect(decoded.version).toBe(0x6f);
    expect(toHex(decoded.payload)).toBe(toHex(payload));
  });

  it('should reject invalid Base58Check checksum', () => {
    const payload = new Uint8Array(20).fill(0x42);
    const encoded = base58Check(0x6f, payload);
    // Corrupt last char
    const corrupted = encoded.slice(0, -1) + (encoded.endsWith('1') ? '2' : '1');
    expect(() => base58CheckDecode(corrupted)).toThrow();
  });

  // ---- address generation ----
  it('should generate a valid testnet address', () => {
    const kp = genKeyPair();
    const compressed = partyId(kp.pub);
    const address = pubkeyToAddress(compressed, true);
    // Testnet addresses start with 'm' or 'n'
    expect(address[0] === 'm' || address[0] === 'n').toBe(true);
    // Roundtrip
    const decoded = base58CheckDecode(address);
    expect(decoded.version).toBe(0x6f);
    expect(toHex(decoded.payload)).toBe(toHex(hash160(compressed)));
  });

  it('should generate a valid mainnet address', () => {
    const kp = genKeyPair();
    const compressed = partyId(kp.pub);
    const address = pubkeyToAddress(compressed, false);
    // Mainnet addresses start with '1'
    expect(address[0]).toBe('1');
  });

  // ---- WIF ----
  it('should encode/decode WIF', () => {
    const kp = genKeyPair();
    const wif = privkeyToWif(kp.priv, true, true);
    // Testnet compressed WIF starts with 'c'
    expect(wif[0]).toBe('c');

    const decoded = wifToPrivkey(wif);
    expect(decoded.testnet).toBe(true);
    expect(decoded.compressed).toBe(true);
    expect(toHex(decoded.priv)).toBe(toHex(kp.priv));
  });

  it('should encode mainnet WIF', () => {
    const kp = genKeyPair();
    const wif = privkeyToWif(kp.priv, false, true);
    expect(wif[0] === 'K' || wif[0] === 'L').toBe(true);
  });

  // ---- privToCompressedPub ----
  it('privToCompressedPub matches partyId', () => {
    const kp = genKeyPair();
    const compressed = privToCompressedPub(kp.priv);
    const fromUncompressed = partyId(kp.pub);
    expect(toHex(compressed)).toBe(toHex(fromUncompressed));
  });

  // ---- sighash preimage ----
  it('should construct a BIP143 sighash preimage', () => {
    const kp = genKeyPair();
    const compressed = privToCompressedPub(kp.priv);
    const lockingScript = p2pkhScriptFromPub(compressed);

    const input = {
      txid: 'a'.repeat(64),
      vout: 0,
      value: 100000n,
      scriptPubKey: lockingScript,
    };

    const output = {
      value: 50000n,
      scriptPubKey: lockingScript,
    };

    const preimage = sighashPreimage([input], [output], 0);
    // Preimage should be: 4 + 32 + 32 + 36 + (varint+25) + 8 + 4 + 32 + 4 + 4 = 182 bytes
    expect(preimage.length).toBe(4 + 32 + 32 + 36 + 1 + 25 + 8 + 4 + 32 + 4 + 4);
  });

  // ---- signInput ----
  it('should sign an input and produce a valid scriptSig', () => {
    const kp = genKeyPair();
    const compressed = privToCompressedPub(kp.priv);
    const lockingScript = p2pkhScriptFromPub(compressed);

    const input = {
      txid: 'b'.repeat(64),
      vout: 0,
      value: 100000n,
      scriptPubKey: lockingScript,
    };

    const output = {
      value: 50000n,
      scriptPubKey: lockingScript,
    };

    const scriptSig = signInput(kp.priv, compressed, [input], [output], 0);
    // scriptSig should contain: <len><sig+0x41> <len><pubkey(33)>
    expect(scriptSig.length).toBeGreaterThan(33 + 1 + 1); // at least sig + sighash + pubkey + length prefixes
    // Last 33 bytes should be the compressed pubkey (after its length prefix)
    const pubInSig = scriptSig.slice(scriptSig.length - 33);
    expect(toHex(pubInSig)).toBe(toHex(compressed));
  });

  // ---- buildP2CTransaction ----
  it('should build a complete P2C transaction', () => {
    const kp = genKeyPair();
    const compressed = privToCompressedPub(kp.priv);
    const lockingScript = p2pkhScriptFromPub(compressed);

    const utxo = {
      txid: 'c'.repeat(64),
      vout: 0,
      value: 100000n,
      scriptPubKey: lockingScript,
    };

    // Create a P2C commitment
    const message = new Uint8Array([1, 2, 3, 4]);
    const p2c = commitP2C(kp.pub, message);

    const tx = buildP2CTransaction(kp.priv, compressed, utxo, p2c.tweakedPubCompressed);

    // txid should be 64 hex chars
    expect(tx.txid).toMatch(/^[0-9a-f]{64}$/);
    // hex should be non-empty
    expect(tx.hex.length).toBeGreaterThan(0);
    // Should have 2 outputs (P2C + change)
    expect(tx.outputs.length).toBe(2);
    // Output 0 value should be dust
    expect(tx.outputs[0]!.value).toBe(DUST_SATOSHIS);
    // Change output should be input - dust - fee
    expect(tx.outputs[1]!.value).toBe(utxo.value - DUST_SATOSHIS - tx.fee);
    // Fee should be reasonable (< 500 sats for a simple tx)
    expect(tx.fee).toBeLessThan(500n);
    expect(tx.fee).toBeGreaterThan(0n);
  });

  it('should produce different txids for different P2C commitments', () => {
    const kp = genKeyPair();
    const compressed = privToCompressedPub(kp.priv);
    const lockingScript = p2pkhScriptFromPub(compressed);

    const utxo = {
      txid: 'd'.repeat(64),
      vout: 0,
      value: 100000n,
      scriptPubKey: lockingScript,
    };

    const msg1 = new Uint8Array([1, 2, 3]);
    const msg2 = new Uint8Array([4, 5, 6]);
    const p2c1 = commitP2C(kp.pub, msg1);
    const p2c2 = commitP2C(kp.pub, msg2);

    const tx1 = buildP2CTransaction(kp.priv, compressed, utxo, p2c1.tweakedPubCompressed);
    const tx2 = buildP2CTransaction(kp.priv, compressed, utxo, p2c2.tweakedPubCompressed);

    // Different messages → different P2C → different outputs → different txids
    expect(tx1.txid).not.toBe(tx2.txid);
  });

  it('should fail with insufficient funds', () => {
    const kp = genKeyPair();
    const compressed = privToCompressedPub(kp.priv);
    const lockingScript = p2pkhScriptFromPub(compressed);

    const utxo = {
      txid: 'e'.repeat(64),
      vout: 0,
      value: 100n, // too small
      scriptPubKey: lockingScript,
    };

    const msg = new Uint8Array([1]);
    const p2c = commitP2C(kp.pub, msg);

    expect(() =>
      buildP2CTransaction(kp.priv, compressed, utxo, p2c.tweakedPubCompressed),
    ).toThrow('insufficient funds');
  });

  // ---- serialization roundtrip ----
  it('should produce valid raw transaction hex', () => {
    const kp = genKeyPair();
    const compressed = privToCompressedPub(kp.priv);
    const lockingScript = p2pkhScriptFromPub(compressed);

    const utxo = {
      txid: 'f'.repeat(64),
      vout: 1,
      value: 50000n,
      scriptPubKey: lockingScript,
    };

    const msg = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const p2c = commitP2C(kp.pub, msg);
    const tx = buildP2CTransaction(kp.priv, compressed, utxo, p2c.tweakedPubCompressed);

    // Parse the hex to verify structure
    const raw = fromHex(tx.hex);
    // Version should be 01000000 (little-endian)
    expect(raw[0]).toBe(0x01);
    expect(raw[1]).toBe(0x00);
    expect(raw[2]).toBe(0x00);
    expect(raw[3]).toBe(0x00);
    // Input count should be 01
    expect(raw[4]).toBe(0x01);

    // Verify txid computation matches
    const recomputed = computeTxid(raw);
    expect(recomputed).toBe(tx.txid);
  });
});
