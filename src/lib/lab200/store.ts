import { hashString, type D1DatabaseLike } from '../../db/store';
import { coursePageUrl, courseImageFromHtml, LAB200_COURSES_MD, parseCoursesMarkdown, type Lab200Course } from './courses';

/** A snapshot older than this is refreshed in the background after the response. */
export const LAB200_STALE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
/** Course pages are fetched a few at a time, and only their <head> is read (og:image sits there). */
const IMAGE_FETCH_CONCURRENCY = 4;
const IMAGE_HEAD_MAX_BYTES = 512 * 1024;

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
  /**
   * Save the course list first and fetch missing thumbnails after the response (`waitUntil`).
   * Used by the first request, which must not wait for a dozen course pages.
   */
  deferImages?: boolean;
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

/** Read a course page until its og:image appears (or </head>), then stop downloading. */
async function fetchCourseImage(slug: string, fetchImpl: NonNullable<Lab200Options['fetchImpl']>): Promise<string | null> {
  const res = await fetchImpl(coursePageUrl(slug), {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  try {
    while (html.length < IMAGE_HEAD_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      const image = courseImageFromHtml(html);
      if (image) return image;
      if (/<\/head>/i.test(html)) break;
    }
    return courseImageFromHtml(html);
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Thumbnails for `slugs`, fetched with bounded concurrency; a failed page maps to null. */
async function fetchCourseImages(slugs: string[], fetchImpl: NonNullable<Lab200Options['fetchImpl']>): Promise<Map<string, string | null>> {
  const images = new Map<string, string | null>();
  let next = 0;
  const worker = async () => {
    while (next < slugs.length) {
      const slug = slugs[next++];
      images.set(slug, await fetchCourseImage(slug, fetchImpl).catch(() => null));
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, slugs.length) }, worker));
  return images;
}

/**
 * Fill thumbnails for `courses` (saved under `hash`): every course when courses.md changed,
 * otherwise only the ones still without an image. A failed page keeps the previous image.
 * The write is skipped when a newer course list was saved in the meantime.
 */
async function fillCourseImages(
  d1: D1DatabaseLike,
  courses: Lab200Course[],
  hash: string,
  refetchAll: boolean,
  fetchImpl: NonNullable<Lab200Options['fetchImpl']>,
): Promise<void> {
  const slugs = courses.filter(c => refetchAll || !c.image).map(c => c.slug);
  if (slugs.length === 0) return;
  const fetched = await fetchCourseImages(slugs, fetchImpl);
  const withImages = courses.map(c => ({ ...c, image: fetched.get(c.slug) ?? c.image ?? null }));
  if (withImages.every((c, i) => c.image === (courses[i].image ?? null))) return;
  await d1
    .prepare('UPDATE lab200_snapshot SET courses_json = ? WHERE id = 1 AND content_hash = ?')
    .bind(JSON.stringify(withImages), hash)
    .run();
}

/**
 * Refresh the snapshot unless another request refreshed it within `LAB200_STALE_MS` (the
 * conditional update on `checked_at` lets one request win). Returns true when new data was saved.
 * Failures keep the previous courses. `content_hash` covers courses.md only, not thumbnails.
 */
export async function refreshLab200Snapshot(d1: D1DatabaseLike, opts: Lab200Options = {}): Promise<boolean> {
  const now = (opts.now ?? (() => new Date()))();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cutoff = new Date(now.getTime() - LAB200_STALE_MS).toISOString();
  const claim = await d1
    .prepare('UPDATE lab200_snapshot SET checked_at = ? WHERE id = 1 AND checked_at < ?')
    .bind(now.toISOString(), cutoff)
    .run();
  if (!claim.meta?.changes) return false;
  try {
    const fresh = await fetchLab200Courses(fetchImpl);
    const hash = await hashString(JSON.stringify(fresh));
    const previous = await readRow(d1);
    const known = new Map(parseCourses(previous?.courses_json ?? '[]').map(c => [c.slug, c.image ?? null]));
    const courses = fresh.map(c => ({ ...c, image: known.get(c.slug) ?? null }));
    await d1
      .prepare('UPDATE lab200_snapshot SET courses_json = ?, content_hash = ?, synced_at = ? WHERE id = 1')
      .bind(JSON.stringify(courses), hash, now.toISOString())
      .run();
    const images = fillCourseImages(d1, courses, hash, previous?.content_hash !== hash, fetchImpl).catch(err => {
      console.warn('200lab thumbnails refresh failed; keeping the previous images:', err);
    });
    if (opts.deferImages && opts.waitUntil) opts.waitUntil(images);
    else await images;
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
    await refreshLab200Snapshot(d1, { ...opts, deferImages: true });
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
