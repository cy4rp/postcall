import { describe, it, expect } from 'vitest';
import { initList, listModule } from '../src/module.js';
import { genKeyPair, partyId, toHex, commitP2C, utf8 } from '@postcall/protocol';

function makeAgent() {
  const kp = genKeyPair();
  return { kp, id: toHex(partyId(kp.pub)) };
}

describe('ListModule', () => {
  const owner = makeAgent();
  const sub1 = makeAgent();
  const sub2 = makeAgent();

  it('initList creates valid initial state', () => {
    const state = initList('list-001', 'テスト ML', owner.id);
    expect(state.listId).toBe('list-001');
    expect(state.name).toBe('テスト ML');
    expect(state.owner).toBe(owner.id);
    expect(state.subscribers).toContain(owner.id);
    expect(state.posts).toHaveLength(0);
    expect(state.phase).toBe('active');
    expect(state.transcriptHash).toHaveLength(64);
    expect(state.nextSeq).toBe(0);
  });

  it('subscribe adds a new subscriber', () => {
    const state = initList('list-002', 'ML2', owner.id);
    const result = listModule.apply(state, { kind: 'subscribe', agent: sub1.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.subscribers).toContain(sub1.id);
      expect(result.state.subscribers).toHaveLength(2);
    }
  });

  it('duplicate subscribe rejected', () => {
    const state = initList('list-003', 'ML3', owner.id);
    const result = listModule.apply(state, { kind: 'subscribe', agent: owner.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('already subscribed');
  });

  it('unsubscribe removes a subscriber', () => {
    let state = initList('list-004', 'ML4', owner.id);
    const r1 = listModule.apply(state, { kind: 'subscribe', agent: sub1.id });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.state;

    const r2 = listModule.apply(state, { kind: 'unsubscribe', agent: sub1.id });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.state.subscribers).not.toContain(sub1.id);
    }
  });

  it('owner cannot unsubscribe', () => {
    const state = initList('list-005', 'ML5', owner.id);
    const result = listModule.apply(state, { kind: 'unsubscribe', agent: owner.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('owner cannot');
  });

  it('subscriber can post with P2C commitment', () => {
    const state = initList('list-006', 'ML6', owner.id);
    const body = utf8('Hello mailing list!');
    const bodyHex = toHex(body);
    const p2c = commitP2C(owner.kp.pub, body);
    const p2cHex = toHex(p2c.tweakedPubCompressed);

    const result = listModule.apply(state, {
      kind: 'post',
      from: owner.id,
      subject: 'First post',
      bodyHex,
      p2cCommitment: p2cHex,
      timestamp: 1000000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.posts).toHaveLength(1);
      expect(result.state.posts[0].seq).toBe(0);
      expect(result.state.posts[0].p2cCommitment).toBe(p2cHex);
      expect(result.state.nextSeq).toBe(1);
    }
  });

  it('non-subscriber cannot post', () => {
    const state = initList('list-007', 'ML7', owner.id);
    const body = utf8('Unauthorized!');
    const bodyHex = toHex(body);
    const p2c = commitP2C(sub1.kp.pub, body);
    const p2cHex = toHex(p2c.tweakedPubCompressed);

    const result = listModule.apply(state, {
      kind: 'post',
      from: sub1.id,
      subject: 'Unauthorized',
      bodyHex,
      p2cCommitment: p2cHex,
      timestamp: 1000000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('only subscribers');
  });

  it('reply threading works', () => {
    let state = initList('list-008', 'ML8', owner.id);
    const body1 = utf8('Original');
    const p2c1 = commitP2C(owner.kp.pub, body1);

    const r1 = listModule.apply(state, {
      kind: 'post', from: owner.id, subject: 'Topic',
      bodyHex: toHex(body1), p2cCommitment: toHex(p2c1.tweakedPubCompressed),
      timestamp: 1000,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.state;

    // Subscribe sub1 then reply
    const r2 = listModule.apply(state, { kind: 'subscribe', agent: sub1.id });
    if (!r2.ok) return;
    state = r2.state;

    const body2 = utf8('Reply');
    const p2c2 = commitP2C(sub1.kp.pub, body2);
    const r3 = listModule.apply(state, {
      kind: 'post', from: sub1.id, subject: 'Re: Topic',
      bodyHex: toHex(body2), p2cCommitment: toHex(p2c2.tweakedPubCompressed),
      timestamp: 2000, replyTo: 0,
    });
    expect(r3.ok).toBe(true);
    if (r3.ok) {
      expect(r3.state.posts[1].replyTo).toBe(0);
    }
  });

  it('archive stops new posts', () => {
    let state = initList('list-009', 'ML9', owner.id);
    const r1 = listModule.apply(state, { kind: 'archive' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.state;
    expect(state.phase).toBe('archived');

    const body = utf8('Too late');
    const p2c = commitP2C(owner.kp.pub, body);
    const r2 = listModule.apply(state, {
      kind: 'post', from: owner.id, subject: 'Late',
      bodyHex: toHex(body), p2cCommitment: toHex(p2c.tweakedPubCompressed),
      timestamp: 3000,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('archived');
  });

  it('hash chain progresses with each step', () => {
    let state = initList('list-010', 'ML10', owner.id);
    const hashes = [state.transcriptHash];

    // Subscribe
    const r1 = listModule.apply(state, { kind: 'subscribe', agent: sub1.id });
    if (!r1.ok) return;
    state = r1.state;
    hashes.push(state.transcriptHash);

    // Post
    const body = utf8('Chain test');
    const p2c = commitP2C(owner.kp.pub, body);
    const r2 = listModule.apply(state, {
      kind: 'post', from: owner.id, subject: 'Chain',
      bodyHex: toHex(body), p2cCommitment: toHex(p2c.tweakedPubCompressed),
      timestamp: 5000,
    });
    if (!r2.ok) return;
    state = r2.state;
    hashes.push(state.transcriptHash);

    // All hashes unique
    const unique = new Set(hashes);
    expect(unique.size).toBe(3);
  });

  it('getPostsForSubscriber returns posts for member only', () => {
    let state = initList('list-011', 'ML11', owner.id);
    const body = utf8('Members only');
    const p2c = commitP2C(owner.kp.pub, body);

    const r1 = listModule.apply(state, {
      kind: 'post', from: owner.id, subject: 'Exclusive',
      bodyHex: toHex(body), p2cCommitment: toHex(p2c.tweakedPubCompressed),
      timestamp: 6000,
    });
    if (!r1.ok) return;
    state = r1.state;

    expect(listModule.getPostsForSubscriber(state, owner.id)).toHaveLength(1);
    expect(listModule.getPostsForSubscriber(state, sub1.id)).toHaveLength(0);
  });
});
