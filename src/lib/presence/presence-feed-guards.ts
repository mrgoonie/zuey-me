/**
 * Runtime validation of everything the Activity Monitor feed receives over the network. Type guards
 * only (no casts): a malformed payload is dropped, never rendered.
 */
import {
  PRESENCE_CONTRACT_VERSION,
  PRESENCE_TICKET_PATTERN,
  isActivityCategory,
  type CategoryCount,
  type OwnerPresence,
  type OwnerPublicStatus,
  type PresenceHistory,
  type PresenceHistoryBucket,
  type PresenceSnapshot,
} from './contract';

const OWNER_STATUSES: readonly string[] = ['online', 'away', 'busy', 'offline'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isOwnerStatus = (v: unknown): v is OwnerPublicStatus => typeof v === 'string' && OWNER_STATUSES.includes(v);

function isCategoryCount(v: unknown): v is CategoryCount {
  return isRecord(v) && isActivityCategory(v.id) && isCount(v.count);
}

export function isOwnerPresence(v: unknown): v is OwnerPresence {
  return (
    isRecord(v) &&
    isOwnerStatus(v.status) &&
    typeof v.onSite === 'boolean' &&
    (v.text === undefined || typeof v.text === 'string') &&
    typeof v.since === 'string'
  );
}

export function isPresenceSnapshot(v: unknown): v is PresenceSnapshot {
  return (
    isRecord(v) &&
    v.v === PRESENCE_CONTRACT_VERSION &&
    typeof v.at === 'string' &&
    isCount(v.active) &&
    (v.members === null || isCount(v.members)) &&
    Array.isArray(v.categories) &&
    v.categories.every(isCategoryCount) &&
    isOwnerPresence(v.owner)
  );
}

function isHistoryBucket(v: unknown): v is PresenceHistoryBucket {
  return (
    isRecord(v) &&
    typeof v.t === 'string' &&
    Number.isFinite(Date.parse(v.t)) &&
    isCount(v.peak) &&
    Array.isArray(v.categories) &&
    v.categories.every(isCategoryCount)
  );
}

/** GET /v1/history: 5-minute aggregate buckets (no per-visitor data). */
export function isPresenceHistory(v: unknown): v is PresenceHistory {
  return (
    isRecord(v) &&
    v.v === PRESENCE_CONTRACT_VERSION &&
    typeof v.at === 'string' &&
    Number.isFinite(Date.parse(v.at)) &&
    v.bucketMinutes === 5 &&
    Array.isArray(v.buckets) &&
    v.buckets.every(isHistoryBucket)
  );
}

export interface TicketGrant {
  ticket: string;
  /** WebSocket connect URL (`ws(s)://<host>[/base]/v1/connect`), from the server's runtime config. */
  url: string;
  /** HTTP(S) origin (plus base path) of the same presence Worker, for GET /v1/snapshot. */
  origin: string;
}

const CONNECT_SUFFIX = '/v1/connect';

/**
 * Extracts the grant from the success envelope of POST /api/v1/presence/ticket. The Worker origin comes
 * from the server's runtime `PUBLIC_PRESENCE_URL`, so the feed's snapshot and socket always target the
 * same Worker as the ticket.
 */
export function parseTicketGrant(v: unknown): TicketGrant | null {
  if (!isRecord(v) || v.success !== true || !isRecord(v.data)) return null;
  const { ticket, url } = v.data;
  if (typeof ticket !== 'string' || !PRESENCE_TICKET_PATTERN.test(ticket) || typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') || !parsed.pathname.endsWith(CONNECT_SUFFIX)) return null;
  const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return { ticket, url, origin: `${scheme}//${parsed.host}${parsed.pathname.slice(0, -CONNECT_SUFFIX.length)}` };
}

export type ServerFrame =
  | { t: 'snapshot'; data: PresenceSnapshot }
  | { t: 'error'; code: string };

/** Parses one WebSocket text frame from the Worker; null when it is not a known, valid frame. */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.t === 'snapshot' && isPresenceSnapshot(parsed.data)) return { t: 'snapshot', data: parsed.data };
  if (parsed.t === 'error' && typeof parsed.code === 'string') return { t: 'error', code: parsed.code };
  return null;
}
