/**
 * Who may read a lesson. Single decision used by the HTML reader, `.md`, REST and MCP:
 * - admins: everything (drafts included);
 * - trial lessons: everyone;
 * - other lessons: owners of the course, in a signed-in browser session, unless an admin locked the account.
 * Personal API keys and OAuth tokens never receive paid lesson bodies (outline and trial lessons only),
 * so a purchase cannot be scraped and re-shared through automation.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { Principal } from '../members/policy';
import type { Row } from '../members/runtime';
import type { CourseRecord, LessonRecord } from './course-types';

export interface CourseViewer {
  userId: string | null;
  isAdmin: boolean;
  owns: boolean;
  locked: boolean;
  /** True when the caller is a browser session (the only credential that unlocks paid lessons). */
  browserSession: boolean;
}

export type LessonDenial = 'sign_in' | 'purchase' | 'locked' | 'browser_only';

export async function ownsCourse(d1: D1DatabaseLike, userId: string, courseId: string): Promise<boolean> {
  const row = await d1.prepare("SELECT 1 AS ok FROM course_purchases WHERE user_id = ? AND course_id = ? AND status = 'active'").bind(userId, courseId).first<Row>();
  return Boolean(row);
}

export async function ownedCourseIds(d1: D1DatabaseLike, userId: string): Promise<Set<string>> {
  const { results } = await d1.prepare("SELECT course_id FROM course_purchases WHERE user_id = ? AND status = 'active'").bind(userId).all<Row>();
  return new Set((results ?? []).map(r => String(r.course_id)));
}

export async function isCourseAccessLocked(d1: D1DatabaseLike, userId: string): Promise<boolean> {
  return Boolean(await d1.prepare('SELECT 1 AS ok FROM course_user_locks WHERE user_id = ?').bind(userId).first<Row>());
}

export async function resolveCourseViewer(d1: D1DatabaseLike, principal: Principal, course: CourseRecord): Promise<CourseViewer> {
  const isAdmin = principal.kind === 'admin';
  const userId = principal.userId;
  const [owns, locked] = userId
    ? await Promise.all([ownsCourse(d1, userId, course.id), isCourseAccessLocked(d1, userId)])
    : [false, false];
  return { userId, isAdmin, owns, locked, browserSession: principal.via === 'member_session' || principal.via === 'studio_session' };
}

/** Null when the lesson may be read; otherwise why not (drives the CTA shown instead). */
export function lessonDenial(viewer: CourseViewer, lesson: Pick<LessonRecord, 'is_trial'>): LessonDenial | null {
  if (viewer.isAdmin || lesson.is_trial) return null;
  if (!viewer.userId) return 'sign_in';
  if (!viewer.owns) return 'purchase';
  if (viewer.locked) return 'locked';
  if (!viewer.browserSession) return 'browser_only';
  return null;
}

export function canReadLesson(viewer: CourseViewer, lesson: Pick<LessonRecord, 'is_trial'>): boolean {
  return lessonDenial(viewer, lesson) === null;
}

export const LESSON_DENIAL_MESSAGES: Record<LessonDenial, string> = {
  sign_in: 'Sign in and buy this course to read this lesson',
  purchase: 'Buy this course to unlock this lesson',
  locked: 'Course access on this account is paused pending review; contact support',
  browser_only: 'Paid lessons are only available in a signed-in browser session at zuey.me (not through API keys)',
};
