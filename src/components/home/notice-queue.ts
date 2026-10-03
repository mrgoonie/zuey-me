/** Pure notice selection + dismissal bookkeeping (kept free of DOM APIs so it is unit-testable). */
import type { PublicNotice } from '../../lib/experience/notices';
import { isRecord } from './storage';

export interface DismissedNotice {
  id: string;
  /** Expiry of the dismissed notice; entries are pruned after it passes. */
  expires_at: string;
}

const MAX_DISMISSED = 100;

/** Reads the stored dismissal list, dropping malformed and already-expired entries. */
export function parseDismissed(raw: unknown, now: number): DismissedNotice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap(entry => (isRecord(entry) && typeof entry.id === 'string' && typeof entry.expires_at === 'string'
      ? [{ id: entry.id, expires_at: entry.expires_at }]
      : []))
    .filter(entry => {
      const t = Date.parse(entry.expires_at);
      return Number.isFinite(t) && t > now;
    })
    .slice(0, MAX_DISMISSED);
}

export function addDismissed(list: DismissedNotice[], notice: Pick<PublicNotice, 'id' | 'expires_at'>, now: number): DismissedNotice[] {
  return [{ id: notice.id, expires_at: notice.expires_at }, ...parseDismissed(list, now).filter(d => d.id !== notice.id)].slice(0, MAX_DISMISSED);
}

/** The notice to show now: live (started, not expired) and not dismissed on this device. */
export function pickNotice(notices: PublicNotice[], dismissed: DismissedNotice[], now: number): PublicNotice | null {
  const hidden = new Set(dismissed.map(d => d.id));
  return notices.find(n => {
    const start = Date.parse(n.starts_at);
    const end = Date.parse(n.expires_at);
    return !hidden.has(n.id) && Number.isFinite(end) && end > now && (!Number.isFinite(start) || start <= now);
  }) ?? null;
}

/** Milliseconds until the selection can next change (a notice expires or starts), capped for timers. */
export function nextNoticeChange(notices: PublicNotice[], now: number): number | null {
  const times = notices
    .flatMap(n => [Date.parse(n.starts_at), Date.parse(n.expires_at)])
    .filter(t => Number.isFinite(t) && t > now);
  if (times.length === 0) return null;
  return Math.min(Math.min(...times) - now + 50, 2 ** 31 - 1);
}
