/** Sections and lessons of a course: authoring (draft → publish) and the outline readers see. */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, randomId } from '../members/runtime';
import type { LessonDocument } from './lesson-blocks';
import { emptyLessonDocument, parseStoredLesson, validateLessonDocument } from './lesson-blocks';
import type { CourseRecord, LessonRecord, SectionRecord } from './course-types';
import { optionalText, parseSlug, requiredText, rowToLesson, rowToSection, slugify } from './course-types';

export interface OutlineLesson {
  id: string;
  slug: string;
  title: string;
  summary: string;
  duration_minutes: number;
  is_trial: boolean;
  status: 'draft' | 'published';
  position: number;
}
export interface OutlineSection { id: string; title: string; summary: string; position: number; lessons: OutlineLesson[] }

function toOutlineLesson(l: LessonRecord): OutlineLesson {
  return { id: l.id, slug: l.slug, title: l.title, summary: l.summary, duration_minutes: l.duration_minutes, is_trial: l.is_trial, status: l.status, position: l.position };
}

export async function listSections(d1: D1DatabaseLike, courseId: string): Promise<SectionRecord[]> {
  const { results } = await d1.prepare('SELECT * FROM course_sections WHERE course_id = ? ORDER BY position, created_at').bind(courseId).all<Row>();
  return (results ?? []).map(rowToSection);
}

export async function listLessons(d1: D1DatabaseLike, courseId: string): Promise<LessonRecord[]> {
  const { results } = await d1.prepare('SELECT * FROM course_lessons WHERE course_id = ? ORDER BY position, created_at').bind(courseId).all<Row>();
  return (results ?? []).map(rowToLesson);
}

/**
 * Sections with their lessons in order. Readers only see published lessons (and sections that
 * have one); admins with `includeDrafts` see everything.
 */
export async function courseOutline(d1: D1DatabaseLike, courseId: string, includeDrafts = false): Promise<OutlineSection[]> {
  const [sections, lessons] = await Promise.all([listSections(d1, courseId), listLessons(d1, courseId)]);
  const out: OutlineSection[] = sections.map(s => ({ id: s.id, title: s.title, summary: s.summary, position: s.position, lessons: [] }));
  const byId = new Map(out.map(s => [s.id, s]));
  for (const l of lessons) {
    if (!includeDrafts && l.status !== 'published') continue;
    byId.get(l.section_id)?.lessons.push(toOutlineLesson(l));
  }
  return includeDrafts ? out : out.filter(s => s.lessons.length > 0);
}

/** Published lessons in reading order (section order, then lesson order). */
export function orderedLessons(outline: OutlineSection[]): OutlineLesson[] {
  return outline.flatMap(s => s.lessons);
}

async function requireSection(d1: D1DatabaseLike, course: CourseRecord, sectionId: string): Promise<SectionRecord> {
  const row = await d1.prepare('SELECT * FROM course_sections WHERE id = ? AND course_id = ?').bind(sectionId, course.id).first<Row>();
  if (!row) throw new AppError(404, 'section_not_found', 'Section not found in this course');
  return rowToSection(row);
}

function positionField(body: Record<string, unknown>): number | undefined {
  if (body.position === undefined) return undefined;
  if (typeof body.position !== 'number' || !Number.isInteger(body.position)) throw new AppError(400, 'invalid_field', 'position must be an integer', { field: 'position' });
  return body.position;
}

async function nextPosition(d1: D1DatabaseLike, table: 'course_sections' | 'course_lessons', column: string, id: string): Promise<number> {
  const row = await d1.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ${table} WHERE ${column} = ?`).bind(id).first<Row>();
  return Number(row?.n ?? 0);
}

export async function createSection(d1: D1DatabaseLike, course: CourseRecord, body: Record<string, unknown>): Promise<SectionRecord> {
  const now = iso(membersRuntime.now());
  const id = randomId('sec');
  const position = positionField(body) ?? (await nextPosition(d1, 'course_sections', 'course_id', course.id));
  await d1.prepare('INSERT INTO course_sections (id, course_id, title, summary, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, course.id, requiredText(body, 'title', 200), optionalText(body, 'summary', 2_000) ?? '', position, now, now).run();
  return requireSection(d1, course, id);
}

export async function updateSection(d1: D1DatabaseLike, course: CourseRecord, sectionId: string, body: Record<string, unknown>): Promise<SectionRecord> {
  const section = await requireSection(d1, course, sectionId);
  const title = body.title !== undefined ? requiredText(body, 'title', 200) : section.title;
  const summary = optionalText(body, 'summary', 2_000) ?? section.summary;
  const position = positionField(body) ?? section.position;
  await d1.prepare('UPDATE course_sections SET title = ?, summary = ?, position = ?, updated_at = ? WHERE id = ?')
    .bind(title, summary, position, iso(membersRuntime.now()), section.id).run();
  return requireSection(d1, course, section.id);
}

export async function deleteSection(d1: D1DatabaseLike, course: CourseRecord, sectionId: string): Promise<{ deleted: true }> {
  const section = await requireSection(d1, course, sectionId);
  const n = await d1.prepare('SELECT COUNT(*) AS n FROM course_lessons WHERE section_id = ?').bind(section.id).first<Row>();
  if (Number(n?.n ?? 0) > 0) throw new AppError(409, 'section_not_empty', 'Move or delete the lessons of this section first');
  await d1.prepare('DELETE FROM course_sections WHERE id = ?').bind(section.id).run();
  return { deleted: true };
}

export async function getLesson(d1: D1DatabaseLike, courseId: string, ref: string): Promise<LessonRecord | null> {
  const row = await d1.prepare('SELECT * FROM course_lessons WHERE course_id = ? AND (slug = ? OR id = ?)').bind(courseId, ref, ref).first<Row>();
  return row ? rowToLesson(row) : null;
}

export async function requireLesson(d1: D1DatabaseLike, courseId: string, ref: string): Promise<LessonRecord> {
  const lesson = await getLesson(d1, courseId, ref);
  if (!lesson) throw new AppError(404, 'lesson_not_found', 'Lesson not found');
  return lesson;
}

/** Validates `doc` (lesson document) when present; 400 with every validation error otherwise. */
function parseLessonDoc(v: unknown): LessonDocument {
  const result = validateLessonDocument(v);
  if (!result.ok) throw new AppError(400, 'invalid_document', 'Lesson document is invalid', { errors: result.errors });
  return result.doc;
}

function durationField(body: Record<string, unknown>): number | undefined {
  const v = body.duration_minutes;
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000) throw new AppError(400, 'invalid_field', 'duration_minutes must be an integer 0–1000', { field: 'duration_minutes' });
  return v;
}

function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new AppError(400, 'invalid_field', `${key} must be a boolean`, { field: key });
  return v;
}

export async function createLesson(d1: D1DatabaseLike, course: CourseRecord, body: Record<string, unknown>): Promise<LessonRecord> {
  if (typeof body.section_id !== 'string') throw new AppError(400, 'invalid_field', 'section_id is required', { field: 'section_id' });
  const section = await requireSection(d1, course, body.section_id);
  const title = requiredText(body, 'title', 200);
  const slug = body.slug !== undefined ? parseSlug(body.slug) : slugify(title);
  const doc = body.doc !== undefined ? parseLessonDoc(body.doc) : emptyLessonDocument();
  const now = iso(membersRuntime.now());
  const id = randomId('les');
  const position = positionField(body) ?? (await nextPosition(d1, 'course_lessons', 'course_id', course.id));
  try {
    await d1.prepare(
      `INSERT INTO course_lessons (id, course_id, section_id, slug, title, summary, duration_minutes, is_trial, status, draft_json, revision, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?)`
    ).bind(id, course.id, section.id, slug, title, optionalText(body, 'summary', 2_000) ?? '', durationField(body) ?? 0,
      boolField(body, 'is_trial') ? 1 : 0, JSON.stringify(doc), position, now, now).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'slug_taken', 'A lesson with this slug already exists in this course');
    throw err;
  }
  return requireLesson(d1, course.id, id);
}

/**
 * Updates lesson metadata and/or the draft document. `expected_revision` (optional) guards
 * against overwriting a concurrent edit; every draft change bumps the revision.
 */
export async function updateLesson(d1: D1DatabaseLike, course: CourseRecord, ref: string, body: Record<string, unknown>): Promise<LessonRecord> {
  const lesson = await requireLesson(d1, course.id, ref);
  if (body.expected_revision !== undefined && body.expected_revision !== lesson.revision) {
    throw new AppError(409, 'revision_conflict', `Lesson is at revision ${lesson.revision}`, { revision: lesson.revision });
  }
  const sectionId = typeof body.section_id === 'string' ? (await requireSection(d1, course, body.section_id)).id : lesson.section_id;
  const title = body.title !== undefined ? requiredText(body, 'title', 200) : lesson.title;
  const slug = body.slug !== undefined ? parseSlug(body.slug) : lesson.slug;
  const summary = optionalText(body, 'summary', 2_000) ?? lesson.summary;
  const duration = durationField(body) ?? lesson.duration_minutes;
  const trial = boolField(body, 'is_trial') ?? lesson.is_trial;
  const position = positionField(body) ?? lesson.position;
  const draft = body.doc !== undefined ? JSON.stringify(parseLessonDoc(body.doc)) : lesson.draft_json;
  const revision = draft !== lesson.draft_json ? lesson.revision + 1 : lesson.revision;
  try {
    await d1.prepare(
      `UPDATE course_lessons SET section_id = ?, slug = ?, title = ?, summary = ?, duration_minutes = ?, is_trial = ?, position = ?,
         draft_json = ?, revision = ?, updated_at = ? WHERE id = ?`
    ).bind(sectionId, slug, title, summary, duration, trial ? 1 : 0, position, draft, revision, iso(membersRuntime.now()), lesson.id).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'slug_taken', 'A lesson with this slug already exists in this course');
    throw err;
  }
  return requireLesson(d1, course.id, lesson.id);
}

/** Copies the draft to the published snapshot (the version readers get). */
export async function publishLesson(d1: D1DatabaseLike, course: CourseRecord, ref: string): Promise<LessonRecord> {
  const lesson = await requireLesson(d1, course.id, ref);
  const doc = parseStoredLesson(lesson.draft_json) ?? emptyLessonDocument();
  if (doc.blocks.length === 0) throw new AppError(400, 'empty_lesson', 'Add content to the lesson before publishing it');
  const now = iso(membersRuntime.now());
  await d1.prepare("UPDATE course_lessons SET status = 'published', published_json = draft_json, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?")
    .bind(now, now, lesson.id).run();
  return requireLesson(d1, course.id, lesson.id);
}

export async function unpublishLesson(d1: D1DatabaseLike, course: CourseRecord, ref: string): Promise<LessonRecord> {
  const lesson = await requireLesson(d1, course.id, ref);
  await d1.prepare("UPDATE course_lessons SET status = 'draft', updated_at = ? WHERE id = ?").bind(iso(membersRuntime.now()), lesson.id).run();
  return requireLesson(d1, course.id, lesson.id);
}

export async function deleteLesson(d1: D1DatabaseLike, course: CourseRecord, ref: string): Promise<{ deleted: true }> {
  const lesson = await requireLesson(d1, course.id, ref);
  await d1.prepare('DELETE FROM course_lessons WHERE id = ?').bind(lesson.id).run();
  return { deleted: true };
}
