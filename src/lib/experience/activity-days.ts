/** Pure helpers shared by the activity API tests and the client graph. */

export interface DayCount {
  /** Calendar date (YYYY-MM-DD) in the requested time zone. */
  date: string;
  count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD for an instant in a time zone (en-CA formats dates as ISO). */
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Event counts for every calendar day from the oldest event to `endIso` (inclusive), including
 * zero-event days, so the bars form a continuous timeline of the fetched window only.
 */
export function countEventsByDay(events: { created_at: string }[], timeZone: string, endIso: string): DayCount[] {
  if (events.length === 0) return [];
  const counts = new Map<string, number>();
  let first = localDate(events[0].created_at, timeZone);
  for (const e of events) {
    const d = localDate(e.created_at, timeZone);
    counts.set(d, (counts.get(d) ?? 0) + 1);
    if (d < first) first = d;
  }
  const last = localDate(endIso, timeZone);
  const out: DayCount[] = [];
  for (let d = first; d <= last && out.length < 400; d = nextDate(d)) {
    out.push({ date: d, count: counts.get(d) ?? 0 });
  }
  return out;
}
