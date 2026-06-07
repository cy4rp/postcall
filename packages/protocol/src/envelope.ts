// @postcall/protocol — signed protocol envelope
//
// Every postcall message is a SIGNED envelope. The signed payload binds
// conversationId / from / to / messageKind / sequenceNo / priorTranscriptHash / body.

import { canonicalStringify, utf8, toHex, fromHex } from './encoding.js';
import { taggedHash, HASH_TAGS } from './hash.js';
import { signData, verifyData, partyId, type KeyPair } from './crypto.js';

export type MessageKind = 'msg' | 'req' | 'res' | 'ack' | 'open' | 'close';

export const MAX_ENVELOPE_BYTES = 256 * 1024;

export interface EnvelopeFields {
  readonly conversationId: string;
  readonly from: string;                  // 33B partyId hex (sender)
  readonly to: string;                    // 33B partyId hex (recipient) or '*' for broadcast
  readonly messageKind: MessageKind;
  readonly sequenceNo: number;
  readonly priorTranscriptHash: string;   // 32B hex
  readonly bodyHex: string;               // message body as hex
  readonly timestamp: number;             // unix seconds
}

export interface Envelope extends EnvelopeFields {
  readonly sigHex: string;                // ECDSA DER signature hex
  readonly actorPubKeyHex: string;        // 65B uncompressed pub hex
}

function envelopePayload(fields: EnvelopeFields): Uint8Array {
  const canonical = canonicalStringify({
    bodyHex: fields.bodyHex,
    conversationId: fields.conversationId,
    from: fields.from,
    messageKind: fields.messageKind,
    priorTranscriptHash: fields.priorTranscriptHash,
    sequenceNo: fields.sequenceNo,
    timestamp: fields.timestamp,
    to: fields.to,
  });
  return taggedHash(HASH_TAGS.envelope, utf8(canonical));
}

/** Sign an envelope with the agent's key. */
export function signEnvelope(fields: EnvelopeFields, kp: KeyPair): Envelope {
  const senderPartyId = toHex(partyId(kp.pub));
  if (senderPartyId !== fields.from) {
    throw new Error(`from field (${fields.from}) does not match signing key partyId (${senderPartyId})`);
  }
  const payload = envelopePayload(fields);
  const sig = signData(payload, kp);
  return {
    ...fields,
    sigHex: toHex(sig),
    actorPubKeyHex: toHex(kp.pub),
  };
}

/** Verify an envelope's signature. Returns true if valid. */
export function verifyEnvelope(env: Envelope): boolean {
  try {
    const pub = fromHex(env.actorPubKeyHex);
    const senderPartyId = toHex(partyId(pub));
    if (senderPartyId !== env.from) return false;

    const payload = envelopePayload(env);
    const sig = fromHex(env.sigHex);
    return verifyData(payload, sig, pub);
  } catch {
    return false;
  }
}

/** Serialize an envelope to hex for relay transport. */
export function envelopeToHex(env: Envelope): string {
  return toHex(utf8(JSON.stringify(env)));
}

/** Deserialize an envelope from hex. */
export function envelopeFromHex(hex: string): Envelope {
  const bytes = fromHex(hex);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as Envelope;
}
