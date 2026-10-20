/**
 * PresenceHub: the single Durable Object (idFromName('global')) holding every live presence socket.
 *
 * Uses the WebSocket Hibernation API: sockets are accepted with `ctx.acceptWebSocket`, and all per-socket
 * state lives in the socket attachment, so the object can be evicted between messages without losing
 * anyone. In-memory fields below are caches only; owner status and the last broadcast signature are
 * persisted in DO storage. A DO alarm sweeps heartbeat TTL expiry every 15 s while sockets exist and
 * doubles as the timer for coalesced broadcasts (at most one every 2 s).
 */
import type { PresenceServerMessage, PresenceSnapshot } from '../../../src/lib/presence/contract';
import {
  CLOSE_OVER_CAPACITY, CLOSE_POLICY, affectsSnapshot, applyClientMessage, computeSnapshot, consumeRate, isLive,
  isSessionIdentity, isSocketSession, isStoredOwner, newSession, nextOwner, ownerOnline, parseClientMessage,
  shouldClose, snapshotSignature, strike, withinCaps,
  type SessionIdentity, type SocketSession, type StoredOwner,
} from './presence-state';
import type { DurableObjectStateLike, HubWebSocket, PairWebSocket, PresenceEnv } from './runtime-types';

declare const WebSocketPair: { new (): { 0: PairWebSocket; 1: PairWebSocket } };

/** Header the Worker uses to hand the verified ticket identity to the hub (the hub has no public route). */
export const SESSION_HEADER = 'X-Presence-Session';

export const BROADCAST_MIN_INTERVAL_MS = 2_000;
export const SWEEP_INTERVAL_MS = 15_000;

const OWNER_KEY = 'owner';
const SIGNATURE_KEY = 'sig';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function send(ws: HubWebSocket, msg: PresenceServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // The socket is closing; its close handler cleans up.
  }
}

function closeQuietly(ws: HubWebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

function readSession(ws: HubWebSocket): SocketSession | null {
  try {
    const value = ws.deserializeAttachment();
    return isSocketSession(value) ? value : null;
  } catch {
    return null;
  }
}

export class PresenceHub {
  private owner: StoredOwner | null | undefined;
  private lastSignature: string | null | undefined;
  private lastRefreshAt = 0;
  private refreshPending = false;

  constructor(private readonly ctx: DurableObjectStateLike, _env: PresenceEnv) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      if (pathname === '/connect') return await this.connect(request);
      if (pathname === '/snapshot') return json(await this.current(Date.now()));
      return json({ success: false, error: { code: 'not_found', message: 'Not found' } }, 404);
    } catch (err) {
      console.error('presence hub fetch failed', err instanceof Error ? err.message : 'unknown error');
      return json({ success: false, error: { code: 'unavailable', message: 'Presence is temporarily unavailable' } }, 503);
    }
  }

  /** True when a new socket for this identity fits under the per-IP, per-key and total caps. */
  admits(identity: SessionIdentity): boolean {
    return withinCaps({
      total: this.ctx.getWebSockets().length,
      perIp: this.ctx.getWebSockets(`ip:${identity.ipHash}`).length,
      perKey: this.ctx.getWebSockets(`k:${identity.k}`).length,
    });
  }

  private async connect(request: Request): Promise<Response> {
    let identity: unknown;
    try {
      identity = JSON.parse(request.headers.get(SESSION_HEADER) ?? '');
    } catch {
      identity = null;
    }
    if (!isSessionIdentity(identity)) return json({ success: false, error: { code: 'bad_request', message: 'Bad request' } }, 400);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (!this.admits(identity)) {
      server.accept();
      closeQuietly(server, CLOSE_OVER_CAPACITY, 'over_capacity');
      return upgradeResponse(client);
    }
    const now = Date.now();
    this.ctx.acceptWebSocket(server, [`ip:${identity.ipHash}`, `k:${identity.k}`]);
    server.serializeAttachment(newSession(identity, now));
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    return upgradeResponse(client);
  }

  async webSocketMessage(ws: HubWebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const session = readSession(ws);
      if (!session) {
        closeQuietly(ws, CLOSE_POLICY, 'bad_session');
        return;
      }
      const now = Date.now();
      const decision = consumeRate(session.rate, now);
      if (!decision.allowed) {
        ws.serializeAttachment({ ...session, rate: decision.rate });
        send(ws, { t: 'error', code: 'rate_limited' });
        if (decision.close) closeQuietly(ws, CLOSE_POLICY, 'rate_limited');
        return;
      }
      const msg = parseClientMessage(message);
      if (!msg) {
        const rate = strike(decision.rate, now);
        ws.serializeAttachment({ ...session, rate });
        send(ws, { t: 'error', code: 'bad_message' });
        if (shouldClose(rate)) closeQuietly(ws, CLOSE_POLICY, 'bad_message');
        return;
      }
      const next = applyClientMessage({ ...session, rate: decision.rate }, msg, now);
      ws.serializeAttachment(next);
      if (msg.t === 'sub') send(ws, { t: 'snapshot', data: await this.current(now) });
      if (affectsSnapshot(session, next, now)) await this.scheduleRefresh(now);
    } catch (err) {
      console.error('presence hub message failed', err instanceof Error ? err.message : 'unknown error');
    }
  }

  async webSocketClose(ws: HubWebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Reply with a normal close: the peer's code may be a reserved one (1005/1006) that cannot be sent.
    await this.dropSocket(ws, 1000);
  }

  async webSocketError(ws: HubWebSocket, _error: unknown): Promise<void> {
    await this.dropSocket(ws, 1011);
  }

  async alarm(): Promise<void> {
    try {
      const now = Date.now();
      this.refreshPending = false;
      await this.refresh(now);
      if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    } catch (err) {
      console.error('presence hub alarm failed', err instanceof Error ? err.message : 'unknown error');
      // Keep sweeping; the runtime also retries a failed alarm.
      throw err;
    }
  }

  private async dropSocket(ws: HubWebSocket, code: number): Promise<void> {
    try {
      const session = readSession(ws);
      closeQuietly(ws, code, '');
      const now = Date.now();
      if (session && isLive(session, now)) await this.scheduleRefresh(now, ws);
    } catch (err) {
      console.error('presence hub close failed', err instanceof Error ? err.message : 'unknown error');
    }
  }

  private sessions(exclude?: HubWebSocket): SocketSession[] {
    const out: SocketSession[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const s = readSession(ws);
      if (s) out.push(s);
    }
    return out;
  }

  /** Current public snapshot; persists the owner status when it flipped so `since` survives eviction. */
  private async current(now: number, exclude?: HubWebSocket): Promise<PresenceSnapshot> {
    const sessions = this.sessions(exclude);
    if (this.owner === undefined) {
      const stored = await this.ctx.storage.get(OWNER_KEY);
      this.owner = isStoredOwner(stored) ? stored : null;
    }
    const owner = nextOwner(this.owner, ownerOnline(sessions, now), now);
    if (owner !== this.owner) {
      await this.ctx.storage.put(OWNER_KEY, owner);
      this.owner = owner;
    }
    return computeSnapshot(sessions, owner, now);
  }

  /** Broadcasts now when the last refresh is old enough, else lets an alarm do it within the 2 s window. */
  private async scheduleRefresh(now: number, exclude?: HubWebSocket): Promise<void> {
    if (this.refreshPending) return;
    if (now - this.lastRefreshAt >= BROADCAST_MIN_INTERVAL_MS) {
      await this.refresh(now, exclude);
      return;
    }
    this.refreshPending = true;
    const due = this.lastRefreshAt + BROADCAST_MIN_INTERVAL_MS;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > due) await this.ctx.storage.setAlarm(due);
  }

  /** Pushes the snapshot to subscribers only when its public content changed. */
  private async refresh(now: number, exclude?: HubWebSocket): Promise<void> {
    this.lastRefreshAt = now;
    const snapshot = await this.current(now, exclude);
    const signature = snapshotSignature(snapshot);
    if (this.lastSignature === undefined) {
      const stored = await this.ctx.storage.get(SIGNATURE_KEY);
      this.lastSignature = typeof stored === 'string' ? stored : null;
    }
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    await this.ctx.storage.put(SIGNATURE_KEY, signature);
    const msg: PresenceServerMessage = { t: 'snapshot', data: snapshot };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      if (readSession(ws)?.sub) send(ws, msg);
    }
  }
}

function upgradeResponse(client: PairWebSocket): Response {
  // `webSocket` is a Workers-only ResponseInit field; a typed variable avoids widening ResponseInit globally.
  const init: ResponseInit & { webSocket: PairWebSocket } = { status: 101, webSocket: client };
  return new Response(null, init);
}
