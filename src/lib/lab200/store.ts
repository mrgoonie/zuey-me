import { hashString, type D1DatabaseLike } from '../../db/store';
import { LAB200_COURSES_MD, parseCoursesMarkdown, type Lab200Course } from './courses';

/** A snapshot older than this is refreshed in the background after the response. */
export const LAB200_STALE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface Lab200Snapshot {
  courses: Lab200Course[];
  /** Last successful fetch of courses.md (ISO), null when 200lab was never reached. */
  syncedAt: string | null;
}

export interface Lab200Options {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Cloudflare `ctx.waitUntil`; without it a stale refresh runs detached (dev, tests). */
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => Date;
}

interface SnapshotRow {
  courses_json: string;
  content_hash: string;
  synced_at: string | null;
  checked_at: string;
}

function parseCourses(json: string): Lab200Course[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as Lab200Course[]) : [];
  } catch {
    return [];
  }
}

async function readRow(d1: D1DatabaseLike): Promise<SnapshotRow | null> {
  return d1.prepare('SELECT courses_json, content_hash, synced_at, checked_at FROM lab200_snapshot WHERE id = 1').first<SnapshotRow>();
}

/** Fetch and parse courses.md; throws on HTTP errors, timeouts and an empty course list. */
export async function fetchLab200Courses(fetchImpl: NonNullable<Lab200Options['fetchImpl']> = fetch): Promise<Lab200Course[]> {
  const res = await fetchImpl(LAB200_COURSES_MD, {
    headers: { Accept: 'text/markdown, text/plain' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`200lab courses.md returned HTTP ${res.status}`);
  const courses = parseCoursesMarkdown(await res.text());
  if (courses.length === 0) throw new Error('200lab courses.md contained no parsable courses');
  return courses;
}

/**
 * Refresh the snapshot unless another request refreshed it within `LAB200_STALE_MS` (the
 * conditional update on `checked_at` lets one request win). Returns true when new data was saved.
 * Failures keep the previous courses.
 */
export async function refreshLab200Snapshot(d1: D1DatabaseLike, opts: Lab200Options = {}): Promise<boolean> {
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - LAB200_STALE_MS).toISOString();
  const claim = await d1
    .prepare('UPDATE lab200_snapshot SET checked_at = ? WHERE id = 1 AND checked_at < ?')
    .bind(now.toISOString(), cutoff)
    .run();
  if (!claim.meta?.changes) return false;
  try {
    const courses = await fetchLab200Courses(opts.fetchImpl);
    const json = JSON.stringify(courses);
    const hash = await hashString(json);
    await d1
      .prepare('UPDATE lab200_snapshot SET courses_json = ?, content_hash = ?, synced_at = ? WHERE id = 1')
      .bind(json, hash, now.toISOString())
      .run();
    return true;
  } catch (err) {
    console.warn('200lab courses refresh failed; keeping the last snapshot:', err);
    return false;
  }
}

/**
 * Courses for the 200lab app. Reads the D1 snapshot and never waits for 200lab, except on the
 * very first request when the snapshot is still empty. A stale snapshot is refreshed after the
 * response. Without D1 (local dev) the list is fetched live.
 */
export async function getLab200Snapshot(d1: D1DatabaseLike | undefined, opts: Lab200Options = {}): Promise<Lab200Snapshot> {
  if (!d1) {
    try {
      return { courses: await fetchLab200Courses(opts.fetchImpl), syncedAt: (opts.now ?? (() => new Date()))().toISOString() };
    } catch {
      return { courses: [], syncedAt: null };
    }
  }
  let row = await readRow(d1);
  if (!row) return { courses: [], syncedAt: null };
  let courses = parseCourses(row.courses_json);
  if (courses.length === 0) {
    await refreshLab200Snapshot(d1, opts);
    row = (await readRow(d1)) ?? row;
    courses = parseCourses(row.courses_json);
  } else {
    const now = (opts.now ?? (() => new Date()))().getTime();
    if (now - Date.parse(row.checked_at) >= LAB200_STALE_MS) {
      const job = refreshLab200Snapshot(d1, opts).catch(() => false);
      opts.waitUntil?.(job);
    }
  }
  return { courses, syncedAt: row.synced_at };
}
