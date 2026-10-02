import { AppError } from '../http';
import type { JsonCache } from './runtime';
import { experienceRuntime, fetchWithTimeout, isRecord, readNumber, readString } from './runtime';

/** Public GitHub account behind "Zuey đang làm gì" (verified identity of Duy /zuey/). */
export const GITHUB_ACTIVITY_USER = 'mrgoonie';
/** GitHub serves at most 300 public events (3 pages × 100) from roughly the last 90 days. */
export const GITHUB_MAX_PAGES = 3;
const PER_PAGE = 100;
const FRESH_TTL_SECONDS = 15 * 60;
const STALE_TTL_SECONDS = 7 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 8000;

const KEY_FRESH = `github:activity:${GITHUB_ACTIVITY_USER}:fresh`;
const KEY_STALE = `github:activity:${GITHUB_ACTIVITY_USER}:stale`;
const KEY_BLOCKED = `github:activity:${GITHUB_ACTIVITY_USER}:blocked`;

export interface ActivityEvent {
  id: string;
  type: string;
  action: string | null;
  repo: string;
  repo_url: string;
  /** Event-specific link (PR, issue, release) or the repository. */
  url: string;
  created_at: string;
  ref: string | null;
  ref_type: string | null;
  title: string | null;
  number: number | null;
  commits: number | null;
}

export interface ActivitySnapshot {
  user: string;
  fetched_at: string;
  events: ActivityEvent[];
  pages_fetched: number;
  /** True when a later page failed, so fewer than the available events are shown. */
  partial: boolean;
  etag: string | null;
}

export type ActivityErrorCode = 'github_rate_limited' | 'github_unavailable';

export interface ActivityResult {
  snapshot: ActivitySnapshot;
  source: 'cache' | 'live' | 'revalidated' | 'stale';
  /** Present when the upstream failed and the last good snapshot is being served. */
  error: { code: ActivityErrorCode; message: string; retry_after_seconds: number | null } | null;
}

function clip(value: string | null, max = 200): string | null {
  if (value === null) return null;
  const v = value.replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

function githubUrl(value: string | null): string | null {
  return value && value.startsWith('https://github.com/') ? value : null;
}

/** Reduces a raw GitHub event to public, display-safe fields. Returns null for malformed events. */
export function sanitizeEvent(raw: unknown): ActivityEvent | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, 'id');
  const type = readString(raw, 'type');
  const createdAt = readString(raw, 'created_at');
  const repoObj = isRecord(raw.repo) ? raw.repo : null;
  const repo = repoObj ? readString(repoObj, 'name') : null;
  if (!id || !type || !createdAt || !repo || Number.isNaN(Date.parse(createdAt))) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const repoUrl = `https://github.com/${repo}`;
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const action = readString(payload, 'action');

  const event: ActivityEvent = {
    id, type, action: clip(action, 40), repo, repo_url: repoUrl, url: repoUrl, created_at: new Date(createdAt).toISOString(),
    ref: null, ref_type: null, title: null, number: null, commits: null,
  };

  const item = isRecord(payload.pull_request) ? payload.pull_request : isRecord(payload.issue) ? payload.issue : null;
  if (item) {
    event.title = clip(readString(item, 'title'));
    event.number = readNumber(item, 'number');
    event.url = githubUrl(readString(item, 'html_url')) ?? repoUrl;
  }
  switch (type) {
    case 'PushEvent': {
      const ref = readString(payload, 'ref');
      event.ref = ref ? clip(ref.replace(/^refs\/heads\//, ''), 120) : null;
      const size = readNumber(payload, 'size');
      event.commits = size ?? (Array.isArray(payload.commits) ? payload.commits.length : null);
      break;
    }
    case 'CreateEvent':
    case 'DeleteEvent':
      event.ref = clip(readString(payload, 'ref'), 120);
      event.ref_type = clip(readString(payload, 'ref_type'), 40);
      break;
    case 'ReleaseEvent': {
      const release = isRecord(payload.release) ? payload.release : null;
      if (release) {
        event.ref = clip(readString(release, 'tag_name'), 120);
        event.title = clip(readString(release, 'name'));
        event.url = githubUrl(readString(release, 'html_url')) ?? repoUrl;
      }
      break;
    }
    case 'ForkEvent': {
      const forkee = isRecord(payload.forkee) ? payload.forkee : null;
      event.title = forkee ? clip(readString(forkee, 'full_name')) : null;
      break;
    }
    default:
      break;
  }
  return event;
}

function isSnapshot(value: unknown): value is ActivitySnapshot {
  return isRecord(value) && typeof value.fetched_at === 'string' && Array.isArray(value.events) && typeof value.user === 'string';
}

interface PageResult {
  status: number;
  events: ActivityEvent[];
  rawCount: number;
  etag: string | null;
  retryAfterSeconds: number | null;
}

function retryAfter(res: Response, nowMs: number): number | null {
  const header = res.headers.get('retry-after');
  if (header && /^\d+$/.test(header)) return Number(header);
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset && /^\d+$/.test(reset)) return Math.max(1, Number(reset) - Math.floor(nowMs / 1000));
  return null;
}

async function fetchPage(page: number, etag: string | null): Promise<PageResult> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'zuey.me-activity',
  };
  if (etag) headers['If-None-Match'] = etag;
  const url = `https://api.github.com/users/${GITHUB_ACTIVITY_USER}/events/public?per_page=${PER_PAGE}&page=${page}`;
  const res = await fetchWithTimeout(url, { headers }, FETCH_TIMEOUT_MS);
  const base = { status: res.status, etag: res.headers.get('etag'), retryAfterSeconds: retryAfter(res, experienceRuntime.now()) };
  if (res.status !== 200) return { ...base, events: [], rawCount: 0 };
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return { ...base, status: 502, events: [], rawCount: 0 };
  const events = body.map(sanitizeEvent).filter((e): e is ActivityEvent => e !== null);
  return { ...base, events, rawCount: body.length };
}

function isRateLimited(page: PageResult): boolean {
  return page.status === 429 || (page.status === 403 && page.retryAfterSeconds !== null);
}

async function fetchSnapshot(previous: ActivitySnapshot | null): Promise<{ snapshot: ActivitySnapshot; revalidated: boolean }> {
  const first = await fetchPage(1, previous?.etag ?? null);
  const now = new Date(experienceRuntime.now()).toISOString();
  // GitHub's newest page is unchanged, so the whole (append-only) feed is unchanged.
  if (first.status === 304 && previous) return { snapshot: { ...previous, fetched_at: now }, revalidated: true };
  if (isRateLimited(first)) {
    throw new AppError(429, 'github_rate_limited', 'GitHub public API rate limit reached; try again later', { retry_after_seconds: first.retryAfterSeconds });
  }
  if (first.status !== 200) throw new AppError(502, 'github_unavailable', `GitHub responded with HTTP ${first.status}`);

  const events = [...first.events];
  let pages = 1;
  let partial = false;
  let lastCount = first.rawCount;
  while (lastCount === PER_PAGE && pages < GITHUB_MAX_PAGES) {
    try {
      const next = await fetchPage(pages + 1, null);
      if (next.status !== 200) {
        // GitHub answers 422 past the last available page; anything else is a real failure.
        partial = next.status !== 422;
        break;
      }
      events.push(...next.events);
      pages += 1;
      lastCount = next.rawCount;
    } catch {
      partial = true;
      break;
    }
  }
  const seen = new Set<string>();
  const unique = events.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  unique.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return {
    snapshot: { user: GITHUB_ACTIVITY_USER, fetched_at: now, events: unique, pages_fetched: pages, partial, etag: first.etag },
    revalidated: false,
  };
}

function toActivityError(err: unknown): { code: ActivityErrorCode; message: string; retry_after_seconds: number | null; status: number } {
  if (err instanceof AppError && err.code === 'github_rate_limited') {
    const retry = typeof err.extra.retry_after_seconds === 'number' ? err.extra.retry_after_seconds : null;
    return { code: 'github_rate_limited', message: err.message, retry_after_seconds: retry, status: 429 };
  }
  const message = err instanceof AppError ? err.message : 'GitHub is unreachable right now';
  return { code: 'github_unavailable', message, retry_after_seconds: null, status: 503 };
}

/**
 * Public events for GITHUB_ACTIVITY_USER: served from a 15-minute cache, revalidated with ETag,
 * and falling back to the last good snapshot (marked stale) when GitHub is rate limited or down.
 */
export async function getGithubActivity(cache: JsonCache = experienceRuntime.cache()): Promise<ActivityResult> {
  const fresh = await cache.get(KEY_FRESH);
  if (isSnapshot(fresh)) return { snapshot: fresh, source: 'cache', error: null };

  const staleValue = await cache.get(KEY_STALE);
  const stale = isSnapshot(staleValue) ? staleValue : null;
  const blocked = await cache.get(KEY_BLOCKED);

  try {
    if (isRecord(blocked) && typeof blocked.until === 'number' && blocked.until > experienceRuntime.now()) {
      throw new AppError(429, 'github_rate_limited', 'GitHub public API rate limit reached; try again later', {
        retry_after_seconds: Math.ceil((blocked.until - experienceRuntime.now()) / 1000),
      });
    }
    const { snapshot, revalidated } = await fetchSnapshot(stale);
    await cache.put(KEY_FRESH, snapshot, FRESH_TTL_SECONDS);
    await cache.put(KEY_STALE, snapshot, STALE_TTL_SECONDS);
    return { snapshot, source: revalidated ? 'revalidated' : 'live', error: null };
  } catch (err) {
    const info = toActivityError(err);
    if (info.code === 'github_rate_limited' && info.retry_after_seconds && !isRecord(blocked)) {
      // Remember the block so visitors do not keep hitting GitHub until the window resets.
      await cache.put(KEY_BLOCKED, { until: experienceRuntime.now() + info.retry_after_seconds * 1000 }, Math.min(info.retry_after_seconds, 3600));
    }
    if (stale) return { snapshot: stale, source: 'stale', error: { code: info.code, message: info.message, retry_after_seconds: info.retry_after_seconds } };
    throw new AppError(info.status, info.code, info.message, { retry_after_seconds: info.retry_after_seconds });
  }
}
