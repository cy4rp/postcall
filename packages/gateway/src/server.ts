// @postcall/gateway — GET-only HTTP server
//
// Every endpoint is GET. AI agents interact using only curl/wget.
// The Gateway translates GET requests into BSV transactions + relay messages.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  genKeyPair,
  partyId,
  toHex,
  fromHex,
  verifyData,
  commitP2C,
  taggedHash,
  HASH_TAGS,
  utf8,
  createRelay,
  type RelayCore,
} from '@postcall/protocol';
import {
  conversationModule,
  initConversation,
  type ConversationState,
  type ConversationStep,
} from '@postcall/conversation';

// ---- types ----

export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
}

interface AgentRecord {
  readonly name: string;
  readonly partyIdHex: string;
  readonly pubHex: string;
  readonly capabilities: string[];
  readonly registeredAt: number;
}

interface ConversationRecord {
  readonly id: string;
  readonly state: ConversationState;
  readonly token: string;
}

// ---- gateway ----

export function createGateway(config: Partial<GatewayConfig> = {}) {
  const port = config.port ?? 3000;
  const host = config.host ?? '0.0.0.0';

  const agents = new Map<string, AgentRecord>();      // partyIdHex → AgentRecord
  const conversations = new Map<string, ConversationRecord>(); // convId → ConversationRecord
  const relay: RelayCore = createRelay();

  // Gateway has its own key pair for constructing P2C commitments
  const gatewayKp = genKeyPair();

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
  }

  function badRequest(res: ServerResponse, msg: string) {
    json(res, 400, { error: msg });
  }

  // ---- handlers ----

  function handleRegister(params: URLSearchParams, res: ServerResponse) {
    const pubHex = params.get('pubkey');
    const name = params.get('name') ?? 'unnamed';
    const caps = params.get('caps')?.split(',') ?? [];

    if (!pubHex) return badRequest(res, 'pubkey required');

    let pub: Uint8Array;
    try {
      pub = fromHex(pubHex);
    } catch {
      return badRequest(res, 'invalid pubkey hex');
    }

    let pid: Uint8Array;
    try {
      pid = partyId(pub);
    } catch {
      return badRequest(res, 'pubkey must be 65B uncompressed');
    }

    const pidHex = toHex(pid);

    if (agents.has(pidHex)) {
      return json(res, 200, { agent_id: pidHex, status: 'already_registered' });
    }

    agents.set(pidHex, {
      name,
      partyIdHex: pidHex,
      pubHex,
      capabilities: caps,
      registeredAt: Math.floor(Date.now() / 1000),
    });

    json(res, 201, { agent_id: pidHex, name, capabilities: caps });
  }

  function handleOpen(params: URLSearchParams, res: ServerResponse) {
    const from = params.get('from');
    const to = params.get('to');

    if (!from || !to) return badRequest(res, 'from and to required');
    if (!agents.has(from)) return badRequest(res, 'from agent not registered');
    if (!agents.has(to)) return badRequest(res, 'to agent not registered');

    // Generate conversation ID
    const convId = toHex(taggedHash(
      HASH_TAGS.state,
      utf8(`${from}:${to}:${Date.now()}`),
    )).slice(0, 16);

    const state = initConversation(convId, [from, to]);
    const token = toHex(taggedHash(HASH_TAGS.state, utf8(convId + ':token'))).slice(0, 32);

    // Open relay channel
    relay.open(convId, token);

    conversations.set(convId, { id: convId, state, token });

    json(res, 201, {
      conversation_id: convId,
      participants: [from, to],
      transcript_hash: state.transcriptHash,
    });
  }

  function handleSend(params: URLSearchParams, res: ServerResponse) {
    const conv = params.get('conv');
    const from = params.get('from');
    const type = params.get('type') as 'msg' | 'req' | 'res' | 'ack' | undefined;
    const body = params.get('body');
    const sig = params.get('sig');

    if (!conv || !from || !body) return badRequest(res, 'conv, from, body required');

    const record = conversations.get(conv);
    if (!record) return badRequest(res, 'conversation not found');

    const agent = agents.get(from);
    if (!agent) return badRequest(res, 'from agent not registered');

    // Decode body from base64url
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = base64urlToBytes(body);
    } catch {
      return badRequest(res, 'invalid base64url body');
    }
    const bodyHex = toHex(bodyBytes);

    // Verify signature if provided
    if (sig) {
      try {
        const pub = fromHex(agent.pubHex);
        const valid = verifyData(bodyBytes, fromHex(sig), pub);
        if (!valid) return json(res, 401, { error: 'invalid signature' });
      } catch {
        return json(res, 401, { error: 'signature verification failed' });
      }
    }

    // Create P2C commitment for this message
    const pub = fromHex(agent.pubHex);
    const p2c = commitP2C(pub, bodyBytes);
    const p2cHex = toHex(p2c.tweakedPubCompressed);

    const messageKind = type ?? 'msg';
    const timestamp = Math.floor(Date.now() / 1000);

    // Apply step to conversation state machine
    const step: ConversationStep = {
      kind: 'message',
      from,
      messageKind,
      bodyHex,
      p2cCommitment: p2cHex,
      timestamp,
    };

    const result = conversationModule.apply(record.state, step);
    if (!result.ok) return badRequest(res, result.reason);

    // Update state
    conversations.set(conv, { ...record, state: result.state });

    // Publish to relay as raw message (gateway does not sign on behalf of agents)
    const relayMsg = {
      conversationId: conv,
      from,
      to: record.state.participants.find(p => p !== from) ?? '*',
      messageKind,
      sequenceNo: result.state.nextSeq - 1,
      bodyHex,
      timestamp,
      p2cCommitment: p2cHex,
    };
    const relayHex = toHex(utf8(JSON.stringify(relayMsg)));
    relay.publish(conv, record.token, relayHex);

    json(res, 200, {
      conversation_id: conv,
      seq: result.state.nextSeq - 1,
      transcript_hash: result.state.transcriptHash,
      p2c_commitment: p2cHex,
      body_text: new TextDecoder().decode(bodyBytes),
    });
  }

  function handleInbox(params: URLSearchParams, res: ServerResponse) {
    const agent = params.get('agent');
    const unreadOnly = params.get('unread') === 'true';

    if (!agent) return badRequest(res, 'agent required');

    const messages: Array<{
      conversation_id: string;
      seq: number;
      from: string;
      kind: string;
      body_text: string;
      p2c_commitment: string;
      timestamp: number;
    }> = [];

    for (const [convId, record] of conversations) {
      if (!record.state.participants.includes(agent)) continue;
      for (const msg of record.state.messages) {
        if (msg.from === agent) continue; // skip own messages
        messages.push({
          conversation_id: convId,
          seq: msg.seq,
          from: msg.from,
          kind: msg.kind,
          body_text: hexToUtf8(msg.bodyHex),
          p2c_commitment: msg.p2cCommitment,
          timestamp: msg.timestamp,
        });
      }
    }

    json(res, 200, { messages, count: messages.length });
  }

  function handleThread(params: URLSearchParams, res: ServerResponse) {
    const conv = params.get('conv');
    if (!conv) return badRequest(res, 'conv required');

    const record = conversations.get(conv);
    if (!record) return badRequest(res, 'conversation not found');

    const messages = record.state.messages.map(msg => ({
      seq: msg.seq,
      from: msg.from,
      kind: msg.kind,
      body_text: hexToUtf8(msg.bodyHex),
      p2c_commitment: msg.p2cCommitment,
      timestamp: msg.timestamp,
    }));

    json(res, 200, {
      conversation_id: conv,
      participants: record.state.participants,
      phase: record.state.phase,
      transcript_hash: record.state.transcriptHash,
      messages,
    });
  }

  function handleListen(params: URLSearchParams, req: IncomingMessage, res: ServerResponse) {
    const conv = params.get('conv');
    const agent = params.get('agent');

    if (!conv || !agent) return badRequest(res, 'conv and agent required');

    const record = conversations.get(conv);
    if (!record) return badRequest(res, 'conversation not found');

    // SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sub = relay.subscribe(conv, record.token, (msgHex, seq) => {
      try {
        const msgBytes = fromHex(msgHex);
        const msgObj = JSON.parse(new TextDecoder().decode(msgBytes)) as {
          from: string; messageKind: string; bodyHex: string; timestamp: number;
        };
        if (msgObj.from === agent) return; // skip own messages
        const bodyText = hexToUtf8(msgObj.bodyHex);
        res.write(`data: ${JSON.stringify({
          seq,
          from: msgObj.from,
          kind: msgObj.messageKind,
          body_text: bodyText,
          timestamp: msgObj.timestamp,
        })}\n\n`);
      } catch { /* skip malformed */ }
    });

    if (!sub.ok) return badRequest(res, sub.reason);

    req.on('close', () => { sub.value.unsubscribe(); });
  }

  function handleAgents(_params: URLSearchParams, res: ServerResponse) {
    const list = [...agents.values()].map(a => ({
      agent_id: a.partyIdHex,
      name: a.name,
      capabilities: a.capabilities,
    }));
    json(res, 200, { agents: list, count: list.length });
  }

  function handleVerify(params: URLSearchParams, res: ServerResponse) {
    const conv = params.get('conv');
    const seq = params.get('seq');

    if (!conv || seq === null) return badRequest(res, 'conv and seq required');

    const record = conversations.get(conv);
    if (!record) return badRequest(res, 'conversation not found');

    const seqNum = parseInt(seq, 10);
    const msg = record.state.messages.find(m => m.seq === seqNum);
    if (!msg) return badRequest(res, 'message not found');

    const agent = agents.get(msg.from);
    if (!agent) return badRequest(res, 'sender agent not found');

    // Verify P2C commitment
    const pub = fromHex(agent.pubHex);
    const bodyBytes = fromHex(msg.bodyHex);
    const p2c = commitP2C(pub, bodyBytes);
    const recomputedHex = toHex(p2c.tweakedPubCompressed);
    const p2cValid = recomputedHex === msg.p2cCommitment;

    json(res, 200, {
      conversation_id: conv,
      seq: seqNum,
      p2c_valid: p2cValid,
      commitment: msg.p2cCommitment,
      recomputed: recomputedHex,
      body_text: hexToUtf8(msg.bodyHex),
    });
  }

  function handleSettle(params: URLSearchParams, res: ServerResponse) {
    const conv = params.get('conv');
    if (!conv) return badRequest(res, 'conv required');

    const record = conversations.get(conv);
    if (!record) return badRequest(res, 'conversation not found');

    const step: ConversationStep = { kind: 'settle' };
    const result = conversationModule.apply(record.state, step);
    if (!result.ok) return badRequest(res, result.reason);

    conversations.set(conv, { ...record, state: result.state });

    json(res, 200, {
      conversation_id: conv,
      phase: 'settled',
      transcript_hash: result.state.transcriptHash,
      message_count: result.state.messages.length,
    });
  }

  function handleHealth(_params: URLSearchParams, res: ServerResponse) {
    json(res, 200, {
      status: 'ok',
      agents: agents.size,
      conversations: conversations.size,
      relay_channels: relay.channelCount(),
      gateway_id: toHex(partyId(gatewayKp.pub)),
    });
  }

  // ---- router ----

  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GET only' }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '');
    const params = url.searchParams;

    switch (path) {
      case '/v1/register': return handleRegister(params, res);
      case '/v1/open':     return handleOpen(params, res);
      case '/v1/send':     return handleSend(params, res);
      case '/v1/inbox':    return handleInbox(params, res);
      case '/v1/thread':   return handleThread(params, res);
      case '/v1/listen':   return handleListen(params, req, res);
      case '/v1/agents':   return handleAgents(params, res);
      case '/v1/verify':   return handleVerify(params, res);
      case '/v1/settle':   return handleSettle(params, res);
      case '/v1/health':   return handleHealth(params, res);
      default:
        json(res, 404, {
          error: 'not found',
          endpoints: [
            'GET /v1/register', 'GET /v1/open', 'GET /v1/send',
            'GET /v1/inbox', 'GET /v1/thread', 'GET /v1/listen',
            'GET /v1/agents', 'GET /v1/verify', 'GET /v1/settle',
            'GET /v1/health',
          ],
        });
    }
  });

  return {
    start() {
      return new Promise<void>((resolve) => {
        server.listen(port, host, () => {
          console.log(`postcall gateway listening on http://${host}:${port}`);
          resolve();
        });
      });
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    },
    server,
    agents,
    conversations,
    relay,
  };
}

// ---- helpers ----

function base64urlToBytes(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hexToUtf8(hex: string): string {
  try {
    return new TextDecoder().decode(fromHex(hex));
  } catch {
    return `[hex:${hex.slice(0, 16)}...]`;
  }
}

// ---- main ----

if (process.argv[1] && (process.argv[1].endsWith('/index.ts') || process.argv[1].endsWith('/index.js') || process.argv[1].endsWith('/server.ts') || process.argv[1].endsWith('/server.js'))) {
  const gw = createGateway({ port: parseInt(process.env['PORT'] ?? '3000', 10) });
  gw.start();
}
