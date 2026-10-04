/** Client-side fetch + validation for the homepage endpoints. Responses are untrusted JSON. */
import type { ActivityEvent, ActivityResult } from '../../lib/experience/github-activity';
import type { CalendarDay, ContributionCalendar } from '../../lib/experience/github-calendar';
import type { PublicNotice } from '../../lib/experience/notices';
import type { WeatherCondition, WeatherReport } from '../../lib/experience/weather';
import type { CommunityStatus, MembershipView } from '../../lib/experience/community';
import { isRecord } from './storage';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; retryAfter: number | null };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** GET/POST JSON with the `{ success, data | error }` envelope; network failures become status 0. */
export async function apiFetch<T>(url: string, parse: (data: unknown) => T | null, init: RequestInit = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init, headers: { Accept: 'application/json', ...init.headers } });
  } catch {
    return { ok: false, status: 0, code: 'network_error', message: 'Network request failed', retryAfter: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && isRecord(body) && body.success === true) {
    const data = parse(body.data);
    if (data !== null) return { ok: true, data };
    return { ok: false, status: res.status, code: 'invalid_response', message: 'Unexpected response shape', retryAfter: null };
  }
  const err = isRecord(body) && isRecord(body.error) ? body.error : {};
  const header = Number(res.headers.get('retry-after'));
  return {
    ok: false,
    status: res.status,
    code: str(err.code) ?? `http_${res.status}`,
    message: str(err.message) ?? res.statusText,
    retryAfter: num(err.retry_after_seconds) ?? (Number.isFinite(header) && header > 0 ? header : null),
  };
}

const CONDITIONS: readonly WeatherCondition[] = ['clear', 'clouds', 'fog', 'rain', 'snow', 'storm'];
const isCondition = (v: unknown): v is WeatherCondition => typeof v === 'string' && (CONDITIONS as readonly string[]).includes(v);

export function parseWeather(v: unknown): WeatherReport | null {
  if (!isRecord(v) || !isCondition(v.condition)) return null;
  const lat = num(v.latitude);
  const lon = num(v.longitude);
  const code = num(v.weather_code);
  if (lat === null || lon === null || code === null) return null;
  const place = isRecord(v.place) && str(v.place.name)
    ? { name: str(v.place.name) ?? '', country: str(v.place.country), admin1: str(v.place.admin1) }
    : null;
  return {
    place,
    latitude: lat,
    longitude: lon,
    condition: v.condition,
    is_day: v.is_day !== false,
    weather_code: code,
    temperature_c: num(v.temperature_c),
    wind_kmh: num(v.wind_kmh),
    observed_at: str(v.observed_at),
    source: 'open-meteo',
    attribution: str(v.attribution) ?? 'Weather data by Open-Meteo.com',
  };
}

function parseEvent(v: unknown): ActivityEvent | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const type = str(v.type);
  const repo = str(v.repo);
  const url = str(v.url);
  const created = str(v.created_at);
  if (!id || !type || !repo || !url || !created || !url.startsWith('https://github.com/')) return null;
  return {
    id, type, repo, url, created_at: created,
    action: str(v.action),
    repo_url: str(v.repo_url) ?? `https://github.com/${repo}`,
    ref: str(v.ref),
    ref_type: str(v.ref_type),
    title: str(v.title),
    number: num(v.number),
    commits: num(v.commits),
  };
}

export function parseActivity(v: unknown): ActivityResult | null {
  if (!isRecord(v) || !isRecord(v.snapshot)) return null;
  const s = v.snapshot;
  if (!Array.isArray(s.events) || !str(s.fetched_at)) return null;
  const source = v.source === 'cache' || v.source === 'live' || v.source === 'revalidated' || v.source === 'stale' ? v.source : 'live';
  const e = isRecord(v.error) ? v.error : null;
  return {
    snapshot: {
      user: str(s.user) ?? 'mrgoonie',
      fetched_at: str(s.fetched_at) ?? '',
      events: s.events.map(parseEvent).filter((x): x is ActivityEvent => x !== null),
      pages_fetched: num(s.pages_fetched) ?? 0,
      partial: s.partial === true,
      etag: null,
    },
    source,
    error: e
      ? {
        code: e.code === 'github_rate_limited' ? 'github_rate_limited' : 'github_unavailable',
        message: str(e.message) ?? '',
        retry_after_seconds: num(e.retry_after_seconds),
      }
      : null,
  };
}

const LEVELS: readonly CalendarDay['level'][] = [0, 1, 2, 3, 4];

function parseCalendarDay(v: unknown): CalendarDay | null {
  if (!isRecord(v)) return null;
  const date = str(v.date);
  const level = LEVELS.find(l => l === v.level);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || level === undefined) return null;
  const count = num(v.count);
  return { date, level, count: count !== null && count >= 0 ? Math.floor(count) : null };
}

export function parseCalendar(v: unknown): ContributionCalendar | null {
  if (!isRecord(v) || !Array.isArray(v.days) || !str(v.fetched_at)) return null;
  const e = isRecord(v.error) ? v.error : null;
  const total = num(v.total);
  const calendar: ContributionCalendar = {
    user: str(v.user) ?? 'mrgoonie',
    total: total !== null && total >= 0 ? total : null,
    days: v.days.map(parseCalendarDay).filter((x): x is CalendarDay => x !== null).sort((a, b) => a.date.localeCompare(b.date)),
    fetched_at: str(v.fetched_at) ?? '',
  };
  if (e) {
    calendar.error = {
      code: e.code === 'github_rate_limited' ? 'github_rate_limited' : 'github_unavailable',
      message: str(e.message) ?? '',
      retry_after_seconds: num(e.retry_after_seconds),
    };
  }
  return calendar;
}

const EXPRESSIONS = ['idle', 'wave', 'talking', 'thinking', 'happy', 'surprised'] as const;

function parseNotice(v: unknown): PublicNotice | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const text = str(v.text);
  const locale = str(v.locale);
  const starts = str(v.starts_at);
  const expires = str(v.expires_at);
  if (!id || !text || !starts || !expires || (locale !== 'en' && locale !== 'vi' && locale !== 'zh' && locale !== 'ko' && locale !== 'ja')) return null;
  const expression = EXPRESSIONS.find(x => x === v.expression) ?? null;
  return { id, text, locale, expression, starts_at: starts, expires_at: expires };
}

export function parseNotices(v: unknown): PublicNotice[] | null {
  if (!isRecord(v) || !Array.isArray(v.notices)) return null;
  return v.notices.map(parseNotice).filter((x): x is PublicNotice => x !== null);
}

function parseMembership(v: unknown): MembershipView | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const chat = v.chat === 'en' || v.chat === 'vi' ? v.chat : null;
  const status = v.status === 'invited' || v.status === 'joined' || v.status === 'left' || v.status === 'removed' || v.status === 'revoked' ? v.status : null;
  const expires = str(v.invite_expires_at);
  if (!id || !chat || !status || !expires) return null;
  const link = str(v.invite_link);
  return {
    id, chat, status,
    invite_link: link && link.startsWith('https://t.me/') ? link : null,
    invite_expires_at: expires,
    joined_at: str(v.joined_at),
    created_at: str(v.created_at) ?? '',
  };
}

export function parseCommunity(v: unknown): CommunityStatus | null {
  if (!isRecord(v) || typeof v.configured !== 'boolean' || typeof v.entitled !== 'boolean') return null;
  const chats: CommunityStatus['chats'] = [];
  if (Array.isArray(v.chats)) {
    for (const c of v.chats) {
      if (!isRecord(c)) continue;
      const chat = c.chat === 'en' ? 'en' : c.chat === 'vi' ? 'vi' : null;
      if (chat) chats.push({ chat, available: c.available === true });
    }
  }
  const memberships = Array.isArray(v.memberships)
    ? v.memberships.map(parseMembership).filter((x): x is MembershipView => x !== null)
    : [];
  return { signed_in: v.signed_in === true, configured: v.configured, entitled: v.entitled, chats, memberships };
}

export { parseMembership };

export interface ArticleHit {
  slug: string;
  title: string;
  excerpt: string;
  tags: string[];
  locale: string | null;
}

/** Accepts `data` as an array or `{ items | articles }` so it keeps working as the articles API evolves. */
export function parseArticleHits(v: unknown): ArticleHit[] | null {
  const list = Array.isArray(v) ? v : isRecord(v) ? (Array.isArray(v.items) ? v.items : Array.isArray(v.articles) ? v.articles : null) : null;
  if (!list) return null;
  return list.flatMap(item => {
    if (!isRecord(item)) return [];
    const slug = str(item.slug);
    const title = str(item.title);
    if (!slug || !title || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return [];
    const tags = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [];
    return [{ slug, title, excerpt: str(item.excerpt) ?? '', tags, locale: str(item.locale) }];
  });
}
