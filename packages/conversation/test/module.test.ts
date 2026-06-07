import { describe, it, expect } from 'vitest';
import { conversationModule, initConversation } from '../src/index.js';
import { genKeyPair, partyId, toHex, commitP2C } from '@postcall/protocol';

describe('ConversationModule', () => {
  const kpA = genKeyPair();
  const kpB = genKeyPair();
  const pidA = toHex(partyId(kpA.pub));
  const pidB = toHex(partyId(kpB.pub));

  it('should initialize a conversation', () => {
    const state = initConversation('conv-001', [pidA, pidB]);

    expect(state.conversationId).toBe('conv-001');
    expect(state.participants).toHaveLength(2);
    expect(state.messages).toHaveLength(0);
    expect(state.phase).toBe('open');
    expect(state.nextSeq).toBe(0);
    expect(state.transcriptHash).toBeTruthy();
  });

  it('should apply a message step', () => {
    const state = initConversation('conv-001', [pidA, pidB]);
    const bodyBytes = new TextEncoder().encode('hello B');
    const p2c = commitP2C(kpA.pub, bodyBytes);

    const result = conversationModule.apply(state, {
      kind: 'message',
      from: pidA,
      messageKind: 'msg',
      bodyHex: toHex(bodyBytes),
      p2cCommitment: toHex(p2c.tweakedPubCompressed),
      timestamp: 1700000000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.messages).toHaveLength(1);
      expect(result.state.messages[0]!.from).toBe(pidA);
      expect(result.state.nextSeq).toBe(1);
    }
  });

  it('should chain transcript hashes', () => {
    const state = initConversation('conv-001', [pidA, pidB]);
    const body1 = new TextEncoder().encode('msg 1');
    const body2 = new TextEncoder().encode('msg 2');

    const r1 = conversationModule.apply(state, {
      kind: 'message', from: pidA, messageKind: 'msg',
      bodyHex: toHex(body1),
      p2cCommitment: toHex(commitP2C(kpA.pub, body1).tweakedPubCompressed),
      timestamp: 1,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = conversationModule.apply(r1.state, {
      kind: 'message', from: pidB, messageKind: 'msg',
      bodyHex: toHex(body2),
      p2cCommitment: toHex(commitP2C(kpB.pub, body2).tweakedPubCompressed),
      timestamp: 2,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Each step changes the transcript hash
    expect(r1.state.transcriptHash).not.toBe(state.transcriptHash);
    expect(r2.state.transcriptHash).not.toBe(r1.state.transcriptHash);
  });

  it('should handle req/res flow', () => {
    let state = initConversation('conv-002', [pidA, pidB]);

    // A sends request
    const r1 = conversationModule.apply(state, {
      kind: 'message', from: pidA, messageKind: 'req',
      bodyHex: toHex(new TextEncoder().encode('what is BSV?')),
      p2cCommitment: '00'.repeat(33),
      timestamp: 1,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.state.phase).toBe('pending_reply');

    // B sends response
    const r2 = conversationModule.apply(r1.state, {
      kind: 'message', from: pidB, messageKind: 'res',
      bodyHex: toHex(new TextEncoder().encode('BSV is Bitcoin SV')),
      p2cCommitment: '00'.repeat(33),
      timestamp: 2,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.phase).toBe('open');
  });

  it('should reject unknown participant', () => {
    const state = initConversation('conv-003', [pidA, pidB]);
    const kpC = genKeyPair();
    const pidC = toHex(partyId(kpC.pub));

    const result = conversationModule.apply(state, {
      kind: 'message', from: pidC, messageKind: 'msg',
      bodyHex: '00', p2cCommitment: '00'.repeat(33), timestamp: 1,
    });

    expect(result.ok).toBe(false);
  });

  it('should settle a conversation', () => {
    let state = initConversation('conv-004', [pidA, pidB]);

    const r1 = conversationModule.apply(state, {
      kind: 'message', from: pidA, messageKind: 'msg',
      bodyHex: toHex(new TextEncoder().encode('goodbye')),
      p2cCommitment: '00'.repeat(33), timestamp: 1,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = conversationModule.apply(r1.state, { kind: 'settle' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.phase).toBe('settled');

    // Should reject further messages
    const r3 = conversationModule.apply(r2.state, {
      kind: 'message', from: pidB, messageKind: 'msg',
      bodyHex: '00', p2cCommitment: '00'.repeat(33), timestamp: 2,
    });
    expect(r3.ok).toBe(false);
  });

  it('should replay a full transcript', () => {
    const body1 = new TextEncoder().encode('hello');
    const body2 = new TextEncoder().encode('hi back');

    const result = conversationModule.replay('conv-005', [pidA, pidB], [
      {
        kind: 'message', from: pidA, messageKind: 'msg',
        bodyHex: toHex(body1),
        p2cCommitment: toHex(commitP2C(kpA.pub, body1).tweakedPubCompressed),
        timestamp: 1,
      },
      {
        kind: 'message', from: pidB, messageKind: 'msg',
        bodyHex: toHex(body2),
        p2cCommitment: toHex(commitP2C(kpB.pub, body2).tweakedPubCompressed),
        timestamp: 2,
      },
      { kind: 'settle' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.messages).toHaveLength(2);
    expect(result.state.phase).toBe('settled');
  });
});
