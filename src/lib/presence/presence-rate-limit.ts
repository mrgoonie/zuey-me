/**
 * Per-IP fixed-window limiter for presence ticket issuance, held in isolate memory.
 *
 * Why not the D1 `rate_counters` table: tickets are requested on every page load of every consenting
 * visitor, so a D1 limiter would add two queries per page view and one never-purged row per visitor IP.
 *
 * Limits of this design (accepted): counters live per Worker isolate, so a client spread across
 * isolates gets more than the nominal budget, and counters reset when the isolate is evicted. It only
 * blunts ticket farming from one IP; the presence Worker's per-IP and per-key connection caps are the
 * real backstop. Memory is bounded by `maxKeys`.
 */

export const PRESENCE_TICKET_RATE_LIMIT = 30;
export const PRESENCE_TICKET_RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_KEYS = 5_000;

interface WindowCounter {
  start: number;
  count: number;
}

export interface FixedWindowLimiter {
  /** Counts one hit for `key`; returns the seconds until the window resets when over the limit, else null. */
  hit(key: string, now: number): number | null;
  reset(): void;
}

export function createFixedWindowLimiter(limit: number, windowMs: number, maxKeys = MAX_TRACKED_KEYS): FixedWindowLimiter {
  const counters = new Map<string, WindowCounter>();

  const prune = (now: number): void => {
    for (const [key, c] of counters) if (now - c.start >= windowMs) counters.delete(key);
    // Still full of live windows (a flood of distinct IPs): drop the oldest entries (Map keeps insertion order).
    for (const key of counters.keys()) {
      if (counters.size < maxKeys) break;
      counters.delete(key);
    }
  };

  return {
    hit(key, now) {
      let c = counters.get(key);
      if (!c || now - c.start >= windowMs) {
        if (!c && counters.size >= maxKeys) prune(now);
        counters.delete(key);
        c = { start: now, count: 0 };
        counters.set(key, c);
      }
      c.count += 1;
      if (c.count <= limit) return null;
      return Math.max(1, Math.ceil((c.start + windowMs - now) / 1000));
    },
    reset() {
      counters.clear();
    },
  };
}

/** Shared by every ticket request handled by this isolate. */
export const presenceTicketLimiter = createFixedWindowLimiter(PRESENCE_TICKET_RATE_LIMIT, PRESENCE_TICKET_RATE_WINDOW_MS);
