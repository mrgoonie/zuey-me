/**
 * Zuey AI as an in-lesson tutor: the chat turn gets the lesson the learner is reading as its first
 * source, followed by the usual knowledge-base passages. The lesson must be readable by the caller;
 * quiz answers never reach the model (only article blocks are used). Normal AI quota applies.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { ContextRetriever, ContextSource } from '../ai/context';
import { documentText, retrieveContext } from '../ai/context';
import { AppError } from '../http';
import type { Principal } from '../members/policy';
import { siteUrl } from '../members/runtime';
import type { RuntimeEnv } from '../../env';
import { requireReadableLesson } from './course-views';
import { lessonArticleDocument, parseStoredLesson } from './lesson-blocks';

/** Lesson text handed to the model; long lessons are cut to keep room for the answer. */
export const TUTOR_LESSON_CHARS = 8_000;

export interface TutorLessonRef { course: string; lesson: string }

export function parseTutorLessonRef(raw: unknown): TutorLessonRef | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'invalid_field', 'course_lesson must be { course, lesson }', { field: 'course_lesson' });
  const { course, lesson } = raw as Record<string, unknown>;
  if (typeof course !== 'string' || !course || typeof lesson !== 'string' || !lesson) {
    throw new AppError(400, 'invalid_field', 'course_lesson must be { course, lesson }', { field: 'course_lesson' });
  }
  return { course, lesson };
}

/** Builds a retriever that pins the lesson as the first source; 403 when the lesson is not readable. */
export async function lessonTutorRetriever(d1: D1DatabaseLike, env: RuntimeEnv, principal: Principal, ref: TutorLessonRef): Promise<ContextRetriever> {
  const { course, lesson } = await requireReadableLesson(d1, principal, ref.course, ref.lesson);
  const doc = parseStoredLesson(lesson.published_json);
  const text = doc ? documentText(lessonArticleDocument(doc)) : '';
  const source: ContextSource = {
    id: lesson.id,
    slug: `${course.slug}/${lesson.slug}`,
    title: `${course.title} — ${lesson.title}`,
    url: `${siteUrl(env)}/courses/${course.slug}/${lesson.slug}`,
    access: lesson.is_trial ? 'free' : 'paid',
    scope: 'full',
    locale: course.locale,
    published_at: lesson.published_at,
    excerpt: lesson.summary,
    text: text.slice(0, TUTOR_LESSON_CHARS),
  };
  return async (p, query, locale, deps) => {
    const rest = await retrieveContext(p, query, locale, { ...deps, limit: 3 });
    return [source, ...rest];
  };
}
