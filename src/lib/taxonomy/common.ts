import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { LOCALES, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';

export type Row = Record<string, unknown>;
/** Localized display names keyed by site locale. */
export type LocalizedNames = Partial<Record<Locale, string>>;

export function requireDb(d1: D1DatabaseLike | undefined): D1DatabaseLike {
  if (!d1) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  return d1;
}

export function newId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function str(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

export function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

export function num(row: Row, key: string, fallback = 0): number {
  const v = row[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseNames(text: unknown): LocalizedNames {
  const raw = parseJson(text);
  const out: LocalizedNames = {};
  if (!isObj(raw)) return out;
  for (const locale of LOCALES) {
    const v = raw[locale];
    if (typeof v === 'string' && v.trim()) out[locale] = v;
  }
  return out;
}

export function parseStringArray(text: unknown): string[] {
  const raw = parseJson(text);
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/** Display name for a locale: exact locale, then English, Vietnamese, any, then the slug. */
export function localizedName(names: LocalizedNames, locale: Locale, fallback: string): string {
  return names[locale] ?? names.en ?? names.vi ?? Object.values(names).find(Boolean) ?? fallback;
}

/** Case/diacritic-insensitive key used to detect duplicate names, slugs and aliases. */
export function normalizeKey(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim().replace(/[\s_]+/g, '-');
}

/** Lowercase kebab slug; letters from any script are allowed (Vietnamese, CJK, Hangul). */
export const TAXONOMY_SLUG_RE = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;

/** Characters that could become markup in a consumer; never allowed in public taxonomy text. */
const UNSAFE_TEXT_RE = /[<>{}`\\\u0000-\u001f]/;

export function bad(field: string, message: string): never {
  throw new AppError(400, 'invalid_field', `${field} ${message}`, { field });
}

export function safeText(field: string, value: unknown, max: number, opts: { optional?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    bad(field, 'is required');
  }
  if (typeof value !== 'string') bad(field, 'must be a string');
  const v = value.trim();
  if (!v) bad(field, 'must not be empty');
  if (v.length > max) bad(field, `must be at most ${max} characters`);
  if (UNSAFE_TEXT_RE.test(v)) bad(field, 'contains characters that are not allowed (< > { } ` \\ or control characters)');
  return v;
}

export function parseSlug(field: string, value: unknown, max = 60): string {
  const v = safeText(field, value, max);
  const slug = (v ?? '').toLowerCase();
  if (!TAXONOMY_SLUG_RE.test(slug)) bad(field, 'must be lowercase kebab-case (letters, digits and single hyphens)');
  return slug;
}

/** Slug derived from a display name; strips Vietnamese diacritics for Latin text. */
export function slugify(name: string): string {
  return normalizeKey(name).replace(/[^\p{Ll}\p{Lo}\p{N}-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function parseNamesInput(field: string, value: unknown, max: number): LocalizedNames {
  if (!isObj(value)) bad(field, 'must be an object keyed by locale (en, vi, zh, ko, ja)');
  const out: LocalizedNames = {};
  for (const [key, v] of Object.entries(value)) {
    if (!isLocale(key)) bad(`${field}.${key}`, `is not a supported locale (${LOCALES.join(', ')})`);
    const text = safeText(`${field}.${key}`, v, max);
    if (text) out[key] = text;
  }
  if (Object.keys(out).length === 0) bad(field, 'must contain at least one localized name');
  return out;
}

export function requireRevision(value: unknown, field = 'expected_revision'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AppError(400, 'invalid_field', `${field} must be a non-negative integer`, { field });
  }
  return value;
}

/** Parses an optional ISO date (YYYY-MM-DD or full timestamp). */
export function parseDate(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    bad(field, 'must be an ISO date (YYYY-MM-DD)');
  }
  return value;
}

export async function writeAuditLog(
  db: D1DatabaseLike,
  entry: { actor: string; action: string; targetType: string; targetId: string; before?: unknown; after?: unknown; reason?: string },
): Promise<void> {
  await db.prepare(`
    INSERT INTO taxonomy_audit_log (id, actor, action, target_type, target_id, before_json, after_json, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId('alog_'), entry.actor, entry.action, entry.targetType, entry.targetId,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.reason ?? '', nowIso(),
  ).run();
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  before: unknown;
  after: unknown;
  reason: string;
  created_at: string;
}

export async function listAuditLog(
  d1: D1DatabaseLike | undefined,
  opts: { targetType?: string; targetId?: string; limit?: number } = {},
): Promise<AuditLogEntry[]> {
  const db = requireDb(d1);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.targetType) { where.push('target_type = ?'); binds.push(opts.targetType); }
  if (opts.targetId) { where.push('target_id = ?'); binds.push(opts.targetId); }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await db.prepare(`
    SELECT * FROM taxonomy_audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT ${limit}
  `).bind(...binds).all<Row>();
  return (results ?? []).map(r => ({
    id: str(r, 'id'), actor: str(r, 'actor'), action: str(r, 'action'), target_type: str(r, 'target_type'),
    target_id: str(r, 'target_id'), before: parseJson(r.before_json), after: parseJson(r.after_json),
    reason: str(r, 'reason'), created_at: str(r, 'created_at'),
  }));
}
