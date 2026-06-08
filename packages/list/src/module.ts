// @postcall/list — MailingListModule: a pure state machine for blockchain-backed mailing lists
//
// Implements mailing list semantics on top of the postcall protocol.
// Each post is P2C committed, hash-chained, and permanently recorded.
// No central server dependency — the chain IS the archive.

import { taggedHash, HASH_TAGS, toHex, fromHex, utf8, concatBytes, u32be } from '@postcall/protocol';

// ---- types ----

export interface PostEntry {
  readonly seq: number;
  readonly from: string;           // partyId hex of sender
  readonly subject: string;        // post subject (UTF-8 hex)
  readonly bodyHex: string;        // post body hex
  readonly p2cCommitment: string;  // tweaked pubkey hex
  readonly timestamp: number;
  readonly replyTo?: number;       // optional: seq of parent post (threading)
}

export interface ListState {
  readonly listId: string;
  readonly name: string;
  readonly owner: string;          // partyId hex of list owner
  readonly subscribers: readonly string[];   // partyId hex[]
  readonly posts: readonly PostEntry[];
  readonly phase: 'active' | 'archived';
  readonly transcriptHash: string; // cumulative hash hex
  readonly nextSeq: number;
  readonly createdAt: number;
}

export type ListStep =
  | { readonly kind: 'subscribe'; readonly agent: string }
  | { readonly kind: 'unsubscribe'; readonly agent: string }
  | { readonly kind: 'post'; readonly from: string; readonly subject: string; readonly bodyHex: string; readonly p2cCommitment: string; readonly timestamp: number; readonly replyTo?: number }
  | { readonly kind: 'archive' };

export type Applied<S> =
  | { readonly ok: true; readonly state: S }
  | { readonly ok: false; readonly reason: string };

/** Initialize a new mailing list state. */
export function initList(
  listId: string,
  name: string,
  owner: string,
): ListState {
  const genesisHash = taggedHash(
    HASH_TAGS.transcript,
    utf8(listId),
    utf8(name),
    fromHex(owner),
  );
  return {
    listId,
    name,
    owner,
    subscribers: [owner], // owner is auto-subscribed
    posts: [],
    phase: 'active',
    transcriptHash: toHex(genesisHash),
    nextSeq: 0,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function chainHash(prevHash: string, step: ListStep): string {
  const prevBytes = fromHex(prevHash);
  if (step.kind === 'archive') {
    return toHex(taggedHash(HASH_TAGS.transcript, prevBytes, utf8('archive')));
  }
  if (step.kind === 'subscribe') {
    return toHex(taggedHash(HASH_TAGS.transcript, prevBytes, utf8('sub:'), fromHex(step.agent)));
  }
  if (step.kind === 'unsubscribe') {
    return toHex(taggedHash(HASH_TAGS.transcript, prevBytes, utf8('unsub:'), fromHex(step.agent)));
  }
  // post
  const stepBytes = concatBytes(
    prevBytes,
    fromHex(step.from),
    utf8(step.subject),
    fromHex(step.bodyHex),
    u32be(step.timestamp),
  );
  return toHex(taggedHash(HASH_TAGS.transcript, stepBytes));
}

export const listModule = {
  id: 'postcall/list',
  version: '0.1.0',

  /** Pure state transition. */
  apply(state: ListState, step: ListStep): Applied<ListState> {
    if (state.phase === 'archived' && step.kind !== 'subscribe') {
      return { ok: false, reason: 'list is archived' };
    }

    switch (step.kind) {
      case 'subscribe': {
        if (state.subscribers.includes(step.agent)) {
          return { ok: false, reason: 'already subscribed' };
        }
        return {
          ok: true,
          state: {
            ...state,
            subscribers: [...state.subscribers, step.agent],
            transcriptHash: chainHash(state.transcriptHash, step),
          },
        };
      }

      case 'unsubscribe': {
        if (!state.subscribers.includes(step.agent)) {
          return { ok: false, reason: 'not subscribed' };
        }
        if (step.agent === state.owner) {
          return { ok: false, reason: 'owner cannot unsubscribe' };
        }
        return {
          ok: true,
          state: {
            ...state,
            subscribers: state.subscribers.filter(s => s !== step.agent),
            transcriptHash: chainHash(state.transcriptHash, step),
          },
        };
      }

      case 'post': {
        // Only subscribers can post
        if (!state.subscribers.includes(step.from)) {
          return { ok: false, reason: 'only subscribers can post' };
        }
        // Validate replyTo if provided
        if (step.replyTo !== undefined) {
          if (step.replyTo < 0 || step.replyTo >= state.nextSeq) {
            return { ok: false, reason: 'invalid replyTo seq' };
          }
        }

        const entry: PostEntry = {
          seq: state.nextSeq,
          from: step.from,
          subject: step.subject,
          bodyHex: step.bodyHex,
          p2cCommitment: step.p2cCommitment,
          timestamp: step.timestamp,
          replyTo: step.replyTo,
        };

        return {
          ok: true,
          state: {
            ...state,
            posts: [...state.posts, entry],
            transcriptHash: chainHash(state.transcriptHash, step),
            nextSeq: state.nextSeq + 1,
          },
        };
      }

      case 'archive': {
        return {
          ok: true,
          state: {
            ...state,
            phase: 'archived',
            transcriptHash: chainHash(state.transcriptHash, step),
          },
        };
      }
    }
  },

  /** Get posts visible to a subscriber. */
  getPostsForSubscriber(state: ListState, agent: string): readonly PostEntry[] {
    if (!state.subscribers.includes(agent)) return [];
    return state.posts;
  },

  /** Get unread posts for a subscriber (after a given seq). */
  getUnreadPosts(state: ListState, agent: string, afterSeq: number): readonly PostEntry[] {
    if (!state.subscribers.includes(agent)) return [];
    return state.posts.filter(p => p.seq > afterSeq);
  },
};
