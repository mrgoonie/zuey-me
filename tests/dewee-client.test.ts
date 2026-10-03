import { describe, expect, it } from 'bun:test';
import { AppError } from '../src/lib/http';
import {
  buildSessionKey,
  gatewayUserId,
  openWorkersSocket,
  parseFrame,
  resolveDeweeConfig,
  streamChat,
} from '../src/lib/ai/dewee-client';
import type { DeweeChatEvent, DeweeConfig, GatewaySocket, SocketOpener } from '../src/lib/ai/dewee-client';

const config: DeweeConfig = { gatewayUrl: 'https://gateway.test', token: 'test-token', agentKey: 'zuey-ai' };
const SESSION = buildSessionKey('zuey-ai', 'u1', 'c1');
const RUN = '1bdd76c1-94d4-4770-8e05-e94b34b6b34a';

interface SentReq {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** In-memory gateway socket; `onRequest` scripts the server side of the protocol. */
class FakeSocket implements GatewaySocket {
  sent: SentReq[] = [];
  closed = false;
  private listeners: Record<string, Array<(event: { data: unknown }) => void>> = {};

  constructor(private onRequest: (req: SentReq, socket: FakeSocket) => void) {}

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    const req: SentReq = JSON.parse(data);
    this.sent.push(req);
    queueMicrotask(() => this.onRequest(req, this));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', null);
  }

  /** Server push (frames are JSON-encoded exactly like the gateway sends them). */
  push(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }

  dropConnection(): void {
    this.close();
  }

  private emit(type: string, data: unknown): void {
    for (const l of this.listeners[type] ?? []) l({ data });
  }
}

function opener(socket: FakeSocket): SocketOpener {
  return async () => socket;
}

// Frames below are trimmed copies of what dewee v3.36.0 sent for a real chat.send.
function connectOk(id: string, role = 'admin') {
  return { type: 'res', id, ok: true, payload: { protocol: 3, role, server: { name: 'dewee', version: 'v3.36.0' }, user_id: 'zuey.user.u1' } };
}

function agentEvent(type: string, payload: Record<string, unknown> | undefined, sessionKey = SESSION, runId = RUN) {
  return {
    type: 'event',
    event: 'agent',
    payload: {
      type,
      agentId: 'zuey-ai',
      runId,
      payload,
      userId: 'zuey.user.u1',
      channel: 'ws',
      sessionKey,
      visibleSessionKey: sessionKey,
      runSessionKey: sessionKey,
      concurrencyDecision: 'normal',
    },
  };
}

/** Happy-path server: handshake, then run.started, thinking, a foreign event, tool events, chunks, completion. */
function happyServer(req: SentReq, s: FakeSocket) {
  if (req.method === 'connect') s.push(connectOk(req.id));
  if (req.method === 'chat.send') {
    s.push(agentEvent('run.started', { message: req.params.message }));
    s.push(agentEvent('thinking', { content: 'The user asks in Vietnamese' }));
    s.push(agentEvent('chunk', { content: 'secret from another user' }, 'agent:zuey-ai:ws:direct:zuey.u.u2.c.c9', 'other-run'));
    s.push({ type: 'event', event: 'trace.status', payload: { status: 'running' } });
    s.push(agentEvent('tool.call', { name: 'datetime', id: 'call_1', arguments: { tz: 'Asia/Saigon' } }));
    s.push(agentEvent('tool.result', { name: 'datetime', id: 'call_1', is_error: false, result: '2026-10-02T00:04:52+07:00' }));
    s.push(agentEvent('chunk', { content: 'Mình là Zuey AI' }));
    s.push(agentEvent('chunk', { content: ' — trợ lý trên zuey.me.' }));
    s.push(agentEvent('run.completed', { content: 'Mình là Zuey AI — trợ lý trên zuey.me.', thinking: 'hidden' }));
    s.push({
      type: 'res',
      id: req.id,
      ok: true,
      payload: {
        runId: RUN,
        content: 'Mình là Zuey AI — trợ lý trên zuey.me.',
        usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 },
        concurrencyDecision: 'normal',
        isolated: false,
        runSessionKey: SESSION,
        visibleSessionKey: SESSION,
      },
    });
  }
}

async function collect(iter: AsyncIterable<DeweeChatEvent>): Promise<DeweeChatEvent[]> {
  const out: DeweeChatEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function expectAppError(fn: () => unknown, status: number, code: string): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    if (!(err instanceof AppError)) throw err;
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error('expected AppError');
}

describe('resolveDeweeConfig', () => {
  it('returns 503 ai_unconfigured listing every missing env name', () => {
    const err = expectAppError(() => resolveDeweeConfig({}), 503, 'ai_unconfigured');
    expect(err.extra.missing).toEqual(['DEWEE_GATEWAY_URL', 'DEWEE_GATEWAY_TOKEN']);
    expect(err.message).not.toContain('undefined');
    expectAppError(() => resolveDeweeConfig(undefined), 503, 'ai_unconfigured');
  });

  it('rejects invalid URLs and agent keys without echoing secret values', () => {
    const err = expectAppError(
      () => resolveDeweeConfig({ DEWEE_GATEWAY_URL: 'ftp://x', DEWEE_GATEWAY_TOKEN: 'tok-secret' }),
      503,
      'ai_unconfigured',
    );
    expect(err.message).not.toContain('tok-secret');
    expectAppError(() => resolveDeweeConfig({ DEWEE_GATEWAY_URL: 'not a url', DEWEE_GATEWAY_TOKEN: 't' }), 503, 'ai_unconfigured');
    expectAppError(
      () => resolveDeweeConfig({ DEWEE_GATEWAY_URL: 'https://g.test', DEWEE_GATEWAY_TOKEN: 't', DEWEE_AGENT_KEY: 'Bad Key' }),
      503,
      'ai_unconfigured',
    );
  });

  it('defaults the agent key and normalises the URL', () => {
    expect(resolveDeweeConfig({ DEWEE_GATEWAY_URL: 'https://g.test/', DEWEE_GATEWAY_TOKEN: ' t ' })).toEqual({
      gatewayUrl: 'https://g.test',
      token: 't',
      agentKey: 'zuey-ai',
    });
    expect(resolveDeweeConfig({ DEWEE_GATEWAY_URL: 'https://g.test', DEWEE_GATEWAY_TOKEN: 't', DEWEE_AGENT_KEY: 'other-agent' }).agentKey).toBe(
      'other-agent',
    );
  });
});

describe('session isolation', () => {
  it('embeds the user id so users never share a gateway session', () => {
    expect(buildSessionKey('zuey-ai', 'u1', 'c1')).toBe('agent:zuey-ai:ws:direct:zuey.u.u1.c.c1');
    expect(buildSessionKey('zuey-ai', 'u2', 'c1')).not.toBe(buildSessionKey('zuey-ai', 'u1', 'c1'));
    // Hyphenated ids cannot be re-split into a different (user, chat) pair.
    expect(buildSessionKey('zuey-ai', 'a-b', 'c')).not.toBe(buildSessionKey('zuey-ai', 'a', 'b-c'));
    expect(gatewayUserId('u1')).toBe('zuey.user.u1');
  });

  it('rejects ids that could inject separators', () => {
    expectAppError(() => buildSessionKey('zuey-ai', 'u1:evil', 'c1'), 400, 'invalid_request');
    expectAppError(() => buildSessionKey('zuey-ai', 'u1', 'c.1'), 400, 'invalid_request');
    expectAppError(() => buildSessionKey('zuey-ai', '', 'c1'), 400, 'invalid_request');
  });

  it('validates the message before opening a connection', () => {
    let opened = false;
    const openSocket: SocketOpener = async () => {
      opened = true;
      throw new Error('unreachable');
    };
    expectAppError(() => streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: '   ', openSocket }), 400, 'invalid_request');
    expectAppError(
      () => streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'x'.repeat(32001), openSocket }),
      400,
      'invalid_request',
    );
    expect(opened).toBe(false);
  });
});

describe('streamChat', () => {
  it('streams deltas and tool events for this session only, then done', async () => {
    const socket = new FakeSocket(happyServer);
    let openedUrl = '';
    const events = await collect(
      streamChat(config, {
        userId: 'u1',
        chatSessionId: 'c1',
        message: 'Xin chào',
        openSocket: async (url) => {
          openedUrl = url;
          return socket;
        },
      }),
    );

    expect(openedUrl).toBe('https://gateway.test/ws');
    expect(socket.sent[0]).toMatchObject({ method: 'connect', params: { token: 'test-token', user_id: 'zuey.user.u1' } });
    expect(socket.sent[1]).toMatchObject({
      method: 'chat.send',
      params: { agentId: 'zuey-ai', sessionKey: SESSION, message: 'Xin chào', stream: true },
    });
    expect(events).toEqual([
      { type: 'tool', phase: 'call', name: 'datetime', id: 'call_1', isError: false },
      { type: 'tool', phase: 'result', name: 'datetime', id: 'call_1', isError: false },
      { type: 'delta', text: 'Mình là Zuey AI' },
      { type: 'delta', text: ' — trợ lý trên zuey.me.' },
      {
        type: 'done',
        runId: RUN,
        content: 'Mình là Zuey AI — trợ lý trên zuey.me.',
        cancelled: false,
        usage: { promptTokens: 1200, completionTokens: 40, totalTokens: 1240 },
      },
    ]);
    // Reasoning and other users' content never leak into the stream.
    expect(JSON.stringify(events)).not.toContain('another user');
    expect(JSON.stringify(events)).not.toContain('Vietnamese');
    expect(socket.closed).toBe(true);
  });

  it('aborting the signal sends chat.abort for the run and ends with a cancelled done', async () => {
    const controller = new AbortController();
    const socket = new FakeSocket((req, s) => {
      if (req.method === 'connect') s.push(connectOk(req.id));
      if (req.method === 'chat.send') {
        s.push(agentEvent('run.started', {}));
        s.push(agentEvent('chunk', { content: 'Sài Gòn' }));
      }
      if (req.method === 'chat.abort') {
        s.push(agentEvent('run.cancelled', undefined));
        const send = s.sent.find((r) => r.method === 'chat.send');
        s.push({ type: 'res', id: send?.id, ok: true, payload: { cancelled: true } });
        s.push({ type: 'res', id: req.id, ok: true, payload: { aborted: true, runIds: [RUN] } });
      }
    });
    const events: DeweeChatEvent[] = [];
    for await (const e of streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'poem', signal: controller.signal, openSocket: opener(socket) })) {
      events.push(e);
      if (e.type === 'delta') controller.abort();
    }
    expect(socket.sent.find((r) => r.method === 'chat.abort')?.params).toEqual({ sessionKey: SESSION, runId: RUN });
    expect(events.at(-1)).toEqual({ type: 'done', runId: RUN, content: 'Sài Gòn', cancelled: true, usage: null });
    expect(socket.closed).toBe(true);
  });

  it('breaking out of the loop aborts the gateway run', async () => {
    const socket = new FakeSocket((req, s) => {
      if (req.method === 'connect') s.push(connectOk(req.id));
      if (req.method === 'chat.send') {
        s.push(agentEvent('run.started', {}));
        s.push(agentEvent('chunk', { content: 'a' }));
      }
      if (req.method === 'chat.abort') s.push({ type: 'res', id: req.id, ok: true, payload: { aborted: true } });
    });
    for await (const e of streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'hi', openSocket: opener(socket) })) {
      if (e.type === 'delta') break;
    }
    expect(socket.sent.map((r) => r.method)).toEqual(['connect', 'chat.send', 'chat.abort']);
    expect(socket.closed).toBe(true);
  });

  it('an already-aborted signal never opens a socket', async () => {
    const controller = new AbortController();
    controller.abort();
    let opened = false;
    const events = await collect(
      streamChat(config, {
        userId: 'u1',
        chatSessionId: 'c1',
        message: 'hi',
        signal: controller.signal,
        openSocket: async () => {
          opened = true;
          return new FakeSocket(() => {});
        },
      }),
    );
    expect(opened).toBe(false);
    expect(events).toEqual([{ type: 'done', runId: null, content: '', cancelled: true, usage: null }]);
  });

  it('reports ai_auth_failed when the token only grants viewer access', async () => {
    const socket = new FakeSocket((req, s) => {
      if (req.method === 'connect') s.push(connectOk(req.id, 'viewer'));
    });
    const events = await collect(streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'hi', openSocket: opener(socket) }));
    expect(events).toEqual([{ type: 'error', code: 'ai_auth_failed', message: 'AI gateway rejected the credentials', retryable: false }]);
    expect(socket.sent.map((r) => r.method)).toEqual(['connect']);
  });

  it('maps a failed chat.send response to a structured error without leaking gateway text', async () => {
    const socket = new FakeSocket((req, s) => {
      if (req.method === 'connect') s.push(connectOk(req.id));
      if (req.method === 'chat.send') {
        s.push({ type: 'res', id: req.id, ok: false, error: { code: 'INTERNAL', message: 'provider opencode-zuey: 500 upstream key invalid' } });
      }
    });
    const events = await collect(streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'hi', openSocket: opener(socket) }));
    expect(events).toEqual([{ type: 'error', code: 'ai_run_failed', message: 'The AI could not answer this message', retryable: false }]);
    expect(JSON.stringify(events)).not.toContain('upstream');
  });

  it('treats the gateway rate limit as a retryable rejection', async () => {
    const socket = new FakeSocket((req, s) => {
      if (req.method === 'connect') s.push(connectOk(req.id));
      if (req.method === 'chat.send') s.push({ type: 'res', id: req.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'Rate limit exceeded' } });
    });
    const [event] = await collect(streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'hi', openSocket: opener(socket) }));
    expect(event).toEqual({ type: 'error', code: 'ai_rejected', message: 'The AI could not answer this message', retryable: true });
  });

  it('ends with ai_run_failed on a run.failed event', async () => {
    const socket = new FakeSocket((req, s) => {
      if (req.method === 'connect') s.push(connectOk(req.id));
      if (req.method === 'chat.send') {
        s.push(agentEvent('run.started', {}));
        s.push(agentEvent('run.failed', { error: 'context deadline exceeded', recovery_action: 'retry' }));
      }
    });
    const events = await collect(streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'hi', openSocket: opener(socket) }));
    expect(events).toEqual([{ type: 'error', code: 'ai_run_failed', message: 'The AI could not finish the reply', retryable: true }]);
  });

  it('times out an idle run, aborts it, and reports ai_timeout', async () => {
    const socket = new FakeSocket((req, s) => {
      if (req.method === 'connect') s.push(connectOk(req.id));
      if (req.method === 'chat.send') s.push(agentEvent('run.started', {}));
    });
    const events = await collect(
      streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'hi', idleTimeoutMs: 30, openSocket: opener(socket) }),
    );
    expect(events).toEqual([{ type: 'error', code: 'ai_timeout', message: 'AI response timed out', retryable: true }]);
    expect(socket.sent.at(-1)).toMatchObject({ method: 'chat.abort', params: { sessionKey: SESSION, runId: RUN } });
  });

  it('times out a handshake that never answers', async () => {
    const socket = new FakeSocket(() => {});
    const events = await collect(
      streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'hi', connectTimeoutMs: 30, openSocket: opener(socket) }),
    );
    expect(events).toEqual([{ type: 'error', code: 'ai_timeout', message: 'AI gateway did not answer the handshake in time', retryable: true }]);
  });

  it('reports ai_connection_closed when the socket drops mid-reply', async () => {
    const socket = new FakeSocket((req, s) => {
      if (req.method === 'connect') s.push(connectOk(req.id));
      if (req.method === 'chat.send') {
        s.push(agentEvent('run.started', {}));
        s.push(agentEvent('chunk', { content: 'partial' }));
        s.dropConnection();
      }
    });
    const events = await collect(streamChat(config, { userId: 'u1', chatSessionId: 'c1', message: 'hi', openSocket: opener(socket) }));
    expect(events.map((e) => e.type)).toEqual(['delta', 'error']);
    expect(events[1]).toMatchObject({ code: 'ai_connection_closed', retryable: true });
  });

  it('reports ai_unavailable when the socket cannot be opened', async () => {
    const events = await collect(
      streamChat(config, {
        userId: 'u1',
        chatSessionId: 'c1',
        message: 'hi',
        openSocket: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    expect(events).toEqual([{ type: 'error', code: 'ai_unavailable', message: 'Could not connect to the AI gateway', retryable: true }]);
  });
});

describe('openWorkersSocket', () => {
  it('upgrades through fetch and accepts the returned socket', async () => {
    let accepted = false;
    const ws = {
      accept: () => {
        accepted = true;
      },
      send: () => {},
      close: () => {},
      addEventListener: () => {},
    };
    const seen: Array<{ url: string; upgrade: string | null }> = [];
    const fetchImpl: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), upgrade: new Headers(init?.headers).get('Upgrade') });
        // Workers returns status 101 plus a `webSocket` property; the Response constructor rejects 101.
        return Object.defineProperties(new Response(null, { status: 200 }), { status: { value: 101 }, webSocket: { value: ws } });
      },
      { preconnect: () => {} },
    );
    const socket = await openWorkersSocket('https://gateway.test/ws', new AbortController().signal, fetchImpl);
    expect(seen).toEqual([{ url: 'https://gateway.test/ws', upgrade: 'websocket' }]);
    expect(accepted).toBe(true);
    expect(socket).toBe(ws);
  });

  it('throws when the gateway does not upgrade', async () => {
    const fetchImpl: typeof fetch = Object.assign(async () => new Response('nope', { status: 426 }), { preconnect: () => {} });
    const outcome = await openWorkersSocket('https://gateway.test/ws', new AbortController().signal, fetchImpl).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : 'unknown'),
    );
    expect(outcome).toBe('WebSocket upgrade failed with HTTP 426');
  });
});

describe('parseFrame', () => {
  it('ignores malformed frames', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame(42)).toBeNull();
    expect(parseFrame('{"type":"event","event":"health","payload":{}}')).toEqual({ type: 'other' });
  });

  it('decodes binary frames', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'event', event: 'shutdown' }));
    expect(parseFrame(bytes)).toEqual({ type: 'shutdown' });
  });
});
