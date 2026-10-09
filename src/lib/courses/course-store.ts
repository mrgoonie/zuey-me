/** Course rows: admin authoring and public catalogue reads. */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { isPlanId } from '../members/plans';
import type { PlanId } from '../members/plans';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, randomId } from '../members/runtime';
import { GITHUB_REPO_RE } from './lesson-blocks';
import type { CourseRecord, CourseStatus } from './course-types';
import {
  COURSE_LEVELS, COURSE_LOCALES, COURSE_STATUSES, optionalText, parseSlug, requiredText, rowToCourse,
} from './course-types';

/** Highest list price accepted ($10,000) to catch cents/dollars mix-ups. */
const MAX_PRICE_CENTS = 1_000_000;

export async function getCourseById(d1: D1DatabaseLike, id: string): Promise<CourseRecord | null> {
  const row = await d1.prepare('SELECT * FROM courses WHERE id = ? AND deleted_at IS NULL').bind(id).first<Row>();
  return row ? rowToCourse(row) : null;
}

export async function getCourseBySlug(d1: D1DatabaseLike, slug: string): Promise<CourseRecord | null> {
  const row = await d1.prepare('SELECT * FROM courses WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<Row>();
  return row ? rowToCourse(row) : null;
}

/** Course by id or slug; 404 when missing (drafts are found too: callers decide visibility). */
export async function requireCourse(d1: D1DatabaseLike, ref: string): Promise<CourseRecord> {
  const course = (await getCourseBySlug(d1, ref)) ?? (await getCourseById(d1, ref));
  if (!course) throw new AppError(404, 'course_not_found', 'Course not found');
  return course;
}

/** Published and archived courses are readable (archived ones stay open to owners but leave the catalog); drafts are admin-only. */
export function isCourseVisible(course: CourseRecord, isAdmin: boolean): boolean {
  return isAdmin || course.status !== 'draft';
}

export async function requireVisibleCourse(d1: D1DatabaseLike, ref: string, isAdmin: boolean): Promise<CourseRecord> {
  const course = await requireCourse(d1, ref);
  if (!isCourseVisible(course, isAdmin)) throw new AppError(404, 'course_not_found', 'Course not found');
  return course;
}

export async function listCourses(d1: D1DatabaseLike, opts: { includeDrafts?: boolean } = {}): Promise<CourseRecord[]> {
  const where = opts.includeDrafts ? 'deleted_at IS NULL' : "deleted_at IS NULL AND status = 'published'";
  const { results } = await d1.prepare(`SELECT * FROM courses WHERE ${where} ORDER BY position, created_at DESC`).all<Row>();
  return (results ?? []).map(rowToCourse);
}

function parsePlanDiscounts(v: unknown): Partial<Record<PlanId, number>> | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new AppError(400, 'invalid_field', 'plan_discounts must be an object {plan: percent} or null', { field: 'plan_discounts' });
  const out: Partial<Record<PlanId, number>> = {};
  for (const [plan, pct] of Object.entries(v)) {
    if (!isPlanId(plan)) throw new AppError(400, 'invalid_field', `Unknown plan "${plan}" in plan_discounts`, { field: 'plan_discounts' });
    if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0 || pct > 90) {
      throw new AppError(400, 'invalid_field', 'plan_discounts values must be integers 0–90', { field: 'plan_discounts' });
    }
    out[plan] = pct;
  }
  return out;
}

function parseStringList(v: unknown, field: string, max: number, maxLen: number, re?: RegExp): string[] {
  if (!Array.isArray(v) || v.length > max) throw new AppError(400, 'invalid_field', `${field} must be an array of at most ${max} strings`, { field });
  return v.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLen || (re && !re.test(item.trim()))) {
      throw new AppError(400, 'invalid_field', `${field} contains an invalid entry`, { field });
    }
    return item.trim();
  });
}

function oneOfField<T extends string>(list: readonly T[], v: unknown, field: string): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) {
    throw new AppError(400, 'invalid_field', `${field} must be one of ${list.join(', ')}`, { field });
  }
  return v as T;
}

/** Slugs taken by sibling pages under /courses (orders, leaderboard, media links). */
const RESERVED_COURSE_SLUGS = new Set(['orders', 'leaderboard', 'media', 'jobs']);

/** Column → value pairs from an untrusted create/update body. */
function courseColumns(body: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  if (creating || body.title !== undefined) cols.title = requiredText(body, 'title', 200);
  if (body.slug !== undefined) {
    cols.slug = parseSlug(body.slug);
    if (RESERVED_COURSE_SLUGS.has(cols.slug as string)) throw new AppError(400, 'invalid_field', 'This slug is reserved for a site page', { field: 'slug' });
  }
  for (const [key, max] of [['subtitle', 300], ['summary', 5_000]] as const) {
    const v = optionalText(body, key, max);
    if (v !== undefined) cols[key] = v;
  }
  const cover = optionalText(body, 'cover_url', 2_048);
  if (cover !== undefined) {
    if (cover && !/^https:\/\//.test(cover)) throw new AppError(400, 'invalid_field', 'cover_url must be an https:// URL', { field: 'cover_url' });
    cols.cover_url = cover || null;
  }
  const note = optionalText(body, 'release_note', 500);
  if (note !== undefined) cols.release_note = note || null;
  if (body.locale !== undefined) cols.locale = oneOfField(COURSE_LOCALES, body.locale, 'locale');
  if (body.level !== undefined) cols.level = oneOfField(COURSE_LEVELS, body.level, 'level');
  if (body.price_usd_cents !== undefined) {
    const p = body.price_usd_cents;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > MAX_PRICE_CENTS) {
      throw new AppError(400, 'invalid_field', `price_usd_cents must be an integer 0–${MAX_PRICE_CENTS}`, { field: 'price_usd_cents' });
    }
    cols.price_usd_cents = p;
  }
  if (body.plan_discounts !== undefined) {
    const d = parsePlanDiscounts(body.plan_discounts);
    cols.plan_discounts_json = d ? JSON.stringify(d) : null;
  }
  if (body.outcomes !== undefined) cols.outcomes_json = JSON.stringify(parseStringList(body.outcomes, 'outcomes', 20, 300));
  if (body.github_repos !== undefined) cols.github_repos_json = JSON.stringify(parseStringList(body.github_repos, 'github_repos', 10, 141, GITHUB_REPO_RE));
  if (body.position !== undefined) {
    if (typeof body.position !== 'number' || !Number.isInteger(body.position)) throw new AppError(400, 'invalid_field', 'position must be an integer', { field: 'position' });
    cols.position = body.position;
  }
  if (body.status !== undefined) cols.status = oneOfField(COURSE_STATUSES, body.status, 'status');
  return cols;
}

export async function createCourse(d1: D1DatabaseLike, body: Record<string, unknown>): Promise<CourseRecord> {
  const cols = courseColumns(body, true);
  if (!cols.slug) throw new AppError(400, 'invalid_field', 'slug is required', { field: 'slug' });
  const now = iso(membersRuntime.now());
  const id = randomId('crs');
  const status = (cols.status as CourseStatus | undefined) ?? 'draft';
  const all: Record<string, unknown> = { id, ...cols, status, created_at: now, updated_at: now, published_at: status === 'published' ? now : null };
  const keys = Object.keys(all);
  try {
    await d1.prepare(`INSERT INTO courses (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => all[k])).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'slug_taken', 'A course with this slug already exists');
    throw err;
  }
  const course = await getCourseById(d1, id);
  if (!course) throw new AppError(500, 'internal_error', 'Course was not persisted');
  return course;
}

export async function updateCourse(d1: D1DatabaseLike, ref: string, body: Record<string, unknown>): Promise<CourseRecord> {
  const course = await requireCourse(d1, ref);
  const cols = courseColumns(body, false);
  const now = iso(membersRuntime.now());
  if (cols.status === 'published' && !course.published_at) cols.published_at = now;
  cols.updated_at = now;
  const keys = Object.keys(cols);
  try {
    await d1.prepare(`UPDATE courses SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => cols[k]), course.id).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'slug_taken', 'A course with this slug already exists');
    throw err;
  }
  return (await getCourseById(d1, course.id)) ?? course;
}

/** Soft delete; refused while anyone owns the course (archive it instead). */
export async function deleteCourse(d1: D1DatabaseLike, ref: string): Promise<{ deleted: true; id: string }> {
  const course = await requireCourse(d1, ref);
  const owners = await d1.prepare("SELECT COUNT(*) AS n FROM course_purchases WHERE course_id = ? AND status = 'active'").bind(course.id).first<Row>();
  if (Number(owners?.n ?? 0) > 0) throw new AppError(409, 'course_has_owners', 'This course has owners; set status to archived instead of deleting it');
  const now = iso(membersRuntime.now());
  await d1.prepare('UPDATE courses SET deleted_at = ?, slug = ?, updated_at = ? WHERE id = ?').bind(now, `${course.slug}--deleted-${course.id}`, now, course.id).run();
  return { deleted: true, id: course.id };
}
