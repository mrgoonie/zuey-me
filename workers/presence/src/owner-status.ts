/**
 * Owner presence for the PresenceHub: the owner's private manual setting (mode + optional text), the
 * verified-connection signal, and the public OwnerPresence derived from both. Pure functions only, so bun
 * tests cover them directly.
 *
 * Privacy invariant: `invisible` and `offline` produce the same public value (status offline, onSite false,
 * no text) and the same `since`, because `since` moves only when the public value itself changes.
 */
import {
  OWNER_STATUS_TEXT_MAX, isOwnerMode,
  type OwnerMode, type OwnerPresence, type OwnerPublicStatus, type OwnerStatusUpdate,
} from '../../../src/lib/presence/contract';
import { isLive, type SocketSession } from './presence-state';

/** The owner's manual setting as persisted in DO storage. */
export interface OwnerSetting {
  mode: OwnerMode;
  /** Sanitized status text, null when none. */
  text: string | null;
  /** Epoch ms the setting last changed; 0 = never set (the default `auto`). */
  updatedAt: number;
}

export const DEFAULT_OWNER_SETTING: OwnerSetting = { mode: 'auto', text: null, updatedAt: 0 };

export function isOwnerSetting(v: unknown): v is OwnerSetting {
  if (typeof v !== 'object' || v === null) return false;
  return 'mode' in v && isOwnerMode(v.mode)
    && 'text' in v && (v.text === null || (typeof v.text === 'string' && v.text.length <= OWNER_STATUS_TEXT_MAX))
    && 'updatedAt' in v && typeof v.updatedAt === 'number';
}

/** The public owner value without its timestamp; what `since` tracks. */
export interface PublicOwnerValue {
  status: OwnerPublicStatus;
  onSite: boolean;
  /** Only ever non-null when status is not offline. */
  text: string | null;
}

/** Public owner state persisted in DO storage so `since` survives eviction. */
export interface StoredOwner extends PublicOwnerValue {
  since: number;
}

const PUBLIC_STATUSES: readonly OwnerPublicStatus[] = ['online', 'away', 'busy', 'offline'];
const isPublicStatus = (v: unknown): v is OwnerPublicStatus =>
  typeof v === 'string' && (PUBLIC_STATUSES as readonly string[]).includes(v);

/**
 * Reads the stored public owner. Also accepts the earlier `{status: 'online'|'offline', since}` shape so an
 * upgraded object keeps its `since`. Anything else is null (the next evaluation starts a fresh `since`).
 */
export function readStoredOwner(v: unknown): StoredOwner | null {
  if (typeof v !== 'object' || v === null) return null;
  if (!('status' in v) || !isPublicStatus(v.status) || !('since' in v) || typeof v.since !== 'number') return null;
  const status = v.status;
  const since = v.since;
  if (!('onSite' in v) && !('text' in v)) {
    if (status !== 'online' && status !== 'offline') return null;
    return { status, onSite: status === 'online', text: null, since };
  }
  if (!('onSite' in v) || typeof v.onSite !== 'boolean') return null;
  if (!('text' in v) || (v.text !== null && typeof v.text !== 'string')) return null;
  return { status, onSite: v.onSite, text: v.text, since };
}

/**
 * True while the verified owner has a live, counted connection: an owner ticket (o) with counting consent (c)
 * that heartbeated within the TTL and has not gone idle. Owner sockets never count as visitors.
 */
export function ownerConnected(sessions: readonly SocketSession[], now: number): boolean {
  return sessions.some((s) => s.o && s.c && isLive(s, now));
}

/** Public value for a setting and connection state. */
export function derivePublicOwner(setting: OwnerSetting, connected: boolean): PublicOwnerValue {
  let status: OwnerPublicStatus;
  let onSite: boolean;
  switch (setting.mode) {
    case 'auto':
      status = connected ? 'online' : 'offline';
      onSite = connected;
      break;
    case 'away':
    case 'busy':
      status = setting.mode;
      onSite = connected;
      break;
    case 'offline':
    case 'invisible':
      status = 'offline';
      onSite = false;
      break;
  }
  const text = status !== 'offline' && setting.text ? setting.text : null;
  return { status, onSite, text };
}

/** Next stored owner; `since` moves only when the public {status, onSite, text} changes (first observation starts it). */
export function nextOwner(prev: StoredOwner | null, value: PublicOwnerValue, now: number): StoredOwner {
  if (prev && prev.status === value.status && prev.onSite === value.onSite && prev.text === value.text) return prev;
  return { ...value, since: now };
}

/** The published OwnerPresence; `text` is present only when set and the owner is not offline. */
export function ownerPresence(owner: StoredOwner): OwnerPresence {
  const out: OwnerPresence = { status: owner.status, onSite: owner.onSite, since: new Date(owner.since).toISOString() };
  if (owner.status !== 'offline' && owner.text) out.text = owner.text;
  return out;
}

/** Line breaks and tabs become spaces; other C0/C1 controls and bidi embedding/override/isolate marks are dropped. */
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const CONTROL_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/** Sanitized status text: controls stripped, trimmed; null when empty. */
export function sanitizeOwnerText(raw: string): string | null {
  const text = raw.replace(LINE_BREAKS, ' ').replace(CONTROL_CHARS, '').trim();
  return text.length > 0 ? text : null;
}

export type OwnerUpdateResult =
  | { ok: true; mode: OwnerMode; text: string | null }
  | { ok: false; message: string };

/** Validates an untrusted OwnerStatusUpdate body (already JSON-parsed). */
export function parseOwnerStatusUpdate(body: unknown): OwnerUpdateResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, message: 'Expected a JSON object' };
  if (!('mode' in body) || !isOwnerMode(body.mode)) return { ok: false, message: 'mode must be one of auto, away, busy, offline, invisible' };
  const mode = body.mode;
  if (!('text' in body) || body.text === undefined) return { ok: true, mode, text: null };
  if (typeof body.text !== 'string') return { ok: false, message: 'text must be a string' };
  const text = sanitizeOwnerText(body.text);
  if (text !== null && text.length > OWNER_STATUS_TEXT_MAX) {
    return { ok: false, message: `text must be at most ${OWNER_STATUS_TEXT_MAX} characters` };
  }
  return { ok: true, mode, text };
}

/** The wire form of a validated update, forwarded from the Worker to the hub. */
export function toOwnerStatusUpdate(mode: OwnerMode, text: string | null): OwnerStatusUpdate {
  return text === null ? { mode } : { mode, text };
}
