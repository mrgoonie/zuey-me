import type { D1DatabaseLike } from '../../db/store';
import type { Locale } from '../i18n/locales';
import { LOCALES, isLocale } from '../i18n/locales';
import { AppError } from '../http';
import type { PlanId } from '../members/plans';
import { isPlanId } from '../members/plans';
import type { Principal } from '../members/policy';
import type { Row } from '../members/runtime';
import { randomId, str } from '../members/runtime';
import { experienceRuntime, isRecord } from './runtime';

/** Mascot expressions a notice may request (keys of public/mascot/manifest.json → expressions). */
export const NOTICE_EXPRESSIONS = ['idle', 'wave', 'talking', 'thinking', 'happy', 'surprised'] as const;
export type NoticeExpression = (typeof NOTICE_EXPRESSIONS)[number];
export const NOTICE_TARGETS = ['all', 'members', 'plan'] as const;
export type NoticeTarget = (typeof NOTICE_TARGETS)[number];

export const NOTICE_TEXT_MAX = 500;
export const NOTICE_MAX_WINDOW_DAYS = 30;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type NoticeText = Partial<Record<Locale, string>>;

export interface NoticeInput {
  text: NoticeText;
  expression: NoticeExpression | null;
  target: NoticeTarget;
  target_plan: PlanId | null;
  starts_at: string;
  expires_at: string;
}

/** Admin view: every locale, targeting and author. */
export interface NoticeRecord extends NoticeInput {
  id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  status: 'scheduled' | 'active' | 'expired';
}

/** Visitor view: one resolved text, no targeting or author details. */
export interface PublicNotice {
  id: string;
  text: string;
  /** Locale of `text`; differs from the requested locale when that edition does not exist. */
  locale: Locale;
  expression: NoticeExpression | null;
  starts_at: string;
  expires_at: string;
}

function isExpression(v: unknown): v is NoticeExpression {
  return typeof v === 'string' && (NOTICE_EXPRESSIONS as readonly string[]).includes(v);
}

function isTarget(v: unknown): v is NoticeTarget {
  return typeof v === 'string' && (NOTICE_TARGETS as readonly string[]).includes(v);
}

function invalid(field: string, message: string): never {
  throw new AppError(400, 'invalid_field', `${field} ${message}`, { field });
}

function parseInstant(value: unknown, field: string): number {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) invalid(field, 'must be an ISO-8601 date-time');
  return Date.parse(value);
}

function parseText(raw: unknown, fallbackLocale: unknown): NoticeText {
  const text: NoticeText = {};
  if (typeof raw === 'string') {
    const locale = fallbackLocale === undefined ? 'vi' : fallbackLocale;
    if (!isLocale(locale)) invalid('locale', `must be one of ${LOCALES.join(', ')}`);
    text[locale] = raw;
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (!isLocale(key)) invalid('text', `keys must be locales (${LOCALES.join(', ')})`);
      if (typeof value !== 'string') invalid(`text.${key}`, 'must be a string');
      text[key] = value;
    }
  } else {
    invalid('text', 'must be a string or an object keyed by locale');
  }
  for (const locale of LOCALES) {
    const value = text[locale];
    if (value === undefined) continue;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      delete text[locale];
      continue;
    }
    if (trimmed.length > NOTICE_TEXT_MAX) invalid(`text.${locale}`, `must be at most ${NOTICE_TEXT_MAX} characters`);
    text[locale] = trimmed;
  }
  if (Object.keys(text).length === 0) invalid('text', 'must contain at least one non-empty locale');
  return text;
}

/**
 * Validates a notice from REST or MCP. `text` is an object keyed by locale (or a string with
 * `locale`); the window is `starts_at` (default now) → `expires_at` or `ttl_hours`, at most 30 days.
 */
export function parseNoticeInput(body: Record<string, unknown>): NoticeInput {
  const now = experienceRuntime.now();
  const text = parseText(body.text, body.locale);
  const expression = body.expression === undefined || body.expression === null ? null : body.expression;
  if (expression !== null && !isExpression(expression)) invalid('expression', `must be one of ${NOTICE_EXPRESSIONS.join(', ')}`);
  const target = body.target === undefined ? 'all' : body.target;
  if (!isTarget(target)) invalid('target', `must be one of ${NOTICE_TARGETS.join(', ')}`);
  let targetPlan: PlanId | null = null;
  if (target === 'plan') {
    if (!isPlanId(body.plan)) invalid('plan', 'is required when target is "plan" (knowledges, ai, combo, community)');
    targetPlan = body.plan;
  } else if (body.plan !== undefined && body.plan !== null) {
    invalid('plan', 'is only allowed when target is "plan"');
  }
  const start = body.starts_at === undefined ? now : parseInstant(body.starts_at, 'starts_at');
  let end: number;
  if (body.expires_at !== undefined) {
    end = parseInstant(body.expires_at, 'expires_at');
  } else if (typeof body.ttl_hours === 'number' && Number.isFinite(body.ttl_hours) && body.ttl_hours > 0) {
    end = start + body.ttl_hours * HOUR_MS;
  } else {
    invalid('expires_at', 'or a positive ttl_hours is required');
  }
  if (end <= start) invalid('expires_at', 'must be after starts_at');
  if (end <= now) invalid('expires_at', 'must be in the future');
  if (end - start > NOTICE_MAX_WINDOW_DAYS * DAY_MS) invalid('expires_at', `must be within ${NOTICE_MAX_WINDOW_DAYS} days of starts_at`);
  return {
    text,
    expression,
    target,
    target_plan: targetPlan,
    starts_at: new Date(start).toISOString(),
    expires_at: new Date(end).toISOString(),
  };
}

function rowText(row: Row): NoticeText {
  try {
    const parsed: unknown = JSON.parse(str(row, 'text_json'));
    const out: NoticeText = {};
    if (isRecord(parsed)) {
      for (const locale of LOCALES) {
        const v = parsed[locale];
        if (typeof v === 'string' && v) out[locale] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function toRecord(row: Row, now: number): NoticeRecord {
  const startsAt = str(row, 'starts_at');
  const expiresAt = str(row, 'expires_at');
  const expression = row.expression;
  const target = row.target;
  const plan = row.target_plan;
  return {
    id: str(row, 'id'),
    text: rowText(row),
    expression: isExpression(expression) ? expression : null,
    target: isTarget(target) ? target : 'all',
    target_plan: isPlanId(plan) ? plan : null,
    starts_at: startsAt,
    expires_at: expiresAt,
    created_by: str(row, 'created_by'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
    status: Date.parse(expiresAt) <= now ? 'expired' : Date.parse(startsAt) > now ? 'scheduled' : 'active',
  };
}

export async function createNotice(d1: D1DatabaseLike, input: NoticeInput, createdBy: string): Promise<NoticeRecord> {
  const now = experienceRuntime.now();
  const id = randomId('ntc');
  const ts = new Date(now).toISOString();
  await d1.prepare(
    'INSERT INTO notices (id, text_json, expression, target, target_plan, starts_at, expires_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, JSON.stringify(input.text), input.expression, input.target, input.target_plan, input.starts_at, input.expires_at, createdBy.slice(0, 200), ts, ts).run();
  const created = await getNotice(d1, id);
  if (!created) throw new AppError(500, 'internal_error', 'Notice was not stored');
  return created;
}

export async function getNotice(d1: D1DatabaseLike, id: string): Promise<NoticeRecord | null> {
  const row = await d1.prepare('SELECT * FROM notices WHERE id = ?').bind(id).first<Row>();
  return row ? toRecord(row, experienceRuntime.now()) : null;
}

/** Admin list, newest first. Expired notices are included only when asked. */
export async function listNotices(d1: D1DatabaseLike, opts: { includeExpired?: boolean; limit?: number } = {}): Promise<NoticeRecord[]> {
  const now = experienceRuntime.now();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const sql = opts.includeExpired
    ? 'SELECT * FROM notices ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM notices WHERE expires_at > ? ORDER BY starts_at DESC LIMIT ?';
  const stmt = opts.includeExpired ? d1.prepare(sql).bind(limit) : d1.prepare(sql).bind(new Date(now).toISOString(), limit);
  const { results } = await stmt.all<Row>();
  return (results ?? []).map(r => toRecord(r, now));
}

/** Ends a notice now. Idempotent: an already expired notice is returned unchanged. */
export async function expireNotice(d1: D1DatabaseLike, id: string): Promise<NoticeRecord> {
  const existing = await getNotice(d1, id);
  if (!existing) throw new AppError(404, 'notice_not_found', 'Notice not found');
  if (existing.status === 'expired') return existing;
  const now = experienceRuntime.now();
  const end = new Date(now).toISOString();
  // A scheduled notice that never started keeps a valid window (starts_at < expires_at).
  const start = Date.parse(existing.starts_at) < now ? existing.starts_at : new Date(now - 1).toISOString();
  await d1.prepare('UPDATE notices SET starts_at = ?, expires_at = ?, updated_at = ? WHERE id = ?').bind(start, end, end, id).run();
  const updated = await getNotice(d1, id);
  if (!updated) throw new AppError(404, 'notice_not_found', 'Notice not found');
  return updated;
}

/** Whether a principal is in a notice's audience. Admins see every notice so they can preview targeting. */
export function noticeVisibleTo(notice: Pick<NoticeRecord, 'target' | 'target_plan'>, p: Principal): boolean {
  if (p.kind === 'admin') return true;
  if (notice.target === 'all') return true;
  if (notice.target === 'members') return p.userId !== null;
  return notice.target_plan !== null && p.plans.includes(notice.target_plan);
}

/** Picks the requested locale, then English, then Vietnamese, then any edition. */
export function resolveNoticeText(text: NoticeText, locale: Locale): { text: string; locale: Locale } | null {
  for (const candidate of [locale, 'en', 'vi', ...LOCALES] as const) {
    const value = text[candidate];
    if (value) return { text: value, locale: candidate };
  }
  return null;
}

/** Notices live right now for this visitor, soonest-expiring first. */
export async function activeNoticesFor(d1: D1DatabaseLike, p: Principal, locale: Locale): Promise<PublicNotice[]> {
  const nowIso = new Date(experienceRuntime.now()).toISOString();
  const { results } = await d1.prepare(
    'SELECT * FROM notices WHERE starts_at <= ? AND expires_at > ? ORDER BY expires_at ASC LIMIT 20'
  ).bind(nowIso, nowIso).all<Row>();
  const out: PublicNotice[] = [];
  for (const row of results ?? []) {
    const notice = toRecord(row, experienceRuntime.now());
    if (!noticeVisibleTo(notice, p)) continue;
    const resolved = resolveNoticeText(notice.text, locale);
    if (!resolved) continue;
    out.push({ id: notice.id, text: resolved.text, locale: resolved.locale, expression: notice.expression, starts_at: notice.starts_at, expires_at: notice.expires_at });
  }
  return out;
}

/** Audit-friendly author label for the created_by column. */
export function principalLabel(p: Principal): string {
  if (p.email) return p.email;
  return p.via === 'none' ? 'unknown' : p.via;
}

