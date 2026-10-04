import { AppError } from '../http';
import type { JsonCache } from './runtime';
import { experienceRuntime, fetchWithTimeout, isRecord } from './runtime';
import type { ActivityErrorCode } from './github-activity';
import { GITHUB_ACTIVITY_USER } from './github-activity';

/** 53 weeks: the span GitHub draws on a profile's contribution graph. */
export const CALENDAR_MAX_DAYS = 53 * 7;
const FRESH_TTL_SECONDS = 6 * 60 * 60;
const STALE_TTL_SECONDS = 14 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 8000;
const SOURCE_URL = `https://github.com/users/${GITHUB_ACTIVITY_USER}/contributions`;

const KEY_FRESH = `github:calendar:${GITHUB_ACTIVITY_USER}:fresh`;
const KEY_STALE = `github:calendar:${GITHUB_ACTIVITY_USER}:stale`;
const KEY_BLOCKED = `github:calendar:${GITHUB_ACTIVITY_USER}:blocked`;

export interface CalendarDay {
  /** YYYY-MM-DD as GitHub dates the cell. */
  date: string;
  /** Contributions that day; null when GitHub's page carried no count (level only). */
  count: number | null;
  /** GitHub intensity bucket, 0 (none) to 4 (most). */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface ContributionCalendar {
  user: string;
  /** "N contributions in the last year"; null when neither the heading nor per-day counts exist. */
  total: number | null;
  days: CalendarDay[];
  fetched_at: string;
  /** Present when GitHub failed and the last good calendar is being served. */
  error?: { code: ActivityErrorCode; message: string; retry_after_seconds: number | null };
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function toLevel(value: string | null): CalendarDay['level'] {
  const n = Number(value);
  if (n >= 4) return 4;
  if (n >= 3) return 3;
  if (n >= 2) return 2;
  if (n >= 1) return 1;
  return 0;
}

function toInt(text: string): number | null {
  const n = Number(text.replace(/[,.\s]/g, ''));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses GitHub's public contributions fragment with regexes (no DOM on the edge):
 * `<td data-date data-level id>` cells, `<tool-tip for=id>N contributions on …</tool-tip>` counts
 * and the "N contributions in the last year" heading. Returns the last 53 weeks, oldest first.
 */
export function parseContributionCalendar(html: string): { total: number | null; days: CalendarDay[] } {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/gi)) {
    const target = attr(m[1], 'for');
    const text = m[2].replace(/<[^>]*>/g, ' ').trim();
    const digits = /^([\d,]+)\s+contributions?\b/i.exec(text)?.[1];
    const count = /^no\s+contributions?\b/i.test(text) ? 0 : digits ? toInt(digits) : null;
    if (target && count !== null) counts.set(target, count);
  }

  const byDate = new Map<string, CalendarDay>();
  for (const m of html.matchAll(/<td\b([^>]*\bdata-date\s*=[^>]*)>/gi)) {
    const date = attr(m[1], 'data-date');
    if (!date || !VALID_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) continue;
    const id = attr(m[1], 'id');
    const count = id !== null ? counts.get(id) ?? null : null;
    byDate.set(date, { date, count, level: toLevel(attr(m[1], 'data-level')) });
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-CALENDAR_MAX_DAYS);

  const heading = /([\d,]+)\s+contributions?\s+in\s+the\s+last\s+year/i.exec(html);
  let total = heading ? toInt(heading[1]) : null;
  if (total === null && days.length > 0 && days.every(d => d.count !== null)) {
    total = days.reduce((sum, d) => sum + (d.count ?? 0), 0);
  }
  return { total, days };
}

function isCalendar(value: unknown): value is ContributionCalendar {
  return isRecord(value) && typeof value.user === 'string' && typeof value.fetched_at === 'string' && Array.isArray(value.days);
}

function retryAfterSeconds(res: Response): number | null {
  const header = res.headers.get('retry-after');
  return header && /^\d+$/.test(header) ? Math.max(1, Number(header)) : null;
}

async function fetchCalendar(): Promise<ContributionCalendar> {
  const res = await fetchWithTimeout(SOURCE_URL, {
    headers: { Accept: 'text/html', 'User-Agent': 'zuey.me-activity' },
  }, FETCH_TIMEOUT_MS);
  if (res.status === 429 || (res.status === 403 && retryAfterSeconds(res) !== null)) {
    throw new AppError(429, 'github_rate_limited', 'GitHub rate limit reached; try again later', { retry_after_seconds: retryAfterSeconds(res) });
  }
  if (res.status !== 200) throw new AppError(502, 'github_unavailable', `GitHub responded with HTTP ${res.status}`);
  const { total, days } = parseContributionCalendar(await res.text());
  if (days.length === 0) throw new AppError(502, 'github_unavailable', 'GitHub contributions page had no calendar');
  return { user: GITHUB_ACTIVITY_USER, total, days, fetched_at: new Date(experienceRuntime.now()).toISOString() };
}

/**
 * The public contribution calendar of GITHUB_ACTIVITY_USER (last 53 weeks), cached for 6 hours and
 * served from the last good copy (with `error`) while GitHub is rate limited or down.
 */
export async function getContributionCalendar(cache: JsonCache = experienceRuntime.cache()): Promise<ContributionCalendar> {
  const fresh = await cache.get(KEY_FRESH);
  if (isCalendar(fresh)) return fresh;

  const staleValue = await cache.get(KEY_STALE);
  const stale = isCalendar(staleValue) ? staleValue : null;
  const blocked = await cache.get(KEY_BLOCKED);
  const now = experienceRuntime.now();

  try {
    if (isRecord(blocked) && typeof blocked.until === 'number' && blocked.until > now) {
      throw new AppError(429, 'github_rate_limited', 'GitHub rate limit reached; try again later', {
        retry_after_seconds: Math.ceil((blocked.until - now) / 1000),
      });
    }
    const calendar = await fetchCalendar();
    await cache.put(KEY_FRESH, calendar, FRESH_TTL_SECONDS);
    await cache.put(KEY_STALE, calendar, STALE_TTL_SECONDS);
    return calendar;
  } catch (err) {
    const limited = err instanceof AppError && err.code === 'github_rate_limited';
    const retry = limited && typeof err.extra.retry_after_seconds === 'number' ? err.extra.retry_after_seconds : null;
    if (limited && retry && !isRecord(blocked)) {
      // Remember the block so visitors do not keep hitting GitHub until the window resets.
      await cache.put(KEY_BLOCKED, { until: now + retry * 1000 }, Math.min(retry, 3600));
    }
    const code: ActivityErrorCode = limited ? 'github_rate_limited' : 'github_unavailable';
    const message = err instanceof AppError ? err.message : 'GitHub is unreachable right now';
    if (stale) return { ...stale, error: { code, message, retry_after_seconds: retry } };
    throw new AppError(limited ? 429 : 503, code, message, { retry_after_seconds: retry });
  }
}
