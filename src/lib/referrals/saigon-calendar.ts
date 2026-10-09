/**
 * Referral calendar in Asia/Saigon local time. Vietnam has a fixed UTC+7 offset with no daylight saving,
 * so plain offset arithmetic is exact and avoids depending on the runtime's ICU time-zone data.
 */
const SAIGON_OFFSET_MS = 7 * 60 * 60 * 1000;

/** `YYYY-MM` month label (validated by `parseMonth`). */
export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Local calendar parts of an instant. */
export function saigonParts(ms: number): { year: number; month: number; day: number } {
  const d = new Date(ms + SAIGON_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Local month of an instant, `YYYY-MM`. */
export function saigonMonth(ms: number): string {
  const { year, month } = saigonParts(ms);
  return monthLabel(year, month);
}

/** The month that just ended when closing on day 1 (the payout period label). */
export function previousSaigonMonth(ms: number): string {
  const { year, month } = saigonParts(ms);
  return month === 1 ? monthLabel(year - 1, 12) : monthLabel(year, month - 1);
}

/** Next day-1 close as a local date `YYYY-MM-01` (today counts when it is day 1). */
export function nextCloseDate(ms: number): string {
  const { year, month, day } = saigonParts(ms);
  if (day === 1) return `${monthLabel(year, month)}-01`;
  return month === 12 ? `${monthLabel(year + 1, 1)}-01` : `${monthLabel(year, month + 1)}-01`;
}

/** UTC ISO bounds [start, end) of a local month `YYYY-MM`; null when the label is malformed. */
export function saigonMonthRange(label: string): { start: string; end: string } | null {
  const m = MONTH_RE.exec(label);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = Date.UTC(year, month - 1, 1) - SAIGON_OFFSET_MS;
  const end = Date.UTC(year, month, 1) - SAIGON_OFFSET_MS;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
