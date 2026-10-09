/**
 * What learners, pages, REST and MCP see of a course: catalog cards, the course page (outline,
 * personal price, ownership, progress) and a lesson (body only when readable, quiz answers stripped).
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Principal } from '../members/policy';
import { consumeRateLimit, recordLearnerSignal } from './course-abuse-guards';
import type { CourseViewer, LessonDenial } from './course-access';
import { LESSON_DENIAL_MESSAGES, lessonDenial, ownedCourseIds, resolveCourseViewer } from './course-access';
import { getAsset } from './course-asset-store';
import type { CourseProgress } from './course-learning';
import { courseProgress, markLessonStarted } from './course-learning';
import type { SignedMedia } from './course-media-signing';
import { ANONYMOUS_VIEWER, signAssetUrl } from './course-media-signing';
import { quoteForUser } from './course-orders';
import type { CourseQuote } from './course-pricing';
import { getPlanDiscountTable, quoteCoursePrice } from './course-pricing';
import { listCourses, requireVisibleCourse } from './course-store';
import type { OutlineLesson, OutlineSection } from './course-structure-store';
import { courseOutline, orderedLessons, requireLesson } from './course-structure-store';
import type { CourseRecord } from './course-types';
import type { PublicLessonDocument } from './lesson-blocks';
import { parseStoredLesson, publicLessonDocument, referencedAssetIds } from './lesson-blocks';
import { parseUsdVndRate } from '../members/plans';

export interface CourseCard {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  summary: string;
  cover_url: string | null;
  level: string;
  locale: string;
  status: string;
  release_note: string | null;
  lesson_count: number;
  trial_lesson_count: number;
  duration_minutes: number;
  price: CourseQuote;
  owned: boolean;
  url: string;
}

function card(course: CourseRecord, outline: OutlineSection[], quote: CourseQuote, owned: boolean): CourseCard {
  const lessons = orderedLessons(outline).filter(l => l.status === 'published');
  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    subtitle: course.subtitle,
    summary: course.summary,
    cover_url: course.cover_url,
    level: course.level,
    locale: course.locale,
    status: course.status,
    release_note: course.release_note,
    lesson_count: lessons.length,
    trial_lesson_count: lessons.filter(l => l.is_trial).length,
    duration_minutes: lessons.reduce((sum, l) => sum + l.duration_minutes, 0),
    price: quote,
    owned,
    url: `/courses/${course.slug}`,
  };
}

export async function courseCatalog(d1: D1DatabaseLike, env: RuntimeEnv, principal: Principal): Promise<CourseCard[]> {
  const isAdmin = principal.kind === 'admin';
  const [courses, table, owned] = await Promise.all([
    listCourses(d1, { includeDrafts: isAdmin }),
    getPlanDiscountTable(d1),
    principal.userId ? ownedCourseIds(d1, principal.userId) : Promise.resolve(new Set<string>()),
  ]);
  const rate = parseUsdVndRate(env);
  return Promise.all(courses.map(async c => {
    const outline = await courseOutline(d1, c.id, isAdmin);
    const quote = quoteCoursePrice({ course: c, table, activePlans: principal.plans, referralPct: 0, usdVndRate: rate });
    return card(c, outline, quote, owned.has(c.id));
  }));
}

export interface CourseDetail extends CourseCard {
  outcomes: string[];
  github_repos: string[];
  outline: Array<Omit<OutlineSection, 'lessons'> & { lessons: Array<OutlineLesson & { locked: boolean }> }>;
  viewer: { signed_in: boolean; owns: boolean; locked: boolean; is_admin: boolean };
  progress: CourseProgress | null;
}

export async function courseDetail(d1: D1DatabaseLike, env: RuntimeEnv, principal: Principal, ref: string): Promise<CourseDetail> {
  const isAdmin = principal.kind === 'admin';
  const course = await requireVisibleCourse(d1, ref, isAdmin);
  const [viewer, outline, quote] = await Promise.all([
    resolveCourseViewer(d1, principal, course),
    courseOutline(d1, course.id, isAdmin),
    quoteForUser(d1, env, course, principal.userId),
  ]);
  const progress = principal.userId ? await courseProgress(d1, principal.userId, course.id) : null;
  return {
    ...card(course, outline, quote, viewer.owns),
    outcomes: course.outcomes,
    github_repos: viewer.owns || isAdmin ? course.github_repos : [],
    outline: outline.map(s => ({ ...s, lessons: s.lessons.map(l => ({ ...l, locked: lessonDenial({ ...viewer, browserSession: true }, l) !== null })) })),
    viewer: { signed_in: principal.userId !== null, owns: viewer.owns, locked: viewer.locked, is_admin: isAdmin },
    progress,
  };
}

export interface LessonView {
  course: { id: string; slug: string; title: string };
  lesson: OutlineLesson & { section_id: string };
  denial: LessonDenial | null;
  denial_message: string | null;
  document: PublicLessonDocument | null;
  previous: { slug: string; title: string } | null;
  next: { slug: string; title: string } | null;
  completed: boolean;
}

/**
 * Loads a lesson for the caller. Paid lessons count against the per-user read limit and record
 * a location signal; drafts are visible to admins only.
 */
export async function lessonView(
  d1: D1DatabaseLike, env: RuntimeEnv, principal: Principal, courseRef: string, lessonRef: string, request?: Request,
): Promise<LessonView> {
  const isAdmin = principal.kind === 'admin';
  const course = await requireVisibleCourse(d1, courseRef, isAdmin);
  const lesson = await requireLesson(d1, course.id, lessonRef);
  if (lesson.status !== 'published' && !isAdmin) throw new AppError(404, 'lesson_not_found', 'Lesson not found');
  const viewer = await resolveCourseViewer(d1, principal, course);
  const denial = lessonDenial(viewer, lesson);
  let document: PublicLessonDocument | null = null;
  if (!denial) {
    if (!lesson.is_trial && !isAdmin && viewer.userId) {
      await consumeRateLimit(d1, 'lesson', viewer.userId);
      if (request) await recordLearnerSignal(d1, env, viewer.userId, request);
    }
    const stored = parseStoredLesson(isAdmin && lesson.status !== 'published' ? lesson.draft_json : lesson.published_json);
    document = stored ? publicLessonDocument(stored) : { version: 1, blocks: [] };
    if (viewer.userId && lesson.status === 'published') await markLessonStarted(d1, viewer.userId, lesson);
  }
  const order = orderedLessons(await courseOutline(d1, course.id, isAdmin));
  const idx = order.findIndex(l => l.id === lesson.id);
  const nav = (l: OutlineLesson | undefined) => (l ? { slug: l.slug, title: l.title } : null);
  const progress = viewer.userId ? await courseProgress(d1, viewer.userId, course.id) : null;
  return {
    course: { id: course.id, slug: course.slug, title: course.title },
    lesson: {
      id: lesson.id, slug: lesson.slug, title: lesson.title, summary: lesson.summary, duration_minutes: lesson.duration_minutes,
      is_trial: lesson.is_trial, status: lesson.status, position: lesson.position, section_id: lesson.section_id,
    },
    denial,
    denial_message: denial ? LESSON_DENIAL_MESSAGES[denial] : null,
    document,
    previous: idx > 0 ? nav(order[idx - 1]) : null,
    next: idx >= 0 ? nav(order[idx + 1]) : null,
    completed: progress?.completed_lesson_ids.includes(lesson.id) ?? false,
  };
}

/** Readable lesson for learning actions (complete, quiz, media); throws the denial as 403. */
export async function requireReadableLesson(d1: D1DatabaseLike, principal: Principal, courseRef: string, lessonRef: string) {
  const isAdmin = principal.kind === 'admin';
  const course = await requireVisibleCourse(d1, courseRef, isAdmin);
  const lesson = await requireLesson(d1, course.id, lessonRef);
  if (lesson.status !== 'published' && !isAdmin) throw new AppError(404, 'lesson_not_found', 'Lesson not found');
  const viewer: CourseViewer = await resolveCourseViewer(d1, principal, course);
  const denial = lessonDenial(viewer, lesson);
  if (denial) throw new AppError(denial === 'sign_in' ? 401 : 403, `lesson_${denial}`, LESSON_DENIAL_MESSAGES[denial], { purchase_url: `/courses/${course.slug}` });
  return { course, lesson, viewer };
}

/** Short-lived URL for a media widget of a readable lesson; the asset must be referenced by that lesson. */
export async function signLessonMedia(
  d1: D1DatabaseLike, env: RuntimeEnv, principal: Principal, courseRef: string, lessonRef: string, assetId: unknown,
): Promise<SignedMedia> {
  if (typeof assetId !== 'string' || !assetId) throw new AppError(400, 'invalid_field', 'asset_id is required', { field: 'asset_id' });
  const { course, lesson, viewer } = await requireReadableLesson(d1, principal, courseRef, lessonRef);
  const doc = parseStoredLesson(viewer.isAdmin && lesson.status !== 'published' ? lesson.draft_json : lesson.published_json);
  if (!doc || !referencedAssetIds(doc).includes(assetId)) throw new AppError(404, 'asset_not_found', 'This lesson has no such media');
  const asset = await getAsset(d1, assetId);
  if (!asset || asset.course_id !== course.id) throw new AppError(404, 'asset_not_found', 'This lesson has no such media');
  if (viewer.userId && !viewer.isAdmin) await consumeRateLimit(d1, 'media', viewer.userId);
  return signAssetUrl(env, asset, viewer.userId ?? ANONYMOUS_VIEWER);
}
