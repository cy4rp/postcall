// @postcall/protocol — in-process relay for ordered message fan-out
//
// Hostile-by-default: the relay never interprets messages. It provides a single
// total order per channel and bounded memory. Mirrors bsv-universal-sdk RelayCore.

export interface RelayLimits {
  readonly maxBodyBytes: number;
  readonly maxLog: number;
  readonly maxChannels: number;
  readonly historyPageLimit: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxBodyBytes: 256 * 1024,
  maxLog: 200_000,
  maxChannels: 10_000,
  historyPageLimit: 1_000,
};

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly reason: string };

interface Channel {
  readonly token: string;
  readonly log: string[];
  readonly subscribers: Set<(msg: string, seq: number) => void>;
}

const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;

export interface RelayCore {
  open(channel: string, token: string): Result<{ created: boolean }>;
  publish(channel: string, token: string, messageHex: string): Result<{ seq: number }>;
  history(channel: string, token: string, from: number): Result<{ items: readonly string[]; from: number; total: number }>;
  subscribe(channel: string, token: string, cb: (msg: string, seq: number) => void): Result<{ unsubscribe: () => void }>;
  channelCount(): number;
}

export function createRelay(limits: Partial<RelayLimits> = {}): RelayCore {
  const cfg: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...limits };
  const channels = new Map<string, Channel>();

  function auth(channel: string, token: string): Result<Channel> {
    const c = channels.get(channel);
    if (!c) return { ok: false, status: 404, reason: 'no such channel' };
    if (c.token !== token) return { ok: false, status: 401, reason: 'token mismatch' };
    return { ok: true, value: c };
  }

  return {
    open(channel, token) {
      if (!channel || !token) return { ok: false, status: 400, reason: 'channel and token required' };
      const existing = channels.get(channel);
      if (existing) {
        if (existing.token !== token) return { ok: false, status: 401, reason: 'token mismatch' };
        return { ok: true, value: { created: false } };
      }
      if (channels.size >= cfg.maxChannels) return { ok: false, status: 503, reason: 'max channels' };
      channels.set(channel, { token, log: [], subscribers: new Set() });
      return { ok: true, value: { created: true } };
    },

    publish(channel, token, messageHex) {
      const a = auth(channel, token);
      if (!a.ok) return a;
      if (typeof messageHex !== 'string' || !HEX_RE.test(messageHex)) {
        return { ok: false, status: 400, reason: 'message must be even-length hex' };
      }
      if (messageHex.length / 2 > cfg.maxBodyBytes) {
        return { ok: false, status: 413, reason: 'message too large' };
      }
      if (a.value.log.length >= cfg.maxLog) {
        return { ok: false, status: 503, reason: 'channel log full' };
      }
      const seq = a.value.log.length;
      a.value.log.push(messageHex);
      for (const cb of a.value.subscribers) {
        try { cb(messageHex, seq); } catch { /* subscriber error is not relay's problem */ }
      }
      return { ok: true, value: { seq } };
    },

    history(channel, token, from) {
      const a = auth(channel, token);
      if (!a.ok) return a;
      const start = Number.isInteger(from) && from > 0 ? from : 0;
      const items = a.value.log.slice(start, start + cfg.historyPageLimit);
      return { ok: true, value: { items, from: start, total: a.value.log.length } };
    },

    subscribe(channel, token, cb) {
      const a = auth(channel, token);
      if (!a.ok) return a;
      a.value.subscribers.add(cb);
      return {
        ok: true,
        value: {
          unsubscribe: () => { a.value.subscribers.delete(cb); },
        },
      };
    },

    channelCount() {
      return channels.size;
    },
  };
}
