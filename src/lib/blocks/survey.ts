import type { D1DatabaseLike } from '../../db/store';
import { hashString } from '../../db/store';
import { AppError } from '../http';
import { findBlock } from './schema';
import type { SurveyBlock } from './schema';
import { applyPaywall } from './paywall';
import type { Viewer } from './paywall';
import { getArticle } from './articles';
import type { ArticleRecord } from './articles';

export const VOTER_COOKIE = 'zuey_voter';
export const VOTE_RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 } as const;

export interface SurveyOptionResult { id: string; label: string; count: number; percent: number }
export interface SurveyResults {
  block_id: string;
  question: string;
  allow_multiple: boolean;
  total_voters: number;
  options: SurveyOptionResult[];
  voted: boolean;
}

export interface LocatedSurvey { article: ArticleRecord; survey: SurveyBlock }

type Row = Record<string, unknown>;

function parseOptionIds(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Finds a survey block in the PUBLISHED article and checks it is inside the part this
 * viewer may see. Admins may pass includeDraft to look in the draft (results/export only).
 */
export async function locateSurvey(
  d1: D1DatabaseLike | undefined,
  articleSlug: string,
  blockId: string,
  viewer: Viewer,
  opts: { includeDraft?: boolean } = {},
): Promise<LocatedSurvey> {
  const article = await getArticle(d1, articleSlug);
  const doc = article ? (article.published ?? (opts.includeDraft && viewer.isAdmin ? article.draft : null)) : null;
  if (!article || !doc) throw new AppError(404, 'survey_not_found', 'Survey not found');
  let block = findBlock(doc.blocks, blockId);
  if (!block && opts.includeDraft && viewer.isAdmin) block = findBlock(article.draft.blocks, blockId);
  if (!block || block.type !== 'survey') throw new AppError(404, 'survey_not_found', 'Survey not found');
  if (!opts.includeDraft) {
    const visible = applyPaywall(doc, article.access, viewer).doc;
    if (!findBlock(visible.blocks, blockId)) {
      throw new AppError(403, 'survey_locked', 'This survey is in the members-only part of the article');
    }
  }
  return { article, survey: block };
}

function readCookie(request: Request, name: string): string | null {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export interface VoterIdentity {
  /** Null when anonymous voting is impossible (no salt configured). */
  voterKey: string | null;
  /** Set-Cookie header value when a new anonymous voter cookie was issued. */
  setCookie?: string;
}

/** 'u:<id>' for signed-in users (only the admin exists today), else 'a:' + salted hash of the voter cookie. */
export async function resolveVoter(request: Request, viewer: Viewer, salt: string | undefined, issueCookie: boolean): Promise<VoterIdentity> {
  if (viewer.isAdmin) return { voterKey: 'u:admin' };
  let token = readCookie(request, VOTER_COOKIE);
  let setCookie: string | undefined;
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    if (!issueCookie) return { voterKey: null };
    token = crypto.randomUUID().replace(/-/g, '');
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    setCookie = `${VOTER_COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`;
  }
  if (!salt) return { voterKey: null, setCookie };
  return { voterKey: 'a:' + (await hashString(`${salt}:${token}`)), setCookie };
}

export function clientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = request.headers.get('x-forwarded-for');
  return xff ? xff.split(',')[0].trim() : 'unknown';
}

export async function surveyResults(d1: D1DatabaseLike | undefined, located: LocatedSurvey, voterKey: string | null): Promise<SurveyResults> {
  const { article, survey } = located;
  const counts = new Map(survey.options.map(o => [o.id, 0]));
  let total = 0;
  let voted = false;
  if (d1) {
    const { results } = await d1.prepare('SELECT voter_key, option_ids FROM survey_votes WHERE article_id = ? AND block_id = ?')
      .bind(article.id, survey.id).all<Row>();
    for (const row of results ?? []) {
      total += 1;
      if (voterKey && row.voter_key === voterKey) voted = true;
      for (const id of parseOptionIds(row.option_ids)) {
        const c = counts.get(id);
        if (c !== undefined) counts.set(id, c + 1);
      }
    }
  }
  return {
    block_id: survey.id,
    question: survey.question,
    allow_multiple: survey.allowMultiple === true,
    total_voters: total,
    voted,
    options: survey.options.map(o => {
      const count = counts.get(o.id) ?? 0;
      return { id: o.id, label: o.label, count, percent: total ? Math.round((count / total) * 1000) / 10 : 0 };
    }),
  };
}

function validateOptionIds(survey: SurveyBlock, input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || !input.every((x): x is string => typeof x === 'string')) {
    throw new AppError(400, 'invalid_options', 'option_ids must be a non-empty array of option ids');
  }
  const unique = Array.from(new Set(input));
  const known = new Set(survey.options.map(o => o.id));
  if (!unique.every(id => known.has(id))) throw new AppError(400, 'invalid_options', 'option_ids contains an unknown option');
  if (!survey.allowMultiple && unique.length !== 1) throw new AppError(400, 'invalid_options', 'This survey accepts exactly one option');
  return unique;
}

/** Counts this attempt in the caller's fixed window; throws 429 when over the limit. */
async function enforceRateLimit(d1: D1DatabaseLike, ipHash: string, now: number): Promise<void> {
  const windowStart = Math.floor(now / VOTE_RATE_LIMIT.windowMs) * VOTE_RATE_LIMIT.windowMs;
  const row = await d1.prepare(`
    INSERT INTO survey_rate_limits (ip_hash, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT (ip_hash, window_start) DO UPDATE SET count = count + 1
    RETURNING count
  `).bind(ipHash, windowStart).first<Row>();
  if (Math.random() < 0.02) {
    await d1.prepare('DELETE FROM survey_rate_limits WHERE window_start < ?').bind(windowStart - 24 * 3600 * 1000).run();
  }
  const count = typeof row?.count === 'number' ? row.count : Number(row?.count ?? 0);
  if (count > VOTE_RATE_LIMIT.max) {
    throw new AppError(429, 'rate_limited', 'Too many votes from this network; try again later', {
      retry_after_seconds: Math.ceil((windowStart + VOTE_RATE_LIMIT.windowMs - now) / 1000),
    });
  }
}

/** Records one vote per voter per survey block. Throws 409 already_voted (with results) on repeats. */
export async function castVote(
  d1: D1DatabaseLike | undefined,
  located: LocatedSurvey,
  optionIdsInput: unknown,
  voterKey: string,
  ip: string,
  salt: string,
): Promise<SurveyResults> {
  if (!d1) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  const optionIds = validateOptionIds(located.survey, optionIdsInput);
  const now = Date.now();
  await enforceRateLimit(d1, await hashString(`${salt}:ip:${ip}`), now);
  const res = await d1.prepare(`
    INSERT INTO survey_votes (id, article_id, block_id, voter_key, option_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (block_id, voter_key) DO NOTHING
  `).bind(
    'vote_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16), located.article.id, located.survey.id, voterKey,
    JSON.stringify(optionIds), new Date(now).toISOString(),
  ).run();
  const results = await surveyResults(d1, located, voterKey);
  if (!res.meta?.changes) throw new AppError(409, 'already_voted', 'You have already voted in this survey', { results });
  return results;
}

function csvCell(value: string): string {
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Admin CSV: one row per vote, voter keys hashed and truncated; no IPs are ever stored. */
export async function exportSurveyCsv(d1: D1DatabaseLike | undefined, located: LocatedSurvey): Promise<string> {
  const labels = new Map(located.survey.options.map(o => [o.id, o.label]));
  const lines = [['voted_at', 'voter', 'option_ids', 'option_labels'].map(csvCell).join(',')];
  if (d1) {
    const { results } = await d1.prepare('SELECT voter_key, option_ids, created_at FROM survey_votes WHERE article_id = ? AND block_id = ? ORDER BY created_at')
      .bind(located.article.id, located.survey.id).all<Row>();
    for (const row of results ?? []) {
      const ids = parseOptionIds(row.option_ids);
      const voter = (await hashString(String(row.voter_key ?? ''))).slice(0, 12);
      lines.push([
        String(row.created_at ?? ''), voter, ids.join('; '), ids.map(id => labels.get(id) ?? id).join('; '),
      ].map(csvCell).join(','));
    }
  }
  return lines.join('\r\n') + '\r\n';
}
