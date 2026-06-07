import { describe, it, expect } from 'vitest';
import { createRelay } from '../src/index.js';

describe('Relay', () => {
  it('should open a channel and publish/read messages', () => {
    const relay = createRelay();

    const openResult = relay.open('ch1', 'token1');
    expect(openResult.ok).toBe(true);

    const pub1 = relay.publish('ch1', 'token1', 'aabbcc');
    expect(pub1.ok).toBe(true);
    if (pub1.ok) expect(pub1.value.seq).toBe(0);

    const pub2 = relay.publish('ch1', 'token1', 'ddeeff');
    expect(pub2.ok).toBe(true);
    if (pub2.ok) expect(pub2.value.seq).toBe(1);

    const hist = relay.history('ch1', 'token1', 0);
    expect(hist.ok).toBe(true);
    if (hist.ok) {
      expect(hist.value.items).toEqual(['aabbcc', 'ddeeff']);
      expect(hist.value.total).toBe(2);
    }
  });

  it('should reject wrong token', () => {
    const relay = createRelay();
    relay.open('ch1', 'token1');

    const result = relay.publish('ch1', 'wrong-token', 'aabb');
    expect(result.ok).toBe(false);
  });

  it('should notify subscribers', () => {
    const relay = createRelay();
    relay.open('ch1', 'token1');

    const received: string[] = [];
    relay.subscribe('ch1', 'token1', (msg) => { received.push(msg); });

    relay.publish('ch1', 'token1', 'aabb');
    relay.publish('ch1', 'token1', 'ccdd');

    expect(received).toEqual(['aabb', 'ccdd']);
  });
});
