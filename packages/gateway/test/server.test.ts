import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGateway } from '../src/server.js';
import { genKeyPair, partyId, toHex } from '@postcall/protocol';

describe('Gateway (GET-only)', () => {
  const gw = createGateway({ port: 0, host: '127.0.0.1' }); // port 0 = random
  let baseUrl: string;
  const kpA = genKeyPair();
  const kpB = genKeyPair();
  const pidA = toHex(partyId(kpA.pub));
  const pidB = toHex(partyId(kpB.pub));

  beforeAll(async () => {
    await gw.start();
    const addr = gw.server.address();
    if (typeof addr === 'object' && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    await gw.stop();
  });

  async function get(path: string): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`);
    return res.json();
  }

  it('should return health', async () => {
    const health = await get('/v1/health') as { status: string };
    expect(health.status).toBe('ok');
  });

  it('should reject non-GET', async () => {
    const res = await fetch(`${baseUrl}/v1/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('should register agents', async () => {
    const r1 = await get(`/v1/register?pubkey=${toHex(kpA.pub)}&name=agent-a`) as { agent_id: string };
    expect(r1.agent_id).toBe(pidA);

    const r2 = await get(`/v1/register?pubkey=${toHex(kpB.pub)}&name=agent-b`) as { agent_id: string };
    expect(r2.agent_id).toBe(pidB);
  });

  it('should list agents', async () => {
    const r = await get('/v1/agents') as { agents: unknown[]; count: number };
    expect(r.count).toBeGreaterThanOrEqual(2);
  });

  let convId: string;

  it('should open a conversation', async () => {
    const r = await get(`/v1/open?from=${pidA}&to=${pidB}`) as { conversation_id: string };
    expect(r.conversation_id).toBeTruthy();
    convId = r.conversation_id;
  });

  it('should send a message', async () => {
    const body = btoa('hello from A');
    const r = await get(`/v1/send?conv=${convId}&from=${pidA}&body=${body}&type=msg`) as {
      seq: number; p2c_commitment: string; body_text: string;
    };
    expect(r.seq).toBe(0);
    expect(r.p2c_commitment).toBeTruthy();
    expect(r.body_text).toBe('hello from A');
  });

  it('should send a reply', async () => {
    const body = btoa('hello from B');
    const r = await get(`/v1/send?conv=${convId}&from=${pidB}&body=${body}&type=msg`) as {
      seq: number; body_text: string;
    };
    expect(r.seq).toBe(1);
    expect(r.body_text).toBe('hello from B');
  });

  it('should get thread', async () => {
    const r = await get(`/v1/thread?conv=${convId}`) as {
      messages: Array<{ seq: number; body_text: string }>;
      phase: string;
    };
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.body_text).toBe('hello from A');
    expect(r.messages[1]!.body_text).toBe('hello from B');
    expect(r.phase).toBe('open');
  });

  it('should get inbox for B', async () => {
    const r = await get(`/v1/inbox?agent=${pidB}`) as {
      messages: Array<{ from: string; body_text: string }>;
      count: number;
    };
    expect(r.count).toBeGreaterThanOrEqual(1);
    const fromA = r.messages.find(m => m.from === pidA);
    expect(fromA).toBeTruthy();
    expect(fromA!.body_text).toBe('hello from A');
  });

  it('should verify P2C commitment', async () => {
    const r = await get(`/v1/verify?conv=${convId}&seq=0`) as {
      p2c_valid: boolean;
    };
    expect(r.p2c_valid).toBe(true);
  });

  it('should settle conversation', async () => {
    const r = await get(`/v1/settle?conv=${convId}`) as {
      phase: string; message_count: number;
    };
    expect(r.phase).toBe('settled');
    expect(r.message_count).toBe(2);
  });

  it('should reject message on settled conversation', async () => {
    const body = btoa('too late');
    const r = await get(`/v1/send?conv=${convId}&from=${pidA}&body=${body}&type=msg`) as {
      error: string;
    };
    expect(r.error).toBeTruthy();
  });

  it('should return 404 for unknown routes', async () => {
    const r = await get('/v1/nonexistent') as { error: string; endpoints: string[] };
    expect(r.error).toBe('not found');
    expect(r.endpoints).toBeTruthy();
  });
});
