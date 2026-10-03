/** Dependency-free time zone math built on Intl.DateTimeFormat (works on the edge and in browsers). */

export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant as seen in `timeZone`. */
export function getZonedParts(ms: number, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return { year: parts.year, month: parts.month, day: parts.day, hour, minute: parts.minute, second: parts.second, weekday };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
export function getTimeZoneOffsetMs(ms: number, timeZone: string): number {
  const p = getZonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `timeZone` to a UTC instant (ms).
 * Handles DST generically: ambiguous times resolve to the earlier offset,
 * non-existent (skipped) times shift forward by the gap.
 */
export function zonedTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetA = getTimeZoneOffsetMs(wall, timeZone);
  const candidateA = wall - offsetA;
  const offsetB = getTimeZoneOffsetMs(candidateA, timeZone);
  const candidateB = wall - offsetB;
  const valid = [candidateA, candidateB].filter(c => getTimeZoneOffsetMs(c, timeZone) === wall - c);
  if (valid.length > 0) return Math.min(...valid);
  // Wall time falls in a DST gap: shift forward by the gap length.
  return Math.max(candidateA, candidateB);
}

/** Adds whole days to a calendar date (no time zone involved). */
export function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Parses "HH:MM" (00:00–24:00) into minutes since midnight, or null. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

/** YYYY-MM-DD of an instant in `timeZone`. */
export function zonedDateKey(ms: number, timeZone: string): string {
  const p = getZonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
