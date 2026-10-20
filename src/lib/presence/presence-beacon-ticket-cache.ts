/**
 * Ticket handling for the presence beacon: validation of the ticket endpoint's answer and a per-tab
 * sessionStorage cache, so page loads and reconnects reuse one ticket instead of asking for a new one
 * each time. A cached ticket is reused only while it has TICKET_REUSE_MARGIN_MS left and was issued for
 * the same counting context (consent granted, counting kind, same browser id). Storage failures are
 * swallowed: without storage the beacon simply asks for a fresh ticket.
 */
import { PRESENCE_TICKET_PATTERN } from './contract';

/** sessionStorage key of the cached counting ticket (per tab, reused across page loads). */
export const PRESENCE_TICKET_STORAGE_KEY = 'zuey_presence_ticket';
/** A cached ticket is reused only while it has at least this long left. */
export const TICKET_REUSE_MARGIN_MS = 15_000;

export type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface TicketData {
  ticket: string;
  url: string;
}

/** Cached ticket plus the context it was issued for. */
export interface CachedTicket extends TicketData {
  /** Local epoch ms the ticket expires (request start + TTL, so client clock skew does not matter). */
  exp: number;
  /** Consent was granted when it was issued. */
  consent: true;
  kind: 'count';
  browserId: string;
}

const isWsUrl = (v: string): boolean => /^wss?:\/\//.test(v);

/** `{ticket, url}` from the success envelope of POST /api/v1/presence/ticket; null when malformed. */
export function parseTicket(body: unknown): TicketData | null {
  if (typeof body !== 'object' || body === null || !('data' in body)) return null;
  const data: unknown = body.data;
  if (typeof data !== 'object' || data === null) return null;
  if (!('ticket' in data) || typeof data.ticket !== 'string' || !('url' in data) || typeof data.url !== 'string') return null;
  if (!isWsUrl(data.url) || !PRESENCE_TICKET_PATTERN.test(data.ticket)) return null;
  return { ticket: data.ticket, url: data.url };
}

export function parseCachedTicket(raw: string | null): CachedTicket | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  if (!('ticket' in v) || typeof v.ticket !== 'string' || !PRESENCE_TICKET_PATTERN.test(v.ticket)) return null;
  if (!('url' in v) || typeof v.url !== 'string' || !isWsUrl(v.url)) return null;
  if (!('exp' in v) || typeof v.exp !== 'number' || !('browserId' in v) || typeof v.browserId !== 'string') return null;
  if (!('consent' in v) || v.consent !== true || !('kind' in v) || v.kind !== 'count') return null;
  return { ticket: v.ticket, url: v.url, exp: v.exp, consent: true, kind: 'count', browserId: v.browserId };
}

export interface TicketCache {
  /** The cached ticket for `browserId` when it still has TICKET_REUSE_MARGIN_MS left, else null. */
  get(browserId: string): CachedTicket | null;
  put(ticket: CachedTicket): void;
  /** Drops the cached ticket (refused socket, consent withdrawn). */
  forget(): void;
}

export function createTicketCache(storage: () => SessionStorageLike | null, now: () => number): TicketCache {
  const store = (): SessionStorageLike | null => {
    try {
      return storage();
    } catch {
      return null;
    }
  };
  return {
    get(browserId) {
      try {
        const cached = parseCachedTicket(store()?.getItem(PRESENCE_TICKET_STORAGE_KEY) ?? null);
        if (!cached || cached.browserId !== browserId || now() >= cached.exp - TICKET_REUSE_MARGIN_MS) return null;
        return cached;
      } catch {
        return null;
      }
    },
    put(ticket) {
      try {
        store()?.setItem(PRESENCE_TICKET_STORAGE_KEY, JSON.stringify(ticket));
      } catch {
        // Not cached: the next page load simply asks for a fresh ticket.
      }
    },
    forget() {
      try {
        store()?.removeItem(PRESENCE_TICKET_STORAGE_KEY);
      } catch {
        // Nothing cached, or storage unavailable.
      }
    },
  };
}
