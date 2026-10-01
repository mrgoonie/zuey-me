import { addDays, getZonedParts, parseTimeOfDay, zonedTimeToUtc } from './timezone';

export const SLOT_HORIZON_DAYS = 60;
export const MIN_LEAD_MS = 24 * 60 * 60 * 1000;
export const HOLD_MS = 15 * 60 * 1000;
export const RESCHEDULE_MIN_NOTICE_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_SLOT_MINUTES = 90;

export interface AvailabilityRule {
  id?: number;
  weekday: number;
  start_time: string;
  end_time: string;
  timezone: string;
  slot_minutes: number;
}

export interface AvailabilityException {
  id?: number;
  start_at: string;
  end_at: string;
  reason?: string | null;
}

export interface Slot {
  start: string;
  end: string;
  duration_min: number;
}

export interface SlotQuery {
  rules: AvailabilityRule[];
  exceptions: AvailabilityException[];
  /** UTC ISO start instants already occupied by active bookings. */
  taken: Set<string>;
  now: number;
  from?: number;
  days?: number;
  minLeadMs?: number;
}

/** Generates bookable slots (UTC ISO) from weekday rules, minus exceptions, taken slots and lead time. */
export function generateSlots(q: SlotQuery): Slot[] {
  const from = Math.max(q.from ?? q.now, q.now);
  const days = Math.min(Math.max(Math.floor(q.days ?? SLOT_HORIZON_DAYS), 1), SLOT_HORIZON_DAYS);
  const earliest = Math.max(from, q.now + (q.minLeadMs ?? MIN_LEAD_MS));
  const horizonEnd = q.now + SLOT_HORIZON_DAYS * 86_400_000;
  const windowEnd = Math.min(from + days * 86_400_000, horizonEnd);
  const blocked = q.exceptions.map(e => [Date.parse(e.start_at), Date.parse(e.end_at)] as const);
  const seen = new Map<string, Slot>();

  for (const rule of q.rules) {
    const startMin = parseTimeOfDay(rule.start_time);
    const endMin = parseTimeOfDay(rule.end_time);
    const duration = rule.slot_minutes;
    if (startMin === null || endMin === null || endMin <= startMin || duration <= 0) continue;
    const localToday = getZonedParts(from, rule.timezone);
    // One extra day each side covers offsets that move the local date across the UTC window.
    for (let i = -1; i <= days + 1; i++) {
      const date = addDays(localToday.year, localToday.month, localToday.day, i);
      const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
      if (weekday !== rule.weekday) continue;
      for (let m = startMin; m + duration <= endMin; m += duration) {
        const startMs = zonedTimeToUtc(date.year, date.month, date.day, Math.floor(m / 60), m % 60, rule.timezone);
        const endMs = startMs + duration * 60_000;
        if (startMs < earliest || startMs >= windowEnd) continue;
        if (blocked.some(([bs, be]) => startMs < be && endMs > bs)) continue;
        const start = new Date(startMs).toISOString();
        if (q.taken.has(start) || seen.has(start)) continue;
        seen.set(start, { start, end: new Date(endMs).toISOString(), duration_min: duration });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.start.localeCompare(b.start));
}
