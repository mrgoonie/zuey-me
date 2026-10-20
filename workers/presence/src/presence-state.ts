/**
 * Pure presence logic for the PresenceHub Durable Object: per-socket session state, client message
 * parsing, per-socket rate limiting, connection caps and snapshot aggregation with small-group
 * suppression. No Cloudflare imports, so bun tests cover it directly.
 */
import {
  ACTIVITY_CATEGORIES, PRESENCE_CONTRACT_VERSION, PRESENCE_MAX_MESSAGE_BYTES, PRESENCE_MIN_GROUP, PRESENCE_TTL_MS,
  isActivityCategory,
  type ActivityCategory, type CategoryCount, type OwnerPresence, type PresenceClientMessage, type PresenceSnapshot,
} from '../../../src/lib/presence/contract';

/** Live connection caps; a connection over any of them is closed with code 1013 (try again later). */
export const MAX_SOCKETS_PER_IP = 20;
export const MAX_SOCKETS_PER_KEY = 10;
export const MAX_SOCKETS_TOTAL = 5000;

/**
 * Token bucket per socket: a short burst (connect: `sub` + first `hb`) then one message per 5 s sustained.
 * Rejected messages count as strikes; too many strikes within the window closes the socket.
 */
export const RATE_BURST = 4;
export const RATE_REFILL_MS = 5_000;
export const STRIKE_WINDOW_MS = 60_000;
export const MAX_STRIKES = 10;

/** Close codes sent by the hub. */
export const CLOSE_OVER_CAPACITY = 1013;
export const CLOSE_POLICY = 1008;

export interface RateState {
  /** Available tokens (fractional while refilling). */
  tokens: number;
  /** Epoch ms of the last refill computation. */
  at: number;
  /** Rejected messages in the current strike window. */
  strikes: number;
  /** Epoch ms the current strike window started. */
  strikeAt: number;
}

/**
 * Per-socket state, stored as the WebSocket attachment so it survives hibernation. Never holds a raw
 * IP, user agent, member id or browser id: `k` is already an opaque HMAC and `ipHash` a truncated HMAC.
 */
export interface SocketSession {
  k: string;
  c: boolean;
  m: boolean;
  o: boolean;
  ipHash: string;
  /** Category of the latest accepted heartbeat. */
  cat: ActivityCategory | null;
  /** Epoch ms of the latest accepted heartbeat; 0 = none yet. */
  lastHb: number;
  /** Set by `{t:'idle'}`, cleared by the next heartbeat. */
  idle: boolean;
  /** Receives snapshot pushes. */
  sub: boolean;
  connectedAt: number;
  rate: RateState;
}

export interface SessionIdentity {
  k: string;
  c: boolean;
  m: boolean;
  o: boolean;
  ipHash: string;
}

export function isSessionIdentity(v: unknown): v is SessionIdentity {
  if (typeof v !== 'object' || v === null) return false;
  return 'k' in v && typeof v.k === 'string' && v.k.length > 0 && v.k.length <= 64
    && 'c' in v && typeof v.c === 'boolean'
    && 'm' in v && typeof v.m === 'boolean'
    && 'o' in v && typeof v.o === 'boolean'
    && 'ipHash' in v && typeof v.ipHash === 'string' && v.ipHash.length > 0 && v.ipHash.length <= 64;
}

function isRateState(v: unknown): v is RateState {
  if (typeof v !== 'object' || v === null) return false;
  return 'tokens' in v && typeof v.tokens === 'number'
    && 'at' in v && typeof v.at === 'number'
    && 'strikes' in v && typeof v.strikes === 'number'
    && 'strikeAt' in v && typeof v.strikeAt === 'number';
}

/** Guards attachments read back after hibernation; anything malformed is treated as a dead socket. */
export function isSocketSession(v: unknown): v is SocketSession {
  if (!isSessionIdentity(v)) return false;
  return 'cat' in v && (v.cat === null || isActivityCategory(v.cat))
    && 'lastHb' in v && typeof v.lastHb === 'number'
    && 'idle' in v && typeof v.idle === 'boolean'
    && 'sub' in v && typeof v.sub === 'boolean'
    && 'connectedAt' in v && typeof v.connectedAt === 'number'
    && 'rate' in v && isRateState(v.rate);
}

export function newSession(identity: SessionIdentity, now: number): SocketSession {
  return {
    k: identity.k, c: identity.c, m: identity.m, o: identity.o, ipHash: identity.ipHash,
    cat: null, lastHb: 0, idle: false, sub: false, connectedAt: now,
    rate: { tokens: RATE_BURST, at: now, strikes: 0, strikeAt: now },
  };
}

export interface CapCounts {
  total: number;
  perIp: number;
  perKey: number;
}

/** True when one more socket fits under every cap (counts exclude the new socket). */
export function withinCaps(counts: CapCounts): boolean {
  return counts.total < MAX_SOCKETS_TOTAL && counts.perIp < MAX_SOCKETS_PER_IP && counts.perKey < MAX_SOCKETS_PER_KEY;
}

const encoder = new TextEncoder();

/** Parses one client frame; null for binary, oversize, non-JSON or unknown/invalid messages. */
export function parseClientMessage(raw: string | ArrayBuffer): PresenceClientMessage | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > PRESENCE_MAX_MESSAGE_BYTES || encoder.encode(raw).byteLength > PRESENCE_MAX_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('t' in parsed)) return null;
  switch (parsed.t) {
    case 'hb':
      return 'cat' in parsed && isActivityCategory(parsed.cat) ? { t: 'hb', cat: parsed.cat } : null;
    case 'idle':
      return { t: 'idle' };
    case 'sub':
      return { t: 'sub' };
    case 'unsub':
      return { t: 'unsub' };
    default:
      return null;
  }
}

export interface RateDecision {
  rate: RateState;
  allowed: boolean;
  /** The socket exceeded MAX_STRIKES within the strike window and should be closed. */
  close: boolean;
}

/** Consumes one token for an incoming message. */
export function consumeRate(rate: RateState, now: number): RateDecision {
  const elapsed = Math.max(0, now - rate.at);
  const tokens = Math.min(RATE_BURST, rate.tokens + elapsed / RATE_REFILL_MS);
  if (tokens >= 1) {
    return { rate: { ...rate, tokens: tokens - 1, at: now }, allowed: true, close: false };
  }
  const struck = strike({ ...rate, tokens, at: now }, now);
  return { rate: struck, allowed: false, close: shouldClose(struck) };
}

/** Records one strike (rate-limited or bad message) in the rolling strike window. */
export function strike(rate: RateState, now: number): RateState {
  return now - rate.strikeAt > STRIKE_WINDOW_MS
    ? { ...rate, strikes: 1, strikeAt: now }
    : { ...rate, strikes: rate.strikes + 1 };
}

export function shouldClose(rate: RateState): boolean {
  return rate.strikes >= MAX_STRIKES;
}

/** Applies an accepted client message to the socket session. */
export function applyClientMessage(session: SocketSession, msg: PresenceClientMessage, now: number): SocketSession {
  switch (msg.t) {
    case 'hb':
      return { ...session, cat: msg.cat, lastHb: now, idle: false };
    case 'idle':
      return { ...session, idle: true };
    case 'sub':
      return { ...session, sub: true };
    case 'unsub':
      return { ...session, sub: false };
  }
}

/** A socket is live when it sent a heartbeat within the TTL and has not gone idle since. */
export function isLive(session: SocketSession, now: number): boolean {
  return !session.idle && session.lastHb > 0 && now - session.lastHb <= PRESENCE_TTL_MS;
}

/** Counted toward visitor numbers: live, consented (c) and not the owner. */
export function isCounted(session: SocketSession, now: number): boolean {
  return session.c && !session.o && isLive(session, now);
}

/** True when an update to one socket can change the public snapshot (so a broadcast is worth scheduling). */
export function affectsSnapshot(before: SocketSession, after: SocketSession, now: number): boolean {
  if (isLive(before, now) !== isLive(after, now)) return true;
  return isLive(after, now) && before.cat !== after.cat;
}

/** Owner status persisted in DO storage so `since` survives eviction. Phase 1: online/offline only. */
export interface StoredOwner {
  status: 'online' | 'offline';
  since: number;
}

export function isStoredOwner(v: unknown): v is StoredOwner {
  if (typeof v !== 'object' || v === null) return false;
  return 'status' in v && (v.status === 'online' || v.status === 'offline') && 'since' in v && typeof v.since === 'number';
}

/** Next owner state; `since` moves only when the public status flips (first observation starts it). */
export function nextOwner(prev: StoredOwner | null, online: boolean, now: number): StoredOwner {
  const status = online ? 'online' : 'offline';
  if (prev && prev.status === status) return prev;
  return { status, since: now };
}

export function ownerPresence(owner: StoredOwner): OwnerPresence {
  return { status: owner.status, onSite: owner.status === 'online', since: new Date(owner.since).toISOString() };
}

/** True when any fresh owner socket exists. */
export function ownerOnline(sessions: readonly SocketSession[], now: number): boolean {
  return sessions.some((s) => s.o && isLive(s, now));
}

/**
 * Aggregates sockets into the public snapshot: unique counted keys (multi-tab collapsed), members and
 * a category breakdown where each key contributes its most recent heartbeat category. Groups below
 * PRESENCE_MIN_GROUP fold into `other`; with fewer than PRESENCE_MIN_GROUP active nothing is broken down.
 */
export function computeSnapshot(sessions: readonly SocketSession[], owner: StoredOwner, now: number): PresenceSnapshot {
  const perKey = new Map<string, { cat: ActivityCategory; lastHb: number; m: boolean }>();
  for (const s of sessions) {
    if (!isCounted(s, now) || s.cat === null) continue;
    const prev = perKey.get(s.k);
    if (!prev) perKey.set(s.k, { cat: s.cat, lastHb: s.lastHb, m: s.m });
    else perKey.set(s.k, { cat: s.lastHb >= prev.lastHb ? s.cat : prev.cat, lastHb: Math.max(s.lastHb, prev.lastHb), m: prev.m || s.m });
  }
  const active = perKey.size;
  let memberCount = 0;
  for (const v of perKey.values()) if (v.m) memberCount += 1;
  return {
    v: PRESENCE_CONTRACT_VERSION,
    at: new Date(now).toISOString(),
    active,
    members: memberCount >= PRESENCE_MIN_GROUP ? memberCount : null,
    categories: active >= PRESENCE_MIN_GROUP ? foldCategories([...perKey.values()].map((v) => v.cat)) : [],
    owner: ownerPresence(owner),
  };
}

function foldCategories(cats: readonly ActivityCategory[]): CategoryCount[] {
  const counts = new Map<ActivityCategory, number>();
  for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1);
  let other = counts.get('other') ?? 0;
  const out: CategoryCount[] = [];
  for (const id of ACTIVITY_CATEGORIES) {
    if (id === 'other') continue;
    const count = counts.get(id) ?? 0;
    if (count >= PRESENCE_MIN_GROUP) out.push({ id, count });
    else other += count;
  }
  // Callers only fold when the total is >= PRESENCE_MIN_GROUP, so a small `other` remainder cannot single anyone out on its own.
  if (other > 0) out.push({ id: 'other', count: other });
  return out;
}

/** Stable comparison key for "did the public snapshot change" (ignores the `at` timestamp). */
export function snapshotSignature(s: PresenceSnapshot): string {
  return JSON.stringify([s.active, s.members, s.categories, s.owner]);
}
