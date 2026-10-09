/**
 * Lesson documents: the article block schema plus course-only widgets at the top level
 * (quiz, private media, GitHub repository). Article blocks are validated by the shared validator;
 * widgets are validated here. Quiz answers live only in the stored document and are stripped by
 * `publicLessonDocument` before anything reaches a browser, the Markdown view or an agent.
 */
import type { ArticleDocument, Block } from '../blocks/schema';
import { walkBlocks } from '../blocks/schema';
import type { ValidationError } from '../blocks/validate';
import { validateDocument } from '../blocks/validate';

export const QUIZ_KINDS = ['single', 'multiple', 'true_false'] as const;
export type QuizKind = (typeof QUIZ_KINDS)[number];

export const QUIZ_LIMITS = { questions: 30, options: 8, prompt: 1_000, option: 300, explanation: 2_000 } as const;
export const TRUE_FALSE_OPTIONS = [{ id: 'true', label: 'Đúng' }, { id: 'false', label: 'Sai' }] as const;

export interface QuizOption { id: string; label: string }
export interface QuizQuestion {
  id: string;
  kind: QuizKind;
  prompt: string;
  options: QuizOption[];
  /** Ids of the correct options (exactly one for single/true_false). Never sent to clients. */
  correct: string[];
  /** Shown after an answer is graded. Never sent before grading. */
  explanation?: string;
}
export interface QuizBlock { id: string; type: 'quiz'; title?: string; passPercent: number; questions: QuizQuestion[] }
export interface CourseMediaBlock { id: string; type: 'course_media'; assetId: string; title?: string; caption?: string }
export interface GithubRepoBlock { id: string; type: 'github_repo'; repo: string; title?: string; description?: string }

export type CourseWidget = QuizBlock | CourseMediaBlock | GithubRepoBlock;
export type LessonBlock = Block | CourseWidget;
export interface LessonDocument { version: 1; blocks: LessonBlock[] }

/** Quiz as shown to learners: no correct answers and no explanations. */
export interface PublicQuizQuestion { id: string; kind: QuizKind; prompt: string; options: QuizOption[] }
export interface PublicQuizBlock { id: string; type: 'quiz'; title?: string; passPercent: number; questions: PublicQuizQuestion[] }
export type PublicLessonBlock = Block | PublicQuizBlock | CourseMediaBlock | GithubRepoBlock;
export interface PublicLessonDocument { version: 1; blocks: PublicLessonBlock[] }

export const COURSE_WIDGET_TYPES = ['quiz', 'course_media', 'github_repo'] as const;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

type Obj = Record<string, unknown>;
type LessonValidation = { ok: true; doc: LessonDocument } | { ok: false; errors: ValidationError[] };

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isCourseWidget(block: { type: string }): block is CourseWidget {
  return (COURSE_WIDGET_TYPES as readonly string[]).includes(block.type);
}

function genId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function optStr(o: Obj, key: string, path: string, max: number, errors: ValidationError[]): string | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') { errors.push({ path: `${path}.${key}`, message: 'must be a string' }); return undefined; }
  if (v.length > max) { errors.push({ path: `${path}.${key}`, message: `must be at most ${max} characters` }); return undefined; }
  return v;
}

function reqStr(o: Obj, key: string, path: string, max: number, errors: ValidationError[]): string | undefined {
  const v = o[key];
  if (typeof v !== 'string' || !v.trim()) { errors.push({ path: `${path}.${key}`, message: 'is required' }); return undefined; }
  if (v.length > max) { errors.push({ path: `${path}.${key}`, message: `must be at most ${max} characters` }); return undefined; }
  return v;
}

function blockId(o: Obj, path: string, ids: Set<string>, errors: ValidationError[], prefix: string): string {
  const raw = o.id;
  if (raw === undefined || raw === null || raw === '') {
    let id = genId(prefix);
    while (ids.has(id)) id = genId(prefix);
    ids.add(id);
    return id;
  }
  if (typeof raw !== 'string' || !ID_RE.test(raw)) { errors.push({ path: `${path}.id`, message: 'must match [A-Za-z0-9_-]{1,64}' }); return ''; }
  if (ids.has(raw)) errors.push({ path: `${path}.id`, message: `duplicate id "${raw}"` });
  ids.add(raw);
  return raw;
}

function validateQuestion(q: unknown, path: string, ids: Set<string>, errors: ValidationError[]): QuizQuestion | null {
  if (!isObj(q)) { errors.push({ path, message: 'must be an object' }); return null; }
  const before = errors.length;
  const id = blockId(q, path, ids, errors, 'q_');
  const kind = QUIZ_KINDS.find(k => k === (q.kind ?? 'single'));
  if (!kind) {
    errors.push({ path: `${path}.kind`, message: `must be one of ${QUIZ_KINDS.join(', ')}` });
    return null;
  }
  const prompt = reqStr(q, 'prompt', path, QUIZ_LIMITS.prompt, errors);
  const explanation = optStr(q, 'explanation', path, QUIZ_LIMITS.explanation, errors);
  let options: QuizOption[] = [];
  if (kind === 'true_false') {
    options = TRUE_FALSE_OPTIONS.map(o => ({ ...o }));
  } else if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > QUIZ_LIMITS.options) {
    errors.push({ path: `${path}.options`, message: `must contain 2–${QUIZ_LIMITS.options} options` });
  } else {
    const optionIds = new Set<string>();
    q.options.forEach((opt, i) => {
      const p = `${path}.options[${i}]`;
      const o: Obj = typeof opt === 'string' ? { label: opt } : isObj(opt) ? opt : {};
      const label = reqStr(o, 'label', p, QUIZ_LIMITS.option, errors);
      const oid = blockId(o, p, optionIds, errors, 'o_');
      if (label && oid) options.push({ id: oid, label });
    });
  }
  const rawCorrect = Array.isArray(q.correct) ? q.correct : q.correct === undefined ? [] : [q.correct];
  const correct = rawCorrect.map(c => (typeof c === 'boolean' ? String(c) : c)).filter((c): c is string => typeof c === 'string');
  const known = new Set(options.map(o => o.id));
  if (correct.length === 0 || correct.length !== rawCorrect.length) {
    errors.push({ path: `${path}.correct`, message: 'must list the id(s) of the correct option(s)' });
  } else if (correct.some(c => !known.has(c))) {
    errors.push({ path: `${path}.correct`, message: 'references an unknown option id' });
  } else if (kind !== 'multiple' && correct.length !== 1) {
    errors.push({ path: `${path}.correct`, message: `${kind} questions have exactly one correct option` });
  }
  if (errors.length > before || !prompt) return null;
  return { id, kind, prompt, options, correct: [...new Set(correct)], ...(explanation ? { explanation } : {}) };
}

function validateWidget(b: Obj, path: string, ids: Set<string>, errors: ValidationError[]): CourseWidget | null {
  const before = errors.length;
  const id = blockId(b, path, ids, errors, 'b_');
  if (b.type === 'quiz') {
    const title = optStr(b, 'title', path, 300, errors);
    const pass = b.passPercent ?? 70;
    if (typeof pass !== 'number' || !Number.isInteger(pass) || pass < 0 || pass > 100) {
      errors.push({ path: `${path}.passPercent`, message: 'must be an integer 0–100' });
    }
    if (!Array.isArray(b.questions) || b.questions.length < 1 || b.questions.length > QUIZ_LIMITS.questions) {
      errors.push({ path: `${path}.questions`, message: `must contain 1–${QUIZ_LIMITS.questions} questions` });
      return null;
    }
    const questionIds = new Set<string>();
    const questions = b.questions.map((q, i) => validateQuestion(q, `${path}.questions[${i}]`, questionIds, errors));
    if (errors.length > before) return null;
    return { id, type: 'quiz', ...(title ? { title } : {}), passPercent: typeof pass === 'number' ? pass : 70, questions: questions.filter((q): q is QuizQuestion => q !== null) };
  }
  if (b.type === 'course_media') {
    const assetId = reqStr(b, 'assetId', path, 64, errors);
    const title = optStr(b, 'title', path, 300, errors);
    const caption = optStr(b, 'caption', path, 1_000, errors);
    if (errors.length > before || !assetId) return null;
    return { id, type: 'course_media', assetId, ...(title ? { title } : {}), ...(caption ? { caption } : {}) };
  }
  const repo = reqStr(b, 'repo', path, 141, errors);
  if (repo && !GITHUB_REPO_RE.test(repo)) errors.push({ path: `${path}.repo`, message: 'must be "owner/name"' });
  const title = optStr(b, 'title', path, 300, errors);
  const description = optStr(b, 'description', path, 1_000, errors);
  if (errors.length > before || !repo) return null;
  return { id, type: 'github_repo', repo, ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

/**
 * Validates an untrusted lesson document. Article blocks go through the shared validator in one
 * pass (so their ids stay unique); error paths are mapped back to the lesson's block indexes.
 */
export function validateLessonDocument(input: unknown): LessonValidation {
  if (!isObj(input) || !Array.isArray(input.blocks)) {
    return { ok: false, errors: [{ path: '$', message: 'lesson must be an object {version: 1, blocks: []}' }] };
  }
  if (input.version !== undefined && input.version !== 1) return { ok: false, errors: [{ path: '$.version', message: 'must be 1' }] };
  const raw = input.blocks;
  const articleIndexes: number[] = [];
  const articleBlocks: unknown[] = [];
  raw.forEach((b, i) => {
    if (isObj(b) && typeof b.type === 'string' && (COURSE_WIDGET_TYPES as readonly string[]).includes(b.type)) return;
    articleIndexes.push(i);
    articleBlocks.push(b);
  });
  const errors: ValidationError[] = [];
  const article = validateDocument({ version: 1, blocks: articleBlocks });
  if (!article.ok) {
    for (const e of article.errors) {
      errors.push({ path: e.path.replace(/^\$\.blocks\[(\d+)\]/, (_, k: string) => `$.blocks[${articleIndexes[Number(k)] ?? k}]`), message: e.message });
    }
  }
  const ids = new Set<string>();
  if (article.ok) walkBlocks(article.doc.blocks, b => ids.add(b.id));
  const out: LessonBlock[] = [];
  let a = 0;
  raw.forEach((b, i) => {
    if (isObj(b) && typeof b.type === 'string' && (COURSE_WIDGET_TYPES as readonly string[]).includes(b.type)) {
      const w = validateWidget(b, `$.blocks[${i}]`, ids, errors);
      if (w) out.push(w);
    } else if (article.ok) {
      out.push(article.doc.blocks[a++]);
    }
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, doc: { version: 1, blocks: out } };
}

/** Removes answers and explanations from every quiz. */
export function publicLessonDocument(doc: LessonDocument): PublicLessonDocument {
  return {
    version: 1,
    blocks: doc.blocks.map(b => b.type === 'quiz'
      ? { id: b.id, type: 'quiz', ...(b.title ? { title: b.title } : {}), passPercent: b.passPercent, questions: b.questions.map(q => ({ id: q.id, kind: q.kind, prompt: q.prompt, options: q.options })) }
      : b),
  };
}

export function findQuiz(doc: LessonDocument, blockId: string): QuizBlock | null {
  for (const b of doc.blocks) if (b.type === 'quiz' && b.id === blockId) return b;
  return null;
}

/** Asset ids referenced by media widgets (used to authorize signed media URLs). */
export function referencedAssetIds(doc: LessonDocument): string[] {
  return doc.blocks.flatMap(b => (b.type === 'course_media' ? [b.assetId] : []));
}

/** Splits a lesson into runs of article blocks and single widgets, preserving order. */
export function lessonSegments<T extends { type: string }>(blocks: T[]): Array<{ kind: 'article'; blocks: Block[] } | { kind: 'widget'; block: T }> {
  const out: Array<{ kind: 'article'; blocks: Block[] } | { kind: 'widget'; block: T }> = [];
  for (const b of blocks) {
    if (isCourseWidget(b)) { out.push({ kind: 'widget', block: b }); continue; }
    const last = out[out.length - 1];
    if (last && last.kind === 'article') last.blocks.push(b as unknown as Block);
    else out.push({ kind: 'article', blocks: [b as unknown as Block] });
  }
  return out;
}

/** The article-block part of a lesson, for search text and AI tutor context. */
export function lessonArticleDocument(doc: LessonDocument | PublicLessonDocument): ArticleDocument {
  return { version: 1, blocks: doc.blocks.filter(b => !isCourseWidget(b)) as Block[] };
}

/** Reads a stored lesson; it was validated on write, so only the envelope is checked here. */
export function parseStoredLesson(json: string | null): LessonDocument | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isObj(parsed) || !Array.isArray(parsed.blocks)) return null;
    return { version: 1, blocks: parsed.blocks as LessonBlock[] };
  } catch {
    return null;
  }
}

export function emptyLessonDocument(): LessonDocument {
  return { version: 1, blocks: [] };
}
