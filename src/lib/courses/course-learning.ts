/**
 * Learner progress and server-side quiz grading. Callers authorize the lesson first (canReadLesson);
 * this module records progress, awards XP/badges once, extends the streak and issues certificates.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, randomId, str } from '../members/runtime';
import type { CertificateView } from './course-certificates';
import { courseCompletion, maybeIssueCertificate } from './course-certificates';
import { awardBadge, awardXp, touchStreak } from './course-gamification';
import type { CourseRecord, LessonRecord } from './course-types';
import type { QuizBlock } from './lesson-blocks';
import { findQuiz, parseStoredLesson } from './lesson-blocks';

export interface CourseProgress {
  course_id: string;
  total_lessons: number;
  completed_lessons: number;
  percent: number;
  completed_lesson_ids: string[];
  started_lesson_ids: string[];
}

export async function courseProgress(d1: D1DatabaseLike, userId: string, courseId: string): Promise<CourseProgress> {
  const [{ total, completed }, rows] = await Promise.all([
    courseCompletion(d1, userId, courseId),
    d1.prepare('SELECT lesson_id, status FROM lesson_progress WHERE user_id = ? AND course_id = ?').bind(userId, courseId).all<Row>(),
  ]);
  const list = rows.results ?? [];
  return {
    course_id: courseId,
    total_lessons: total,
    completed_lessons: completed,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    completed_lesson_ids: list.filter(r => r.status === 'completed').map(r => str(r, 'lesson_id')),
    started_lesson_ids: list.filter(r => r.status === 'started').map(r => str(r, 'lesson_id')),
  };
}

/** Marks a lesson opened (no XP); keeps an existing completion. */
export async function markLessonStarted(d1: D1DatabaseLike, userId: string, lesson: LessonRecord): Promise<void> {
  await d1.prepare(
    `INSERT INTO lesson_progress (user_id, lesson_id, course_id, status, started_at) VALUES (?, ?, ?, 'started', ?)
     ON CONFLICT (user_id, lesson_id) DO NOTHING`
  ).bind(userId, lesson.id, lesson.course_id, iso(membersRuntime.now())).run();
}

export interface CompletionResult {
  progress: CourseProgress;
  xp_awarded: number;
  streak: number;
  certificate: CertificateView | null;
}

export async function completeLesson(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, course: CourseRecord, lesson: LessonRecord): Promise<CompletionResult> {
  if (lesson.status !== 'published') throw new AppError(409, 'lesson_not_published', 'Only published lessons can be completed');
  const now = iso(membersRuntime.now());
  await d1.prepare(
    `INSERT INTO lesson_progress (user_id, lesson_id, course_id, status, started_at, completed_at) VALUES (?, ?, ?, 'completed', ?, ?)
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET status = 'completed', completed_at = COALESCE(lesson_progress.completed_at, excluded.completed_at)`
  ).bind(userId, lesson.id, course.id, now, now).run();
  let xp = 0;
  if (await awardXp(d1, userId, 'lesson_completed', lesson.id, `lesson:${userId}:${lesson.id}`)) {
    xp += 10;
    await awardBadge(d1, userId, 'first_lesson');
  }
  const streak = await touchStreak(d1, userId);
  const certificate = await maybeIssueCertificate(d1, env, userId, course);
  if (certificate) {
    if (await awardXp(d1, userId, 'course_completed', course.id, `course:${userId}:${course.id}`)) xp += 100;
    await awardBadge(d1, userId, 'course_complete');
  }
  return { progress: await courseProgress(d1, userId, course.id), xp_awarded: xp, streak, certificate };
}

export interface QuestionResult { id: string; correct: boolean; chosen: string[]; correct_options: string[]; explanation: string | null }
export interface QuizResult {
  block_id: string;
  score: number;
  total: number;
  percent: number;
  passed: boolean;
  pass_percent: number;
  questions: QuestionResult[];
  xp_awarded: number;
}

function parseAnswers(raw: unknown, quiz: QuizBlock): Map<string, string[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError(400, 'invalid_field', 'answers must be an object of { questionId: optionId | optionId[] }', { field: 'answers' });
  }
  const out = new Map<string, string[]>();
  for (const q of quiz.questions) {
    const v = (raw as Record<string, unknown>)[q.id];
    const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
    out.set(q.id, [...new Set(list.map(x => (typeof x === 'boolean' ? String(x) : x)).filter((x): x is string => typeof x === 'string'))].slice(0, 20));
  }
  return out;
}

/** Grades one quiz on the server; answers and explanations are only revealed after submission. */
export function gradeQuiz(quiz: QuizBlock, rawAnswers: unknown): Omit<QuizResult, 'xp_awarded'> {
  const answers = parseAnswers(rawAnswers, quiz);
  const questions = quiz.questions.map(q => {
    const chosen = answers.get(q.id) ?? [];
    const expected = new Set(q.correct);
    const correct = chosen.length === expected.size && chosen.every(c => expected.has(c));
    return { id: q.id, correct, chosen, correct_options: q.correct, explanation: q.explanation ?? null };
  });
  const score = questions.filter(q => q.correct).length;
  const total = questions.length;
  const percent = total === 0 ? 0 : Math.round((score / total) * 100);
  return { block_id: quiz.id, score, total, percent, passed: percent >= quiz.passPercent, pass_percent: quiz.passPercent, questions };
}

export async function submitQuiz(d1: D1DatabaseLike, userId: string, lesson: LessonRecord, blockId: string, rawAnswers: unknown): Promise<QuizResult> {
  const doc = parseStoredLesson(lesson.published_json);
  const quiz = doc ? findQuiz(doc, blockId) : null;
  if (!quiz) throw new AppError(404, 'quiz_not_found', 'Quiz not found in this lesson');
  const graded = gradeQuiz(quiz, rawAnswers);
  await d1.prepare(
    'INSERT INTO quiz_attempts (id, user_id, lesson_id, block_id, answers_json, correct, score, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(randomId('qa'), userId, lesson.id, quiz.id, JSON.stringify(graded.questions.map(q => ({ id: q.id, chosen: q.chosen }))),
    graded.passed ? 1 : 0, graded.score, graded.total, iso(membersRuntime.now())).run();
  let xp = 0;
  if (graded.passed) {
    // XP once per quiz, however many attempts it takes.
    if (await awardXp(d1, userId, 'quiz_passed', `${lesson.id}#${quiz.id}`, `quiz:${userId}:${lesson.id}:${quiz.id}`)) {
      xp += 20;
      await awardBadge(d1, userId, 'first_quiz');
    }
    if (graded.score === graded.total && (await awardXp(d1, userId, 'quiz_perfect', `${lesson.id}#${quiz.id}`, `quizperfect:${userId}:${lesson.id}:${quiz.id}`))) {
      xp += 10;
      await awardBadge(d1, userId, 'perfect_quiz');
    }
    await touchStreak(d1, userId);
  }
  return { ...graded, xp_awarded: xp };
}
