// @postcall/conversation — ConversationModule: a pure state machine for AI agent dialogue
//
// Implements the ContractModule pattern from bsv-universal-sdk.
// No I/O, no clock, no RNG. State is derived from the transcript alone.

import { taggedHash, HASH_TAGS, toHex, fromHex, utf8, concatBytes, u32be } from '@postcall/protocol';

// ---- types ----

export interface MessageEntry {
  readonly seq: number;
  readonly from: string;           // 33B partyId hex
  readonly kind: 'msg' | 'req' | 'res' | 'ack';
  readonly bodyHex: string;        // message body hex
  readonly p2cCommitment: string;  // tweaked pubkey hex (on-chain identifier)
  readonly timestamp: number;
}

export interface ConversationState {
  readonly conversationId: string;
  readonly participants: readonly string[];   // partyId hex[]
  readonly messages: readonly MessageEntry[];
  readonly phase: 'open' | 'pending_reply' | 'settled';
  readonly transcriptHash: string;            // cumulative hash hex
  readonly nextSeq: number;
}

export type ConversationStep =
  | { readonly kind: 'message'; readonly from: string; readonly messageKind: 'msg' | 'req' | 'res' | 'ack'; readonly bodyHex: string; readonly p2cCommitment: string; readonly timestamp: number }
  | { readonly kind: 'settle' };

export type Applied<S> =
  | { readonly ok: true; readonly state: S }
  | { readonly ok: false; readonly reason: string };

export interface LegalAction {
  readonly type: string;
  readonly party: string;
}

/** Initialize a new conversation state. */
export function initConversation(
  conversationId: string,
  participants: readonly string[],
): ConversationState {
  if (participants.length < 2) throw new Error('need at least 2 participants');
  const sorted = [...participants].sort();
  const genesisHash = taggedHash(
    HASH_TAGS.transcript,
    utf8(conversationId),
    ...sorted.map(p => fromHex(p)),
  );
  return {
    conversationId,
    participants: sorted,
    messages: [],
    phase: 'open',
    transcriptHash: toHex(genesisHash),
    nextSeq: 0,
  };
}

function chainHash(prevHash: string, step: ConversationStep): string {
  const prevBytes = fromHex(prevHash);
  if (step.kind === 'settle') {
    return toHex(taggedHash(HASH_TAGS.transcript, prevBytes, utf8('settle')));
  }
  const stepBytes = concatBytes(
    prevBytes,
    fromHex(step.from),
    utf8(step.messageKind),
    fromHex(step.bodyHex),
    u32be(step.timestamp),
  );
  return toHex(taggedHash(HASH_TAGS.transcript, stepBytes));
}

export const conversationModule = {
  id: 'postcall/conversation',
  version: '0.1.0',

  /** Pure state transition. Total: returns next state or a typed rejection; never throws. */
  apply(state: ConversationState, step: ConversationStep): Applied<ConversationState> {
    if (state.phase === 'settled') {
      return { ok: false, reason: 'conversation already settled' };
    }

    if (step.kind === 'settle') {
      return {
        ok: true,
        state: {
          ...state,
          phase: 'settled',
          transcriptHash: chainHash(state.transcriptHash, step),
        },
      };
    }

    // Validate participant
    if (!state.participants.includes(step.from)) {
      return { ok: false, reason: `unknown participant: ${step.from}` };
    }

    // Validate message kind transitions
    if (step.messageKind === 'res' && state.phase !== 'pending_reply') {
      return { ok: false, reason: 'res without prior req' };
    }
    if (step.messageKind === 'ack' && state.messages.length === 0) {
      return { ok: false, reason: 'ack without prior message' };
    }

    const entry: MessageEntry = {
      seq: state.nextSeq,
      from: step.from,
      kind: step.messageKind,
      bodyHex: step.bodyHex,
      p2cCommitment: step.p2cCommitment,
      timestamp: step.timestamp,
    };

    const newPhase = step.messageKind === 'req' ? 'pending_reply' as const
      : step.messageKind === 'res' ? 'open' as const
      : state.phase;

    return {
      ok: true,
      state: {
        ...state,
        messages: [...state.messages, entry],
        phase: newPhase,
        transcriptHash: chainHash(state.transcriptHash, step),
        nextSeq: state.nextSeq + 1,
      },
    };
  },

  /** Enumerate legal actions for each participant. */
  getLegalActions(state: ConversationState): readonly LegalAction[] {
    if (state.phase === 'settled') return [];

    const actions: LegalAction[] = [];
    for (const p of state.participants) {
      actions.push({ type: 'send_msg', party: p });
      actions.push({ type: 'send_req', party: p });
      if (state.phase === 'pending_reply') {
        actions.push({ type: 'send_res', party: p });
      }
      actions.push({ type: 'send_ack', party: p });
      actions.push({ type: 'settle', party: p });
    }
    return actions;
  },

  timeoutBranch(state: ConversationState): string | null {
    return state.phase === 'pending_reply' ? 'timeout_refund' : null;
  },

  isComplete(state: ConversationState): boolean {
    return state.phase === 'settled';
  },

  /** Replay a transcript from genesis. */
  replay(
    conversationId: string,
    participants: readonly string[],
    steps: readonly ConversationStep[],
  ): Applied<ConversationState> {
    let state = initConversation(conversationId, participants);
    for (const step of steps) {
      const result = conversationModule.apply(state, step);
      if (!result.ok) return result;
      state = result.state;
    }
    return { ok: true, state };
  },
};
