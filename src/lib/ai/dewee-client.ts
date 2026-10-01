/**
 * Edge-compatible client for the Dewee (GoClaw) gateway that powers Zuey AI.
 *
 * Transport: the gateway only streams tokens over its WebSocket RPC (protocol v3).
 * Its HTTP endpoints (`/v1/chat/completions`, `/v1/responses`) emit the whole
 * answer as one final SSE chunk, so they cannot drive a live chat UI.
 *
 * - On Cloudflare Workers/Pages the socket is opened with `fetch(httpsUrl, { headers: { Upgrade: 'websocket' } })`
 *   and `response.webSocket.accept()` (the Workers WebSocket client API).
 * - Elsewhere (Node 22+, Bun, local dev) the standard `WebSocket` constructor is used.
 *
 * Protocol (observed against dewee v3.36.0):
 *   -> {type:'req', id, method:'connect', params:{token, user_id}}
 *   <- {type:'res', id, ok:true, payload:{protocol:3, role:'admin'|'operator'|'viewer', ...}}
 *   -> {type:'req', id, method:'chat.send', params:{agentId, sessionKey, message, stream:true}}
 *   <- {type:'event', event:'agent', payload:{type:'run.started'|'thinking'|'chunk'|'tool.call'|'tool.result'
 *        |'run.completed'|'run.failed'|'run.cancelled', runId, sessionKey, visibleSessionKey, payload:{...}}}
 *   <- {type:'res', id, ok:true, payload:{runId, content, usage, ...}}  (or {cancelled:true} after chat.abort)
 *   -> {type:'req', id, method:'chat.abort', params:{sessionKey, runId}}
 *
 * The gateway token grants an admin-role socket that receives agent events for every
 * session in the tenant, so events are filtered by our session key and run id.
 * Per-user isolation lives in the session key, which embeds the zuey user id.
 */
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';

export const DEWEE_ENV_NAMES = ['DEWEE_GATEWAY_URL', 'DEWEE_GATEWAY_TOKEN', 'DEWEE_AGENT_KEY'] as const;
export const DEFAULT_AGENT_KEY = 'zuey-ai';
/** Matches the gateway's default `gateway.max_message_chars`. */
export const MAX_MESSAGE_CHARS = 32000;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
const ABORT_ACK_TIMEOUT_MS = 2_000;

export interface DeweeConfig {
  /** Gateway base URL (http/https), e.g. https://dewee.example.com */
  gatewayUrl: string;
  token: string;
  agentKey: string;
}

export type DeweeChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; phase: 'call' | 'result'; name: string; id: string; isError: boolean }
  | { type: 'done'; runId: string | null; content: string; cancelled: boolean; usage: DeweeUsage | null }
  | { type: 'error'; code: DeweeErrorCode; message: string; retryable: boolean };

export type DeweeErrorCode =
  | 'ai_unavailable'
  | 'ai_auth_failed'
  | 'ai_rejected'
  | 'ai_run_failed'
  | 'ai_timeout'
  | 'ai_connection_closed';

export interface DeweeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Minimal socket surface shared by the Workers WebSocket and the standard WebSocket. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

export type SocketOpener = (httpUrl: string, signal: AbortSignal) => Promise<GatewaySocket>;

export interface StreamChatOptions {
  /** Authenticated zuey.me user id. */
  userId: string;
  /** zuey.me chat session id owned by that user. */
  chatSessionId: string;
  message: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  /** Max silence between frames for this run before giving up. */
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Injectable transport (tests, custom runtimes). Defaults to {@link openGatewaySocket}. */
  openSocket?: SocketOpener;
}

/** Reads and validates the Dewee settings; throws 503 `ai_unconfigured` naming the missing env vars. */
export function resolveDeweeConfig(env: RuntimeEnv | undefined): DeweeConfig {
  const gatewayUrl = env?.DEWEE_GATEWAY_URL?.trim() ?? '';
  const token = env?.DEWEE_GATEWAY_TOKEN?.trim() ?? '';
  const agentKey = env?.DEWEE_AGENT_KEY?.trim() || DEFAULT_AGENT_KEY;
  const missing: string[] = [];
  if (!gatewayUrl) missing.push('DEWEE_GATEWAY_URL');
  if (!token) missing.push('DEWEE_GATEWAY_TOKEN');
  if (missing.length > 0) {
    throw new AppError(503, 'ai_unconfigured', `Zuey AI is not configured: missing ${missing.join(', ')}`, { missing });
  }
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    throw new AppError(503, 'ai_unconfigured', 'Zuey AI is not configured: DEWEE_GATEWAY_URL is not a valid URL', { invalid: ['DEWEE_GATEWAY_URL'] });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError(503, 'ai_unconfigured', 'Zuey AI is not configured: DEWEE_GATEWAY_URL must be http(s)', { invalid: ['DEWEE_GATEWAY_URL'] });
  }
  if (!AGENT_KEY_PATTERN.test(agentKey)) {
    throw new AppError(503, 'ai_unconfigured', 'Zuey AI is not configured: DEWEE_AGENT_KEY is not a valid agent key', { invalid: ['DEWEE_AGENT_KEY'] });
  }
  return { gatewayUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ''), token, agentKey };
}

function assertId(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_request', `${field} must be 1-128 characters of A-Z, a-z, 0-9, _ or -`, { field });
  }
}

/**
 * Gateway session key for one zuey chat session. The user id is embedded so two users
 * can never address the same gateway session; '.' separators cannot appear in ids,
 * so different (user, chat) pairs never collide.
 */
export function buildSessionKey(agentKey: string, userId: string, chatSessionId: string): string {
  assertId(userId, 'userId');
  assertId(chatSessionId, 'chatSessionId');
  return `agent:${agentKey}:ws:direct:zuey.u.${userId}.c.${chatSessionId}`;
}

/** Gateway-side user identity; scopes per-user context files and run attribution. */
export function gatewayUserId(userId: string): string {
  assertId(userId, 'userId');
  return `zuey.user.${userId}`;
}

function wsEndpoint(gatewayUrl: string): string {
  return `${gatewayUrl}/ws`;
}

function isWorkersRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

interface AcceptableSocket extends GatewaySocket {
  accept(): void;
}

function isAcceptableSocket(value: unknown): value is AcceptableSocket {
  return (
    typeof value === 'object' &&
    value !== null &&
    'accept' in value &&
    typeof value.accept === 'function' &&
    'send' in value &&
    typeof value.send === 'function' &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function'
  );
}

/** Workers WebSocket client: HTTP upgrade through fetch, then accept() the returned socket. */
export async function openWorkersSocket(
  httpUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewaySocket> {
  const res = await fetchImpl(httpUrl, { headers: { Upgrade: 'websocket' }, signal });
  const socket: unknown = 'webSocket' in res ? res.webSocket : null;
  if (res.status !== 101 || !isAcceptableSocket(socket)) {
    throw new Error(`WebSocket upgrade failed with HTTP ${res.status}`);
  }
  socket.accept();
  return socket;
}

/** Standard WebSocket client (Node 22+, Bun, browsers). Resolves once the socket is open. */
export function openStandardSocket(httpUrl: string, signal: AbortSignal): Promise<GatewaySocket> {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') {
      reject(new Error('No WebSocket client available in this runtime'));
      return;
    }
    const ws = new WebSocket(httpUrl.replace(/^http/, 'ws'));
    const onAbort = () => {
      ws.close();
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    ws.addEventListener('open', () => {
      signal.removeEventListener('abort', onAbort);
      resolve(ws);
    }, { once: true });
    ws.addEventListener('error', () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('WebSocket connection failed'));
    }, { once: true });
  });
}

export const openGatewaySocket: SocketOpener = (httpUrl, signal) =>
  isWorkersRuntime() ? openWorkersSocket(httpUrl, signal) : openStandardSocket(httpUrl, signal);

// ---------------------------------------------------------------------------
// Frame parsing

interface ResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload: Record<string, unknown>;
  error: { code: string; message: string; retryable: boolean };
}

interface AgentEventFrame {
  type: 'agent';
  kind: string;
  runId: string;
  sessionKey: string;
  visibleSessionKey: string;
  payload: Record<string, unknown>;
}

type Frame = ResFrame | AgentEventFrame | { type: 'shutdown' } | { type: 'other' };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function decodeData(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

export function parseFrame(raw: unknown): Frame | null {
  const text = decodeData(raw);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const f = asRecord(json);
  if (f.type === 'res') {
    const err = asRecord(f.error);
    return {
      type: 'res',
      id: String(f.id ?? ''),
      ok: f.ok === true,
      payload: asRecord(f.payload),
      error: { code: str(err, 'code'), message: str(err, 'message'), retryable: err.retryable === true },
    };
  }
  if (f.type === 'event') {
    if (f.event === 'shutdown') return { type: 'shutdown' };
    if (f.event !== 'agent') return { type: 'other' };
    const p = asRecord(f.payload);
    return {
      type: 'agent',
      kind: str(p, 'type'),
      runId: str(p, 'runId'),
      sessionKey: str(p, 'sessionKey'),
      visibleSessionKey: str(p, 'visibleSessionKey'),
      payload: asRecord(p.payload),
    };
  }
  return { type: 'other' };
}

function parseUsage(value: unknown): DeweeUsage | null {
  const u = asRecord(value);
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof u[k] === 'number') return Number(u[k]);
    return null;
  };
  const prompt = pick('prompt_tokens', 'promptTokens');
  const completion = pick('completion_tokens', 'completionTokens');
  if (prompt === null || completion === null) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: pick('total_tokens', 'totalTokens') ?? prompt + completion };
}

// ---------------------------------------------------------------------------
// Streaming

type Signal = { kind: 'frame'; frame: Frame } | { kind: 'closed' } | { kind: 'wake' };

/** Single-consumer queue bridging socket callbacks to the async generator. */
class SignalQueue {
  private items: Signal[] = [];
  private waiter: ((s: Signal) => void) | null = null;

  push(s: Signal): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(s);
    } else {
      this.items.push(s);
    }
  }

  next(): Promise<Signal> {
    const s = this.items.shift();
    if (s) return Promise.resolve(s);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

/** Maps gateway RPC error codes (pkg/protocol/errors.go) onto client error codes. */
function mapGatewayError(error: ResFrame['error']): { code: DeweeErrorCode; retryable: boolean } {
  switch (error.code) {
    case 'INTERNAL':
      return { code: 'ai_run_failed', retryable: error.retryable };
    case 'AGENT_TIMEOUT':
      return { code: 'ai_run_failed', retryable: true };
    case 'UNAVAILABLE':
    case 'RESOURCE_EXHAUSTED':
      return { code: 'ai_unavailable', retryable: true };
    case 'UNAUTHORIZED':
      return { code: 'ai_auth_failed', retryable: false };
    default:
      // INVALID_REQUEST also carries the per-user rate limit, which is only identifiable by its message.
      return { code: 'ai_rejected', retryable: error.retryable || /rate limit/i.test(error.message) };
  }
}

function errorEvent(code: DeweeErrorCode, message: string, retryable: boolean): DeweeChatEvent {
  return { type: 'error', code, message, retryable };
}

/**
 * Sends one user message to the agent and yields typed events until the run ends.
 * Input/config problems throw {@link AppError} synchronously; every runtime failure
 * (network, auth, timeout, run error) is delivered as a final `error` event.
 * Aborting `signal`, or breaking out of the loop, aborts the gateway run.
 */
export function streamChat(config: DeweeConfig, options: StreamChatOptions): AsyncGenerator<DeweeChatEvent, void, undefined> {
  const sessionKey = buildSessionKey(config.agentKey, options.userId, options.chatSessionId);
  const userId = gatewayUserId(options.userId);
  const message = options.message.trim();
  if (!message) throw new AppError(400, 'invalid_request', 'message must not be empty', { field: 'message' });
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new AppError(400, 'invalid_request', `message must be at most ${MAX_MESSAGE_CHARS} characters`, { field: 'message' });
  }
  return runChat(config, options, sessionKey, userId, message);
}

async function* runChat(
  config: DeweeConfig,
  options: StreamChatOptions,
  sessionKey: string,
  userId: string,
  message: string,
): AsyncGenerator<DeweeChatEvent, void, undefined> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const deadline = Date.now() + (options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const openSocket = options.openSocket ?? openGatewaySocket;
  const callerSignal = options.signal;
  if (callerSignal?.aborted) {
    yield { type: 'done', runId: null, content: '', cancelled: true, usage: null };
    return;
  }

  const queue = new SignalQueue();
  const onCallerAbort = () => queue.push({ kind: 'wake' });
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  // --- open socket
  const openController = new AbortController();
  const openTimer = setTimeout(() => openController.abort(), connectTimeoutMs);
  const relayAbort = () => openController.abort();
  callerSignal?.addEventListener('abort', relayAbort, { once: true });
  let socket: GatewaySocket;
  try {
    socket = await openSocket(wsEndpoint(config.gatewayUrl), openController.signal);
  } catch {
    clearTimeout(openTimer);
    callerSignal?.removeEventListener('abort', relayAbort);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    if (callerSignal?.aborted) {
      yield { type: 'done', runId: null, content: '', cancelled: true, usage: null };
    } else {
      yield errorEvent(
        openController.signal.aborted ? 'ai_timeout' : 'ai_unavailable',
        'Could not connect to the AI gateway',
        true,
      );
    }
    return;
  }
  clearTimeout(openTimer);
  callerSignal?.removeEventListener('abort', relayAbort);

  let closed = false;
  socket.addEventListener('message', (event) => {
    const frame = parseFrame(event.data);
    if (frame) queue.push({ kind: 'frame', frame });
  });
  socket.addEventListener('close', () => {
    closed = true;
    queue.push({ kind: 'closed' });
  });
  socket.addEventListener('error', () => queue.push({ kind: 'closed' }));

  let reqSeq = 0;
  const send = (method: string, params: Record<string, unknown>): string | null => {
    const id = `z${++reqSeq}`;
    try {
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
      return id;
    } catch {
      return null;
    }
  };

  /** Waits for the next frame, a close, the caller abort, or the given deadline. */
  const nextSignal = async (until: number): Promise<Signal | 'timeout'> => {
    const remaining = Math.max(0, Math.min(until, deadline) - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), remaining);
    });
    try {
      return await Promise.race([queue.next(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  let runId: string | null = null;
  let sendId: string | null = null;
  let finished = false;
  let content = '';

  const abortRun = async () => {
    if (closed) return;
    const abortId = send('chat.abort', runId ? { sessionKey, runId } : { sessionKey });
    if (!abortId) return;
    const until = Date.now() + ABORT_ACK_TIMEOUT_MS;
    while (Date.now() < until) {
      const s = await nextSignal(until);
      if (s === 'timeout' || s.kind === 'closed') return;
      if (s.kind === 'frame' && s.frame.type === 'res' && (s.frame.id === abortId || s.frame.id === sendId)) return;
    }
  };

  try {
    // --- authenticate
    const connectId = send('connect', { token: config.token, user_id: userId });
    if (!connectId) {
      yield errorEvent('ai_connection_closed', 'AI gateway connection closed', true);
      return;
    }
    const connectUntil = Date.now() + connectTimeoutMs;
    for (;;) {
      if (callerSignal?.aborted) {
        finished = true;
        yield { type: 'done', runId: null, content: '', cancelled: true, usage: null };
        return;
      }
      const s = await nextSignal(connectUntil);
      if (s === 'timeout') {
        finished = true;
        yield errorEvent('ai_timeout', 'AI gateway did not answer the handshake in time', true);
        return;
      }
      if (s.kind === 'closed') {
        finished = true;
        yield errorEvent('ai_connection_closed', 'AI gateway closed the connection during the handshake', true);
        return;
      }
      if (s.kind !== 'frame' || s.frame.type !== 'res' || s.frame.id !== connectId) continue;
      const role = str(s.frame.payload, 'role');
      if (!s.frame.ok || (role !== 'admin' && role !== 'operator' && role !== 'owner')) {
        finished = true;
        yield errorEvent('ai_auth_failed', 'AI gateway rejected the credentials', false);
        return;
      }
      break;
    }

    // --- send the message
    sendId = send('chat.send', { agentId: config.agentKey, sessionKey, message, stream: true });
    if (!sendId) {
      finished = true;
      yield errorEvent('ai_connection_closed', 'AI gateway connection closed', true);
      return;
    }

    let idleUntil = Date.now() + idleTimeoutMs;
    for (;;) {
      if (callerSignal?.aborted) {
        await abortRun();
        finished = true;
        yield { type: 'done', runId, content, cancelled: true, usage: null };
        return;
      }
      const s = await nextSignal(idleUntil);
      if (s === 'timeout') {
        await abortRun();
        finished = true;
        yield errorEvent('ai_timeout', 'AI response timed out', true);
        return;
      }
      if (s.kind === 'wake') continue;
      if (s.kind === 'closed') {
        finished = true;
        yield errorEvent('ai_connection_closed', 'AI gateway closed the connection before the reply finished', true);
        return;
      }
      const frame = s.frame;
      if (frame.type === 'shutdown') {
        finished = true;
        yield errorEvent('ai_unavailable', 'AI gateway is restarting', true);
        return;
      }

      if (frame.type === 'res') {
        if (frame.id !== sendId) continue;
        finished = true;
        if (!frame.ok) {
          const { code, retryable } = mapGatewayError(frame.error);
          yield errorEvent(code, 'The AI could not answer this message', retryable);
          return;
        }
        const cancelled = frame.payload.cancelled === true;
        const finalContent = str(frame.payload, 'content') || content;
        yield {
          type: 'done',
          runId: str(frame.payload, 'runId') || runId,
          content: cancelled ? content : finalContent,
          cancelled,
          usage: parseUsage(frame.payload.usage),
        };
        return;
      }

      if (frame.type !== 'agent') continue;
      // Isolation: the admin socket sees every session's events; keep only this run.
      if (frame.sessionKey !== sessionKey && frame.visibleSessionKey !== sessionKey) continue;
      if (runId === null && frame.kind === 'run.started') runId = frame.runId;
      if (runId !== null && frame.runId !== runId) continue;
      idleUntil = Date.now() + idleTimeoutMs;

      switch (frame.kind) {
        case 'chunk': {
          const text = str(frame.payload, 'content');
          if (text) {
            content += text;
            yield { type: 'delta', text };
          }
          break;
        }
        case 'tool.call':
        case 'tool.result':
          // Only names/ids leave this module; tool arguments and results stay server-side.
          yield {
            type: 'tool',
            phase: frame.kind === 'tool.call' ? 'call' : 'result',
            name: str(frame.payload, 'name'),
            id: str(frame.payload, 'id'),
            isError: frame.payload.is_error === true,
          };
          break;
        case 'run.failed':
          finished = true;
          yield errorEvent('ai_run_failed', 'The AI could not finish the reply', str(frame.payload, 'recovery_action') === 'retry');
          return;
        default:
          // 'thinking' (model reasoning, never shown), 'run.started', 'run.completed',
          // 'activity', 'block.reply': the chat.send response carries the final state.
          break;
      }
    }
  } finally {
    callerSignal?.removeEventListener('abort', onCallerAbort);
    // Consumer stopped early (break/return) while the run was live: stop the gateway run.
    if (!finished && sendId !== null) await abortRun();
    try {
      socket.close(1000, 'done');
    } catch {
      // already closed
    }
  }
}
