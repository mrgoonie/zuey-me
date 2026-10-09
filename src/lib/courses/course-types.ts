/** Shared course records and parsing helpers. */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { PlanId } from '../members/plans';
import type { Row } from '../members/runtime';
import { num, str, strOrNull } from '../members/runtime';

export const COURSE_STATUSES = ['draft', 'published', 'archived'] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];
export const COURSE_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type CourseLevel = (typeof COURSE_LEVELS)[number];
export const COURSE_LOCALES = ['vi', 'en'] as const;
export type CourseLocale = (typeof COURSE_LOCALES)[number];

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CourseRecord {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  summary: string;
  cover_url: string | null;
  locale: CourseLocale;
  level: CourseLevel;
  price_usd_cents: number;
  /** Per-course override of the subscriber discount table; null uses the global table. */
  plan_discounts: Partial<Record<PlanId, number>> | null;
  status: CourseStatus;
  release_note: string | null;
  outcomes: string[];
  github_repos: string[];
  position: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface SectionRecord {
  id: string;
  course_id: string;
  title: string;
  summary: string;
  position: number;
}

export interface LessonRecord {
  id: string;
  course_id: string;
  section_id: string;
  slug: string;
  title: string;
  summary: string;
  duration_minutes: number;
  is_trial: boolean;
  status: 'draft' | 'published';
  draft_json: string;
  published_json: string | null;
  revision: number;
  position: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface AssetRecord {
  id: string;
  course_id: string;
  kind: 'video' | 'audio' | 'file';
  provider: 'stream' | 'r2';
  ref: string;
  name: string;
  mime: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  created_at: string;
}

function jsonOr<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function rowToCourse(r: Row): CourseRecord {
  return {
    id: str(r, 'id'),
    slug: str(r, 'slug'),
    title: str(r, 'title'),
    subtitle: str(r, 'subtitle'),
    summary: str(r, 'summary'),
    cover_url: strOrNull(r, 'cover_url'),
    locale: oneOf(COURSE_LOCALES, r.locale, 'vi'),
    level: oneOf(COURSE_LEVELS, r.level, 'beginner'),
    price_usd_cents: num(r, 'price_usd_cents'),
    plan_discounts: jsonOr<Partial<Record<PlanId, number>> | null>(r.plan_discounts_json, null),
    status: oneOf(COURSE_STATUSES, r.status, 'draft'),
    release_note: strOrNull(r, 'release_note'),
    outcomes: jsonOr<string[]>(r.outcomes_json, []),
    github_repos: jsonOr<string[]>(r.github_repos_json, []),
    position: num(r, 'position'),
    created_at: str(r, 'created_at'),
    updated_at: str(r, 'updated_at'),
    published_at: strOrNull(r, 'published_at'),
  };
}

export function rowToSection(r: Row): SectionRecord {
  return { id: str(r, 'id'), course_id: str(r, 'course_id'), title: str(r, 'title'), summary: str(r, 'summary'), position: num(r, 'position') };
}

export function rowToLesson(r: Row): LessonRecord {
  return {
    id: str(r, 'id'),
    course_id: str(r, 'course_id'),
    section_id: str(r, 'section_id'),
    slug: str(r, 'slug'),
    title: str(r, 'title'),
    summary: str(r, 'summary'),
    duration_minutes: num(r, 'duration_minutes'),
    is_trial: num(r, 'is_trial') === 1,
    status: str(r, 'status') === 'published' ? 'published' : 'draft',
    draft_json: str(r, 'draft_json'),
    published_json: strOrNull(r, 'published_json'),
    revision: num(r, 'revision'),
    position: num(r, 'position'),
    created_at: str(r, 'created_at'),
    updated_at: str(r, 'updated_at'),
    published_at: strOrNull(r, 'published_at'),
  };
}

export function rowToAsset(r: Row): AssetRecord {
  const size = r.size_bytes;
  const duration = r.duration_seconds;
  return {
    id: str(r, 'id'),
    course_id: str(r, 'course_id'),
    kind: oneOf(['video', 'audio', 'file'] as const, r.kind, 'file'),
    provider: str(r, 'provider') === 'stream' ? 'stream' : 'r2',
    ref: str(r, 'ref'),
    name: str(r, 'name'),
    mime: strOrNull(r, 'mime'),
    size_bytes: size === null || size === undefined ? null : Number(size),
    duration_seconds: duration === null || duration === undefined ? null : Number(duration),
    created_at: str(r, 'created_at'),
  };
}

export function requireCoursesDb(env: RuntimeEnv): D1DatabaseLike {
  if (!env.DB) throw new AppError(503, 'db_unavailable', 'Courses require the D1 database binding (DB)');
  return env.DB;
}

/** Reads an optional trimmed string field; throws 400 on wrong type or length. */
export function optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return '';
  if (typeof v !== 'string') throw new AppError(400, 'invalid_field', `${key} must be a string`, { field: key });
  const t = v.trim();
  if (t.length > max) throw new AppError(400, 'invalid_field', `${key} must be at most ${max} characters`, { field: key });
  return t;
}

export function requiredText(body: Record<string, unknown>, key: string, max: number): string {
  const v = optionalText(body, key, max);
  if (!v) throw new AppError(400, 'invalid_field', `${key} is required`, { field: key });
  return v;
}

export function parseSlug(v: unknown, field = 'slug'): string {
  if (typeof v !== 'string' || v.length > 80 || !SLUG_RE.test(v)) {
    throw new AppError(400, 'invalid_field', `${field} must be lowercase letters, digits and dashes`, { field });
  }
  return v;
}

/** Lowercase ASCII slug from a (Vietnamese) title. */
export function slugify(title: string): string {
  return title
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'bai-hoc';
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
