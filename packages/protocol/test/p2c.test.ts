import { describe, it, expect } from 'vitest';
import { genKeyPair, commitP2C, verifyP2C, toHex } from '../src/index.js';

describe('P2C commitment', () => {
  it('should create and verify a commitment', () => {
    const kp = genKeyPair();
    const message = new TextEncoder().encode('hello from postcall');

    const commitment = commitP2C(kp.pub, message);

    expect(commitment.tweakedPub.length).toBe(65);
    expect(commitment.tweakedPubCompressed.length).toBe(33);
    expect(commitment.tweak.length).toBe(32);

    // Tweaked key should differ from base key
    expect(toHex(commitment.tweakedPub)).not.toBe(toHex(kp.pub));

    // Verification should pass
    expect(verifyP2C(commitment.tweakedPub, kp.pub, message)).toBe(true);
    expect(verifyP2C(commitment.tweakedPubCompressed, kp.pub, message)).toBe(true);
  });

  it('should fail verification with wrong message', () => {
    const kp = genKeyPair();
    const msg1 = new TextEncoder().encode('message 1');
    const msg2 = new TextEncoder().encode('message 2');

    const commitment = commitP2C(kp.pub, msg1);
    expect(verifyP2C(commitment.tweakedPub, kp.pub, msg2)).toBe(false);
  });

  it('should fail verification with wrong base key', () => {
    const kp1 = genKeyPair();
    const kp2 = genKeyPair();
    const message = new TextEncoder().encode('test');

    const commitment = commitP2C(kp1.pub, message);
    expect(verifyP2C(commitment.tweakedPub, kp2.pub, message)).toBe(false);
  });

  it('should produce deterministic commitments', () => {
    const kp = genKeyPair();
    const message = new TextEncoder().encode('deterministic test');

    const c1 = commitP2C(kp.pub, message);
    const c2 = commitP2C(kp.pub, message);

    expect(toHex(c1.tweakedPub)).toBe(toHex(c2.tweakedPub));
    expect(toHex(c1.tweak)).toBe(toHex(c2.tweak));
  });
});
