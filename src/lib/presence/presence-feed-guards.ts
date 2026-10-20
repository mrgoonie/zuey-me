/**
 * Runtime validation of everything the Activity Monitor feed receives over the network. Type guards
 * only (no casts): a malformed payload is dropped, never rendered.
 */
import {
  PRESENCE_CONTRACT_VERSION,
  isActivityCategory,
  type CategoryCount,
  type OwnerPresence,
  type OwnerPublicStatus,
  type PresenceSnapshot,
} from './contract';

const OWNER_STATUSES: readonly string[] = ['online', 'away', 'busy', 'offline'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isOwnerStatus = (v: unknown): v is OwnerPublicStatus => typeof v === 'string' && OWNER_STATUSES.includes(v);

function isCategoryCount(v: unknown): v is CategoryCount {
  return isRecord(v) && isActivityCategory(v.id) && isCount(v.count);
}

function isOwnerPresence(v: unknown): v is OwnerPresence {
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

export interface TicketGrant {
  ticket: string;
  url: string;
}

/** Extracts `{ticket, url}` from the success envelope of POST /api/v1/presence/ticket. */
export function parseTicketGrant(v: unknown): TicketGrant | null {
  if (!isRecord(v) || v.success !== true || !isRecord(v.data)) return null;
  const { ticket, url } = v.data;
  if (typeof ticket !== 'string' || ticket === '' || typeof url !== 'string') return null;
  return url.startsWith('wss://') || url.startsWith('ws://') ? { ticket, url } : null;
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
