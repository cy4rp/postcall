import { describe, it, expect } from 'vitest';
import {
  genKeyPair,
  partyId,
  toHex,
  signEnvelope,
  verifyEnvelope,
  envelopeToHex,
  envelopeFromHex,
} from '../src/index.js';

describe('Envelope', () => {
  it('should sign and verify an envelope', () => {
    const kp = genKeyPair();
    const pid = toHex(partyId(kp.pub));

    const fields = {
      conversationId: 'test-conv-001',
      from: pid,
      to: '*',
      messageKind: 'msg' as const,
      sequenceNo: 0,
      priorTranscriptHash: '0'.repeat(64),
      bodyHex: toHex(new TextEncoder().encode('hello')),
      timestamp: 1700000000,
    };

    const envelope = signEnvelope(fields, kp);

    expect(envelope.sigHex).toBeTruthy();
    expect(envelope.actorPubKeyHex).toBe(toHex(kp.pub));
    expect(verifyEnvelope(envelope)).toBe(true);
  });

  it('should round-trip through hex encoding', () => {
    const kp = genKeyPair();
    const pid = toHex(partyId(kp.pub));

    const fields = {
      conversationId: 'conv-002',
      from: pid,
      to: '*',
      messageKind: 'msg' as const,
      sequenceNo: 1,
      priorTranscriptHash: 'a'.repeat(64),
      bodyHex: toHex(new TextEncoder().encode('round trip test')),
      timestamp: 1700000001,
    };

    const envelope = signEnvelope(fields, kp);
    const hex = envelopeToHex(envelope);
    const decoded = envelopeFromHex(hex);

    expect(decoded.conversationId).toBe('conv-002');
    expect(decoded.from).toBe(pid);
    expect(verifyEnvelope(decoded)).toBe(true);
  });

  it('should reject envelope with wrong from field', () => {
    const kp = genKeyPair();

    expect(() => signEnvelope({
      conversationId: 'test',
      from: 'wrong-party-id',
      to: '*',
      messageKind: 'msg',
      sequenceNo: 0,
      priorTranscriptHash: '0'.repeat(64),
      bodyHex: '00',
      timestamp: 0,
    }, kp)).toThrow();
  });
});
