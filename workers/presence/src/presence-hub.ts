/**
 * PresenceHub: the single Durable Object (idFromName('global')) holding every live presence socket.
 *
 * Uses the WebSocket Hibernation API: sockets are accepted with `ctx.acceptWebSocket`, and all per-socket
 * state lives in the socket attachment, so the object can be evicted between messages without losing
 * anyone. In-memory fields below are caches only; the owner's manual setting, the public owner status and
 * the last broadcast signature are persisted in DO storage. `/owner` (GET/PUT) is reachable only through the
 * Worker's authenticated `/internal/owner` route. One DO alarm does three jobs, and is armed only while one of them is pending,
 * so an object holding only idle or silent sockets can sleep:
 *   - TTL sweep: due when the oldest live session would expire (min lastHb + TTL, at least SWEEP_INTERVAL_MS ahead);
 *   - subscriber keepalive: an unchanged snapshot is re-sent to `sub` sockets every KEEPALIVE_INTERVAL_MS,
 *     so a quiet but healthy feed never looks stale;
 *   - coalesced broadcasts (at most one every 2 s).
 */
import {
  PRESENCE_SUBPROTOCOL, PRESENCE_TTL_MS,
  type OwnerStatusState, type PresenceServerMessage, type PresenceSnapshot,
} from '../../../src/lib/presence/contract';
import {
  DEFAULT_OWNER_SETTING, derivePublicOwner, isOwnerSetting, nextOwner, ownerConnected, ownerPresence, parseOwnerStatusUpdate,
  readStoredOwner,
  type OwnerSetting, type StoredOwner,
} from './owner-status';
import {
  CLOSE_OVER_CAPACITY, CLOSE_POLICY, affectsSnapshot, applyClientMessage, computeSnapshot, consumeRate, isLive,
  isSessionIdentity, isSocketSession, newSession, parseClientMessage, shouldClose, snapshotSignature, strike, withinCaps,
  type SessionIdentity, type SocketSession,
} from './presence-state';
import type { DurableObjectStateLike, HubWebSocket, PairWebSocket, PresenceEnv } from './runtime-types';

declare const WebSocketPair: { new (): { 0: PairWebSocket; 1: PairWebSocket } };

/** Header the Worker uses to hand the verified ticket identity to the hub (the hub has no public route). */
export const SESSION_HEADER = 'X-Presence-Session';

export const BROADCAST_MIN_INTERVAL_MS = 2_000;
export const SWEEP_INTERVAL_MS = 15_000;
/** Longest gap between snapshot pushes to a subscriber; under the feed's 60 s staleness threshold. */
export const KEEPALIVE_INTERVAL_MS = 45_000;
/** An alarm that fires this early still counts as due for a keepalive. */
const ALARM_SLACK_MS = 1_000;

const OWNER_KEY = 'owner';
const OWNER_SETTING_KEY = 'ownerSetting';
const SIGNATURE_KEY = 'sig';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const badRequest = (message: string): Response => json({ success: false, error: { code: 'bad_request', message } }, 400);

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
  private ownerSetting: OwnerSetting | undefined;
  private lastSignature: string | null | undefined;
  private lastRefreshAt = 0;
  private refreshPending = false;
  /** Epoch ms of the last snapshot push to subscribers (in memory: after eviction the next alarm simply pushes). */
  private lastPushAt = 0;

  constructor(private readonly ctx: DurableObjectStateLike, _env: PresenceEnv) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      if (pathname === '/connect') return await this.connect(request);
      if (pathname === '/snapshot') return json(await this.current(Date.now()));
      if (pathname === '/owner' && request.method === 'GET') return json(await this.ownerState(Date.now()));
      if (pathname === '/owner' && request.method === 'PUT') return await this.updateOwner(request);
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
    // A fresh socket is neither live nor subscribed, so it arms no alarm until its first `hb` or `sub`.
    this.ctx.acceptWebSocket(server, [`ip:${identity.ipHash}`, `k:${identity.k}`]);
    server.serializeAttachment(newSession(identity, Date.now()));
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
      if (msg.t === 'sub') {
        send(ws, { t: 'snapshot', data: await this.current(now) });
        await this.armNoLaterThan(now + KEEPALIVE_INTERVAL_MS);
      }
      // A session that just became live needs the sweep to notice when it expires.
      if (!isLive(session, now) && isLive(next, now)) await this.armNoLaterThan(Math.max(now + SWEEP_INTERVAL_MS, next.lastHb + PRESENCE_TTL_MS + 1));
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
      const subscribers = this.subscribers();
      const keepalive = subscribers.length > 0 && now - this.lastPushAt >= KEEPALIVE_INTERVAL_MS - ALARM_SLACK_MS;
      await this.refresh(now, undefined, keepalive);
      const next = this.nextAlarm(now, subscribers.length > 0);
      if (next !== null) await this.ctx.storage.setAlarm(next);
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

  /** Sockets that asked for snapshot pushes. */
  private subscribers(exclude?: HubWebSocket): HubWebSocket[] {
    return this.ctx.getWebSockets().filter(ws => ws !== exclude && readSession(ws)?.sub === true);
  }

  /**
   * When the alarm must fire next, or null when nothing needs it: the oldest live session's TTL expiry
   * (at least SWEEP_INTERVAL_MS ahead) and, while subscribers exist, the next keepalive.
   */
  private nextAlarm(now: number, hasSubscribers: boolean): number | null {
    let next: number | null = null;
    let oldestHb = Number.POSITIVE_INFINITY;
    for (const s of this.sessions()) if (isLive(s, now)) oldestHb = Math.min(oldestHb, s.lastHb);
    if (Number.isFinite(oldestHb)) next = Math.max(now + SWEEP_INTERVAL_MS, oldestHb + PRESENCE_TTL_MS + 1);
    if (hasSubscribers) {
      const keepaliveAt = Math.max(now + ALARM_SLACK_MS, this.lastPushAt + KEEPALIVE_INTERVAL_MS);
      next = next === null ? keepaliveAt : Math.min(next, keepaliveAt);
    }
    return next;
  }

  /** Makes sure the alarm fires no later than `at` (an earlier pending alarm recomputes its successor itself). */
  private async armNoLaterThan(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
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

  private async loadOwnerSetting(): Promise<OwnerSetting> {
    if (this.ownerSetting === undefined) {
      const stored = await this.ctx.storage.get(OWNER_SETTING_KEY);
      this.ownerSetting = isOwnerSetting(stored) ? stored : DEFAULT_OWNER_SETTING;
    }
    return this.ownerSetting;
  }

  /**
   * Current public snapshot plus the owner's connection state; persists the public owner when it changed so
   * `since` survives eviction.
   */
  private async evaluate(now: number, exclude?: HubWebSocket): Promise<{ snapshot: PresenceSnapshot; connected: boolean; owner: StoredOwner }> {
    const sessions = this.sessions(exclude);
    if (this.owner === undefined) this.owner = readStoredOwner(await this.ctx.storage.get(OWNER_KEY));
    const setting = await this.loadOwnerSetting();
    const connected = ownerConnected(sessions, now);
    const owner = nextOwner(this.owner, derivePublicOwner(setting, connected), now);
    if (owner !== this.owner) {
      await this.ctx.storage.put(OWNER_KEY, owner);
      this.owner = owner;
    }
    return { snapshot: computeSnapshot(sessions, ownerPresence(owner), now), connected, owner };
  }

  private async current(now: number, exclude?: HubWebSocket): Promise<PresenceSnapshot> {
    return (await this.evaluate(now, exclude)).snapshot;
  }

  /** The owner's private view: manual setting, connection state and the public value. */
  private async ownerState(now: number): Promise<OwnerStatusState> {
    const { connected, owner } = await this.evaluate(now);
    const setting = await this.loadOwnerSetting();
    return {
      mode: setting.mode,
      text: setting.text,
      updatedAt: new Date(setting.updatedAt).toISOString(),
      connected,
      public: ownerPresence(owner),
    };
  }

  /** Stores a new manual setting (re-validated here) and pushes the snapshot when its public part changed. */
  private async updateOwner(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest('Body must be JSON');
    }
    const update = parseOwnerStatusUpdate(body);
    if (!update.ok) return badRequest(update.message);
    const now = Date.now();
    const prev = await this.loadOwnerSetting();
    if (prev.mode !== update.mode || prev.text !== update.text) {
      const next: OwnerSetting = { mode: update.mode, text: update.text, updatedAt: now };
      await this.ctx.storage.put(OWNER_SETTING_KEY, next);
      this.ownerSetting = next;
      // Unchanged public output (e.g. offline <-> invisible) leaves the snapshot signature alone, so nothing is pushed.
      await this.scheduleRefresh(now);
    }
    return json(await this.ownerState(now));
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

  /** Pushes the snapshot to subscribers when its public content changed, or always when `keepalive` is set. */
  private async refresh(now: number, exclude?: HubWebSocket, keepalive = false): Promise<void> {
    this.lastRefreshAt = now;
    const snapshot = await this.current(now, exclude);
    const signature = snapshotSignature(snapshot);
    if (this.lastSignature === undefined) {
      const stored = await this.ctx.storage.get(SIGNATURE_KEY);
      this.lastSignature = typeof stored === 'string' ? stored : null;
    }
    const changed = signature !== this.lastSignature;
    if (!changed && !keepalive) return;
    if (changed) {
      this.lastSignature = signature;
      await this.ctx.storage.put(SIGNATURE_KEY, signature);
    }
    const msg: PresenceServerMessage = { t: 'snapshot', data: snapshot };
    for (const ws of this.subscribers(exclude)) send(ws, msg);
    this.lastPushAt = now;
  }
}

function upgradeResponse(client: PairWebSocket): Response {
  // `webSocket` is a Workers-only ResponseInit field; a typed variable avoids widening ResponseInit globally.
  // The client offered `[PRESENCE_SUBPROTOCOL, ticket]`; the handshake must select one of them, never the ticket.
  const init: ResponseInit & { webSocket: PairWebSocket } = {
    status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PRESENCE_SUBPROTOCOL },
  };
  return new Response(null, init);
}
