/**
 * Pure mapping from a PresenceHistory answer to the Activity Monitor's 24h chart: a fixed grid of
 * PRESENCE_HISTORY_BUCKETS five-minute slots ending at the bucket that contains `history.at`. Buckets the
 * Worker did not send (or sent out of the window, misaligned or twice) never invent visitors: a missing slot
 * is a gap with peak 0. Time labels use the viewer's time zone unless one is given (tests).
 */
import { PRESENCE_HISTORY_BUCKETS, PRESENCE_HISTORY_BUCKET_MS, type CategoryCount, type PresenceHistory } from './contract';

export interface HistoryPoint {
  /** Epoch ms of the slot start. */
  t: number;
  peak: number;
  categories: CategoryCount[];
  /** True when the Worker sent no bucket for this slot. */
  gap: boolean;
}

export interface HistorySeries {
  points: HistoryPoint[];
  max: number;
  /** Index of the first slot holding `max`; -1 when every slot is 0. */
  maxIndex: number;
  /** True when no slot had a visitor (zero state). */
  empty: boolean;
}

const slotStart = (ms: number): number => Math.floor(ms / PRESENCE_HISTORY_BUCKET_MS) * PRESENCE_HISTORY_BUCKET_MS;

export function buildHistorySeries(history: PresenceHistory, slots: number = PRESENCE_HISTORY_BUCKETS): HistorySeries {
  const at = Date.parse(history.at);
  const last = history.buckets.length > 0 ? Date.parse(history.buckets[history.buckets.length - 1].t) : Number.NaN;
  const end = slotStart(Number.isFinite(at) ? at : Number.isFinite(last) ? last : 0);
  const start = end - (slots - 1) * PRESENCE_HISTORY_BUCKET_MS;

  const byStart = new Map<number, { peak: number; categories: CategoryCount[] }>();
  for (const b of history.buckets) {
    const t = Date.parse(b.t);
    if (!Number.isFinite(t) || t !== slotStart(t) || t < start || t > end) continue;
    const seen = byStart.get(t);
    if (!seen || b.peak > seen.peak) byStart.set(t, { peak: b.peak, categories: b.categories });
  }

  const points: HistoryPoint[] = [];
  let max = 0;
  let maxIndex = -1;
  for (let i = 0; i < slots; i++) {
    const t = start + i * PRESENCE_HISTORY_BUCKET_MS;
    const hit = byStart.get(t);
    const peak = hit ? hit.peak : 0;
    if (peak > max) {
      max = peak;
      maxIndex = i;
    }
    points.push({ t, peak, categories: hit ? hit.categories : [], gap: !hit });
  }
  return { points, max, maxIndex, empty: max === 0 };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, timeZone: string | undefined, withDay: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone ?? ''}|${withDay}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone, ...(withDay ? { weekday: 'short' } : {}),
    });
    formatters.set(key, f);
  }
  return f;
}

/** Local clock time of an epoch ms, e.g. `14:05`. */
export const formatHistoryTime = (t: number, locale: string, timeZone?: string): string => formatter(locale, timeZone, false).format(t);

/** Tooltip label of one slot: weekday plus local start and end time, e.g. `Tue 14:05 – 14:10`. */
export function formatHistorySlot(t: number, locale: string, timeZone?: string): string {
  return `${formatter(locale, timeZone, true).format(t)} – ${formatHistoryTime(t + PRESENCE_HISTORY_BUCKET_MS, locale, timeZone)}`;
}

export interface HistoryTick {
  index: number;
  label: string;
}

/** Axis ticks at local midnight, 06:00, 12:00 and 18:00 that fall inside the window. */
export function historyTicks(points: HistoryPoint[], locale: string, timeZone?: string): HistoryTick[] {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone });
  const ticks: HistoryTick[] = [];
  points.forEach((p, index) => {
    let hour = -1;
    let minute = -1;
    for (const part of parts.formatToParts(p.t)) {
      if (part.type === 'hour') hour = Number(part.value);
      else if (part.type === 'minute') minute = Number(part.value);
    }
    if (minute === 0 && hour % 6 === 0) ticks.push({ index, label: formatHistoryTime(p.t, locale, timeZone) });
  });
  return ticks;
}
