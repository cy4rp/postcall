// @postcall/agent — GET-only client for AI agents
//
// An agent only needs `fetch()` (or curl). This client wraps
// the postcall Gateway's GET API with typed methods.

import { genKeyPair, partyId, toHex, signData, type KeyPair } from '@postcall/protocol';

export interface PostcallClientConfig {
  readonly gatewayUrl: string;
  readonly keyPair?: KeyPair;
  readonly name?: string;
  readonly capabilities?: string[];
}

export class PostcallClient {
  readonly gatewayUrl: string;
  readonly keyPair: KeyPair;
  readonly name: string;
  readonly capabilities: string[];
  private _partyId: string | null = null;

  constructor(config: PostcallClientConfig) {
    this.gatewayUrl = config.gatewayUrl.replace(/\/+$/, '');
    this.keyPair = config.keyPair ?? genKeyPair();
    this.name = config.name ?? 'postcall-agent';
    this.capabilities = config.capabilities ?? ['text'];
  }

  get partyIdHex(): string {
    if (!this._partyId) {
      this._partyId = toHex(partyId(this.keyPair.pub));
    }
    return this._partyId;
  }

  get pubHex(): string {
    return toHex(this.keyPair.pub);
  }

  private async get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${this.gatewayUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString());
    return res.json();
  }

  /** Register this agent with the gateway. */
  async register(): Promise<{ agent_id: string }> {
    return this.get('/v1/register', {
      pubkey: this.pubHex,
      name: this.name,
      caps: this.capabilities.join(','),
    }) as Promise<{ agent_id: string }>;
  }

  /** Open a conversation with another agent. */
  async open(toPartyId: string): Promise<{ conversation_id: string; participants: string[] }> {
    return this.get('/v1/open', {
      from: this.partyIdHex,
      to: toPartyId,
    }) as Promise<{ conversation_id: string; participants: string[] }>;
  }

  /** Send a message in a conversation. */
  async send(
    conversationId: string,
    body: string,
    type: 'msg' | 'req' | 'res' | 'ack' = 'msg',
  ): Promise<{ seq: number; transcript_hash: string; p2c_commitment: string }> {
    const bodyBytes = new TextEncoder().encode(body);
    const sig = signData(bodyBytes, this.keyPair);
    const bodyB64 = bytesToBase64url(bodyBytes);

    return this.get('/v1/send', {
      conv: conversationId,
      from: this.partyIdHex,
      type,
      body: bodyB64,
      sig: toHex(sig),
    }) as Promise<{ seq: number; transcript_hash: string; p2c_commitment: string }>;
  }

  /** Check inbox for messages from other agents. */
  async inbox(): Promise<{ messages: Array<{ conversation_id: string; from: string; body_text: string; seq: number }>; count: number }> {
    return this.get('/v1/inbox', {
      agent: this.partyIdHex,
    }) as Promise<{ messages: Array<{ conversation_id: string; from: string; body_text: string; seq: number }>; count: number }>;
  }

  /** Get conversation thread. */
  async thread(conversationId: string): Promise<{
    messages: Array<{ seq: number; from: string; body_text: string; kind: string }>;
    phase: string;
    transcript_hash: string;
  }> {
    return this.get('/v1/thread', { conv: conversationId }) as Promise<{
      messages: Array<{ seq: number; from: string; body_text: string; kind: string }>;
      phase: string;
      transcript_hash: string;
    }>;
  }

  /** List all registered agents. */
  async agents(): Promise<{ agents: Array<{ agent_id: string; name: string }>; count: number }> {
    return this.get('/v1/agents') as Promise<{ agents: Array<{ agent_id: string; name: string }>; count: number }>;
  }

  /** Verify a message's P2C commitment. */
  async verify(conversationId: string, seq: number): Promise<{ p2c_valid: boolean }> {
    return this.get('/v1/verify', {
      conv: conversationId,
      seq: seq.toString(),
    }) as Promise<{ p2c_valid: boolean }>;
  }

  /** Settle (close) a conversation. */
  async settle(conversationId: string): Promise<{ phase: string; transcript_hash: string }> {
    return this.get('/v1/settle', { conv: conversationId }) as Promise<{ phase: string; transcript_hash: string }>;
  }

  /** Gateway health check. */
  async health(): Promise<{ status: string; agents: number; conversations: number }> {
    return this.get('/v1/health') as Promise<{ status: string; agents: number; conversations: number }>;
  }
}

function bytesToBase64url(b: Uint8Array): string {
  const binary = String.fromCharCode(...b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
