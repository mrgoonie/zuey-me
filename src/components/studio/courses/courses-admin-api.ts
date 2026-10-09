/**
 * Studio Courses: admin API paths, response narrowing and small formatting helpers shared by every
 * Courses sub-panel. Responses come from our own admin routes; they are narrowed field by field so
 * a shape drift shows up as empty values instead of a crash.
 */
import type { PlanId } from '../../../lib/members/plans';
import { PLAN_IDS } from '../../../lib/members/plans';
import type { AssetRecord, CourseLevel, CourseLocale, CourseRecord, CourseStatus } from '../../../lib/courses/course-types';
import type { OutlineSection } from '../../../lib/courses/course-structure-store';
import type { AdminLessonView } from '../../../lib/courses/course-admin-views';
import type { LessonBlock, LessonDocument } from '../../../lib/courses/lesson-blocks';
import type { ApiResult, Obj } from '../knowledge-studio-kit';
import { isObj, num, objArr, str, strArr, strOrNull } from '../knowledge-studio-kit';

/** Mirrors COURSE_* in course-types (that module pulls server-only helpers, so it is not imported at runtime). */
export const COURSE_STATUSES: readonly CourseStatus[] = ['draft', 'published', 'archived'];
export const COURSE_LEVELS: readonly CourseLevel[] = ['beginner', 'intermediate', 'advanced'];
export const COURSE_LOCALES: readonly CourseLocale[] = ['vi', 'en'];
export { PLAN_IDS };
export type { PlanId };

export const ADMIN_COURSES = '/api/v1/admin/courses';
export const coursePath = (courseId: string) => `${ADMIN_COURSES}/${encodeURIComponent(courseId)}`;
export const lessonPath = (courseId: string, lessonId: string) => `${coursePath(courseId)}/lessons/${encodeURIComponent(lessonId)}`;

export type PlanDiscounts = Partial<Record<PlanId, number>>;

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return list.find(x => x === v) ?? fallback;
}

export function planDiscountsOf(v: unknown): PlanDiscounts {
  const out: PlanDiscounts = {};
  if (!isObj(v)) return out;
  for (const plan of PLAN_IDS) if (typeof v[plan] === 'number') out[plan] = Number(v[plan]);
  return out;
}

export function parseCourse(o: Obj): CourseRecord {
  return {
    id: str(o, 'id'), slug: str(o, 'slug'), title: str(o, 'title'), subtitle: str(o, 'subtitle'), summary: str(o, 'summary'),
    cover_url: strOrNull(o, 'cover_url'),
    locale: oneOf(COURSE_LOCALES, o.locale, 'vi'),
    level: oneOf(COURSE_LEVELS, o.level, 'beginner'),
    price_usd_cents: num(o, 'price_usd_cents'),
    plan_discounts: isObj(o.plan_discounts) ? planDiscountsOf(o.plan_discounts) : null,
    status: oneOf(COURSE_STATUSES, o.status, 'draft'),
    release_note: strOrNull(o, 'release_note'),
    outcomes: strArr(o.outcomes), github_repos: strArr(o.github_repos),
    position: num(o, 'position'),
    created_at: str(o, 'created_at'), updated_at: str(o, 'updated_at'), published_at: strOrNull(o, 'published_at'),
  };
}

export function parseAsset(o: Obj): AssetRecord {
  return {
    id: str(o, 'id'), course_id: str(o, 'course_id'),
    kind: oneOf(['video', 'audio', 'file'] as const, o.kind, 'file'),
    provider: o.provider === 'stream' ? 'stream' : 'r2',
    ref: str(o, 'ref'), name: str(o, 'name'), mime: strOrNull(o, 'mime'),
    size_bytes: typeof o.size_bytes === 'number' ? o.size_bytes : null,
    duration_seconds: typeof o.duration_seconds === 'number' ? o.duration_seconds : null,
    created_at: str(o, 'created_at'),
  };
}

function parseOutline(v: unknown): OutlineSection[] {
  return objArr(v).map(s => ({
    id: str(s, 'id'), title: str(s, 'title'), summary: str(s, 'summary'), position: num(s, 'position'),
    lessons: objArr(s.lessons).map(l => ({
      id: str(l, 'id'), slug: str(l, 'slug'), title: str(l, 'title'), summary: str(l, 'summary'),
      duration_minutes: num(l, 'duration_minutes'), is_trial: l.is_trial === true,
      status: l.status === 'published' ? 'published' : 'draft', position: num(l, 'position'),
    })),
  }));
}

export interface AdminCourseDetail {
  course: CourseRecord;
  effective_plan_discounts: PlanDiscounts;
  outline: OutlineSection[];
  assets: AssetRecord[];
  active_owners: number;
}

export function parseCourseDetail(v: unknown): AdminCourseDetail | null {
  if (!isObj(v) || !isObj(v.course)) return null;
  return {
    course: parseCourse(v.course),
    effective_plan_discounts: planDiscountsOf(v.effective_plan_discounts),
    outline: parseOutline(v.outline),
    assets: objArr(v.assets).map(parseAsset),
    active_owners: num(v, 'active_owners'),
  };
}

/** Lesson documents were validated on write; only the envelope is checked here. */
function lessonDoc(v: unknown): LessonDocument | null {
  if (!isObj(v) || !Array.isArray(v.blocks)) return null;
  return { version: 1, blocks: v.blocks.filter(isObj) as unknown as LessonBlock[] };
}

export function parseLessonView(v: unknown): AdminLessonView | null {
  if (!isObj(v) || !str(v, 'id')) return null;
  return {
    id: str(v, 'id'), course_id: str(v, 'course_id'), section_id: str(v, 'section_id'), slug: str(v, 'slug'),
    title: str(v, 'title'), summary: str(v, 'summary'), duration_minutes: num(v, 'duration_minutes'), is_trial: v.is_trial === true,
    status: v.status === 'published' ? 'published' : 'draft', revision: num(v, 'revision'), position: num(v, 'position'),
    created_at: str(v, 'created_at'), updated_at: str(v, 'updated_at'), published_at: strOrNull(v, 'published_at'),
    draft: lessonDoc(v.draft) ?? { version: 1, blocks: [] },
    published: lessonDoc(v.published),
    has_unpublished_changes: v.has_unpublished_changes === true,
  };
}

/** Multipart upload (R2 assets); same envelope handling as the JSON `api` helper. */
export async function uploadForm(path: string, form: FormData): Promise<ApiResult> {
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form });
    const body: unknown = await res.json().catch(() => null);
    const error = isObj(body) && isObj(body.error) ? body.error : {};
    return {
      ok: res.ok, status: res.status, data: isObj(body) ? body.data : null,
      code: str(error, 'code'), message: str(error, 'message') || (res.ok ? '' : `HTTP ${res.status}`), error,
    };
  } catch {
    return { ok: false, status: 0, data: null, code: 'network', message: 'Network error', error: {} };
  }
}

/** "code: message" for status lines. */
export const errText = (r: ApiResult): string => (r.code ? `${r.code}: ${r.message}` : r.message);

export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/** Dollars typed by the admin → integer cents; null when not a valid non-negative amount. */
export function dollarsToCents(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function bytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Short random id accepted by the lesson validator ([A-Za-z0-9_-]{1,64}). */
export function localId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}
