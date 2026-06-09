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
  privkeyToWif,
  privToCompressedPub,
  pubkeyToAddress,
} from '@postcall/protocol';
import {
  conversationModule,
  initConversation,
  type ConversationState,
  type ConversationStep,
} from '@postcall/conversation';
import {
  listModule,
  initList,
  type ListState,
  type ListStep,
} from '@postcall/list';
import { GatewayWallet, type BroadcastResult } from './wallet.js';
import { HTML_UI } from './ui.js';

// ---- types ----

export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  readonly bsvWalletKey?: string; // WIF or hex private key for BSV testnet wallet
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

interface ListRecord {
  readonly id: string;
  readonly state: ListState;
}

// ---- gateway ----

export function createGateway(config: Partial<GatewayConfig> = {}) {
  const port = config.port ?? 3000;
  const host = config.host ?? '0.0.0.0';

  const agents = new Map<string, AgentRecord>();      // partyIdHex → AgentRecord
  const conversations = new Map<string, ConversationRecord>(); // convId → ConversationRecord
  const lists = new Map<string, ListRecord>();          // listId → ListRecord
  const relay: RelayCore = createRelay();

  // Gateway has its own key pair for constructing P2C commitments
  const gatewayKp = genKeyPair();

  // BSV testnet wallet (pays for on-chain transactions)
  const wallet = new GatewayWallet(config.bsvWalletKey);
  let walletRefreshTimer: ReturnType<typeof setInterval> | null = null;

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

  function handleKeygen(params: URLSearchParams, res: ServerResponse) {
    const name = params.get('name') ?? 'unnamed';
    const autoRegister = params.get('register') !== 'false';

    // Generate fresh secp256k1 key pair
    const kp = genKeyPair();
    const compressed = privToCompressedPub(kp.priv);
    const pid = partyId(kp.pub);
    const pidHex = toHex(pid);
    const wif = privkeyToWif(kp.priv, true, true); // testnet, compressed
    const address = pubkeyToAddress(compressed, true); // testnet

    // Auto-register unless ?register=false
    if (autoRegister && !agents.has(pidHex)) {
      agents.set(pidHex, {
        name,
        partyIdHex: pidHex,
        pubHex: toHex(kp.pub),
        capabilities: [],
        registeredAt: Math.floor(Date.now() / 1000),
      });
    }

    json(res, 201, {
      agent_id: pidHex,
      name,
      registered: autoRegister,
      public_key: toHex(kp.pub),
      public_key_compressed: toHex(compressed),
      private_key_hex: toHex(kp.priv),
      private_key_wif: wif,
      bsv_address: address,
      warning: 'Save your private_key_wif securely. Anyone with this key can act as you. This key will NOT be shown again.',
    });
  }

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

  async function handleSend(params: URLSearchParams, res: ServerResponse) {
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

    // Broadcast P2C commitment to BSV testnet
    let txResult: BroadcastResult | null = null;
    if (wallet.isFunded()) {
      txResult = await wallet.broadcastP2C(p2c.tweakedPubCompressed);
    }

    json(res, 200, {
      conversation_id: conv,
      seq: result.state.nextSeq - 1,
      transcript_hash: result.state.transcriptHash,
      p2c_commitment: p2cHex,
      body_text: new TextDecoder().decode(bodyBytes),
      ...(txResult ? { txid: txResult.txid, explorer_url: txResult.explorerUrl, fee_satoshis: Number(txResult.fee) } : { txid: null, on_chain: false }),
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

  // ---- mailing list handlers ----

  function handleListCreate(params: URLSearchParams, res: ServerResponse) {
    const owner = params.get('owner');
    const name = params.get('name');

    if (!owner || !name) return badRequest(res, 'owner and name required');
    if (!agents.has(owner)) return badRequest(res, 'owner agent not registered');

    // Decode name from base64url if needed
    let listName: string;
    try {
      listName = new TextDecoder().decode(base64urlToBytes(name));
    } catch {
      listName = name; // plain text fallback
    }

    const listId = toHex(taggedHash(
      HASH_TAGS.state,
      utf8(`${owner}:${listName}:${Date.now()}`),
    )).slice(0, 16);

    const state = initList(listId, listName, owner);
    lists.set(listId, { id: listId, state });

    json(res, 201, {
      list_id: listId,
      name: listName,
      owner,
      subscribers: state.subscribers,
      transcript_hash: state.transcriptHash,
    });
  }

  function handleListSubscribe(params: URLSearchParams, res: ServerResponse) {
    const listId = params.get('list');
    const agent = params.get('agent');

    if (!listId || !agent) return badRequest(res, 'list and agent required');
    if (!agents.has(agent)) return badRequest(res, 'agent not registered');

    const record = lists.get(listId);
    if (!record) return badRequest(res, 'list not found');

    const step: ListStep = { kind: 'subscribe', agent };
    const result = listModule.apply(record.state, step);
    if (!result.ok) return badRequest(res, result.reason);

    lists.set(listId, { ...record, state: result.state });

    json(res, 200, {
      list_id: listId,
      agent,
      status: 'subscribed',
      subscriber_count: result.state.subscribers.length,
      transcript_hash: result.state.transcriptHash,
    });
  }

  function handleListUnsubscribe(params: URLSearchParams, res: ServerResponse) {
    const listId = params.get('list');
    const agent = params.get('agent');

    if (!listId || !agent) return badRequest(res, 'list and agent required');

    const record = lists.get(listId);
    if (!record) return badRequest(res, 'list not found');

    const step: ListStep = { kind: 'unsubscribe', agent };
    const result = listModule.apply(record.state, step);
    if (!result.ok) return badRequest(res, result.reason);

    lists.set(listId, { ...record, state: result.state });

    json(res, 200, {
      list_id: listId,
      agent,
      status: 'unsubscribed',
      subscriber_count: result.state.subscribers.length,
      transcript_hash: result.state.transcriptHash,
    });
  }

  async function handleListPost(params: URLSearchParams, res: ServerResponse) {
    const listId = params.get('list');
    const from = params.get('from');
    const subject = params.get('subject');
    const body = params.get('body');
    const replyToStr = params.get('reply_to');

    if (!listId || !from || !body) return badRequest(res, 'list, from, body required');

    const record = lists.get(listId);
    if (!record) return badRequest(res, 'list not found');

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

    // Decode subject
    let subjectText: string;
    if (subject) {
      try {
        subjectText = new TextDecoder().decode(base64urlToBytes(subject));
      } catch {
        subjectText = subject;
      }
    } else {
      subjectText = '(no subject)';
    }

    // Create P2C commitment
    const pub = fromHex(agent.pubHex);
    const p2c = commitP2C(pub, bodyBytes);
    const p2cHex = toHex(p2c.tweakedPubCompressed);

    const timestamp = Math.floor(Date.now() / 1000);
    const replyTo = replyToStr !== null ? parseInt(replyToStr, 10) : undefined;

    const step: ListStep = {
      kind: 'post',
      from,
      subject: subjectText,
      bodyHex,
      p2cCommitment: p2cHex,
      timestamp,
      replyTo: isNaN(replyTo as number) ? undefined : replyTo,
    };

    const result = listModule.apply(record.state, step);
    if (!result.ok) return badRequest(res, result.reason);

    lists.set(listId, { ...record, state: result.state });

    // Broadcast P2C commitment to BSV testnet
    let txResult: BroadcastResult | null = null;
    if (wallet.isFunded()) {
      txResult = await wallet.broadcastP2C(p2c.tweakedPubCompressed);
    }

    json(res, 200, {
      list_id: listId,
      seq: result.state.nextSeq - 1,
      from,
      subject: subjectText,
      body_text: new TextDecoder().decode(bodyBytes),
      p2c_commitment: p2cHex,
      transcript_hash: result.state.transcriptHash,
      delivered_to: result.state.subscribers.length,
      ...(txResult ? { txid: txResult.txid, explorer_url: txResult.explorerUrl, fee_satoshis: Number(txResult.fee) } : { txid: null, on_chain: false }),
    });
  }

  function handleListArchive(params: URLSearchParams, res: ServerResponse) {
    const listId = params.get('list');
    if (!listId) return badRequest(res, 'list required');

    const record = lists.get(listId);
    if (!record) return badRequest(res, 'list not found');

    json(res, 200, {
      list_id: listId,
      name: record.state.name,
      owner: record.state.owner,
      subscribers: record.state.subscribers,
      subscriber_count: record.state.subscribers.length,
      phase: record.state.phase,
      transcript_hash: record.state.transcriptHash,
      post_count: record.state.posts.length,
      posts: record.state.posts.map(p => ({
        seq: p.seq,
        from: p.from,
        from_name: agents.get(p.from)?.name ?? null,
        subject: p.subject,
        body_text: hexToUtf8(p.bodyHex),
        p2c_commitment: p.p2cCommitment,
        timestamp: p.timestamp,
        reply_to: p.replyTo,
      })),
    });
  }

  function handleListSubscribers(params: URLSearchParams, res: ServerResponse) {
    const listId = params.get('list');
    if (!listId) return badRequest(res, 'list required');

    const record = lists.get(listId);
    if (!record) return badRequest(res, 'list not found');

    const subscriberDetails = record.state.subscribers.map(s => {
      const a = agents.get(s);
      return { agent_id: s, name: a?.name ?? 'unknown' };
    });

    json(res, 200, {
      list_id: listId,
      name: record.state.name,
      subscribers: subscriberDetails,
      count: subscriberDetails.length,
    });
  }

  function handleListVerify(params: URLSearchParams, res: ServerResponse) {
    const listId = params.get('list');
    const seq = params.get('seq');

    if (!listId || seq === null) return badRequest(res, 'list and seq required');

    const record = lists.get(listId);
    if (!record) return badRequest(res, 'list not found');

    const seqNum = parseInt(seq, 10);
    const post = record.state.posts.find(p => p.seq === seqNum);
    if (!post) return badRequest(res, 'post not found');

    const agent = agents.get(post.from);
    if (!agent) return badRequest(res, 'sender agent not found');

    // Verify P2C commitment
    const pub = fromHex(agent.pubHex);
    const bodyBytes = fromHex(post.bodyHex);
    const p2c = commitP2C(pub, bodyBytes);
    const recomputedHex = toHex(p2c.tweakedPubCompressed);
    const p2cValid = recomputedHex === post.p2cCommitment;

    json(res, 200, {
      list_id: listId,
      seq: seqNum,
      p2c_valid: p2cValid,
      commitment: post.p2cCommitment,
      recomputed: recomputedHex,
      subject: post.subject,
      body_text: hexToUtf8(post.bodyHex),
    });
  }

  function handleLists(_params: URLSearchParams, res: ServerResponse) {
    const allLists = [...lists.values()].map(r => ({
      list_id: r.id,
      name: r.state.name,
      owner: r.state.owner,
      subscriber_count: r.state.subscribers.length,
      post_count: r.state.posts.length,
      phase: r.state.phase,
    }));
    json(res, 200, { lists: allLists, count: allLists.length });
  }

  function handleWallet(_params: URLSearchParams, res: ServerResponse) {
    const status = wallet.getStatus();
    json(res, 200, {
      address: status.address,
      balance_satoshis: Number(status.balance),
      utxo_count: status.utxoCount,
      network: status.network,
      funded: status.funded,
      explorer_url: status.explorerUrl,
      faucets: status.faucets,
    });
  }

  function handleHealth(_params: URLSearchParams, res: ServerResponse) {
    json(res, 200, {
      status: 'ok',
      agents: agents.size,
      conversations: conversations.size,
      lists: lists.size,
      relay_channels: relay.channelCount(),
      gateway_id: toHex(partyId(gatewayKp.pub)),
      bsv_wallet: {
        address: wallet.address,
        funded: wallet.isFunded(),
        balance_satoshis: Number(wallet.getBalance()),
      },
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
      case '/v1/keygen':   return handleKeygen(params, res);
      case '/v1/register': return handleRegister(params, res);
      case '/v1/open':     return handleOpen(params, res);
      case '/v1/send':     return handleSend(params, res);
      case '/v1/inbox':    return handleInbox(params, res);
      case '/v1/thread':   return handleThread(params, res);
      case '/v1/listen':   return handleListen(params, req, res);
      case '/v1/agents':   return handleAgents(params, res);
      case '/v1/verify':   return handleVerify(params, res);
      case '/v1/settle':   return handleSettle(params, res);
      case '/v1/wallet':   return handleWallet(params, res);
      case '/v1/health':   return handleHealth(params, res);
      // Mailing list endpoints
      case '/v1/list/create':      return handleListCreate(params, res);
      case '/v1/list/subscribe':   return handleListSubscribe(params, res);
      case '/v1/list/unsubscribe': return handleListUnsubscribe(params, res);
      case '/v1/list/post':        return handleListPost(params, res);
      case '/v1/list/archive':     return handleListArchive(params, res);
      case '/v1/list/subscribers': return handleListSubscribers(params, res);
      case '/v1/list/verify':      return handleListVerify(params, res);
      case '/v1/lists':            return handleLists(params, res);
      case '':
      case '/ui':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_UI);
        return;
      default:
        json(res, 404, {
          error: 'not found',
          endpoints: [
            'GET /v1/keygen', 'GET /v1/register', 'GET /v1/open', 'GET /v1/send',
            'GET /v1/inbox', 'GET /v1/thread', 'GET /v1/listen',
            'GET /v1/agents', 'GET /v1/verify', 'GET /v1/settle',
            'GET /v1/wallet', 'GET /v1/health',
            'GET /v1/list/create', 'GET /v1/list/subscribe',
            'GET /v1/list/unsubscribe', 'GET /v1/list/post',
            'GET /v1/list/archive', 'GET /v1/list/subscribers',
            'GET /v1/list/verify', 'GET /v1/lists',
          ],
        });
    }
  });

  return {
    async start() {
      // Initialize BSV wallet
      console.log(`[wallet] BSV testnet address: ${wallet.address}`);
      console.log(`[wallet] Explorer: https://test.whatsonchain.com/address/${wallet.address}`);
      await wallet.refreshUtxos();
      if (!wallet.isFunded()) {
        console.log('[wallet] NOT FUNDED — transactions will be off-chain only');
        console.log('[wallet] Fund this address to enable on-chain broadcasting:');
        console.log(`[wallet]   ${wallet.address}`);
        console.log('[wallet] Faucets: https://bsvfaucet.com  https://scrypt.io/faucet');
      } else {
        console.log(`[wallet] Funded: ${wallet.getBalance()} satoshis, ${wallet.getUtxoCount()} UTXOs`);
      }
      walletRefreshTimer = wallet.startPeriodicRefresh(60_000);

      return new Promise<void>((resolve) => {
        server.listen(port, host, () => {
          console.log(`postcall gateway listening on http://${host}:${port}`);
          resolve();
        });
      });
    },
    stop() {
      if (walletRefreshTimer) clearInterval(walletRefreshTimer);
      return new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    },
    server,
    agents,
    conversations,
    lists,
    relay,
    wallet,
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
  const gw = createGateway({
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    bsvWalletKey: process.env['BSV_WALLET_WIF'] ?? process.env['BSV_WALLET_KEY'],
  });
  gw.start();
}
