import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv, WorkersAiLike } from '../../env';
import { validateDocument } from '../blocks/validate';
import { AppError } from '../http';
import { LOCALES, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { documentText } from '../search/text';
import type { Row } from './common';
import { bad, isObj, newId, nowIso, num, parseJson, requireDb, str, strOrNull, writeAuditLog } from './common';
import { labelKey, listLabels } from './labels';
import { createProposal } from './proposals';

/** Instruction-tuned model with JSON output; overridable per job. */
export const AUDIT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const AUDIT_INPUT_CHARS = 12_000;
export const JOB_STATUSES = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface AuditScope { locales: Locale[]; article_ids: string[]; skip_unchanged: boolean }

export interface AuditJob {
  id: string;
  status: JobStatus;
  scope: AuditScope;
  /** Last processed "<article_id>|<locale>" key; the next run resumes after it. */
  cursor: string;
  batch_size: number;
  processed: number;
  skipped: number;
  proposal_count: number;
  error_count: number;
  last_error: string | null;
  model: string;
  snapshot_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function isStatus(v: unknown): v is JobStatus {
  return typeof v === 'string' && (JOB_STATUSES as readonly string[]).includes(v);
}

function parseScope(text: unknown): AuditScope {
  const raw = parseJson(text);
  const obj = isObj(raw) ? raw : {};
  const locales = Array.isArray(obj.locales) ? obj.locales.filter(isLocale) : [];
  const ids = Array.isArray(obj.article_ids) ? obj.article_ids.filter((x): x is string => typeof x === 'string') : [];
  return { locales, article_ids: ids, skip_unchanged: obj.skip_unchanged !== false };
}

function rowToJob(r: Row): AuditJob {
  return {
    id: str(r, 'id'), status: isStatus(r.status) ? r.status : 'failed', scope: parseScope(r.scope), cursor: str(r, 'cursor'),
    batch_size: num(r, 'batch_size', 5), processed: num(r, 'processed'), skipped: num(r, 'skipped'), proposal_count: num(r, 'proposal_count'),
    error_count: num(r, 'error_count'), last_error: strOrNull(r, 'last_error'), model: str(r, 'model'), snapshot_at: str(r, 'snapshot_at'),
    created_by: str(r, 'created_by'), created_at: str(r, 'created_at'), updated_at: str(r, 'updated_at'), completed_at: strOrNull(r, 'completed_at'),
  };
}

export async function getAuditJob(d1: D1DatabaseLike | undefined, id: string): Promise<AuditJob | null> {
  const db = requireDb(d1);
  const row = await db.prepare('SELECT * FROM taxonomy_audit_jobs WHERE id = ?').bind(id).first<Row>();
  return row ? rowToJob(row) : null;
}

export async function listAuditJobs(d1: D1DatabaseLike | undefined, limit = 50): Promise<AuditJob[]> {
  const db = requireDb(d1);
  const { results } = await db.prepare(`SELECT * FROM taxonomy_audit_jobs ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`).all<Row>();
  return (results ?? []).map(rowToJob);
}

export function parseJobInput(body: Record<string, unknown>): { scope: AuditScope; batch_size: number } {
  const locales = body.locales ?? [];
  if (!Array.isArray(locales) || !locales.every(isLocale)) bad('locales', `must be an array of ${LOCALES.join(', ')}`);
  const ids = body.article_ids ?? [];
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x: unknown) => typeof x === 'string' && x.length <= 80)) bad('article_ids', 'must be an array of at most 500 article ids');
  if (body.skip_unchanged !== undefined && typeof body.skip_unchanged !== 'boolean') bad('skip_unchanged', 'must be a boolean');
  const batch = body.batch_size ?? 5;
  if (typeof batch !== 'number' || !Number.isInteger(batch) || batch < 1 || batch > 20) bad('batch_size', 'must be an integer 1–20');
  return {
    scope: { locales: locales.filter(isLocale), article_ids: ids.filter((x: unknown): x is string => typeof x === 'string'), skip_unchanged: body.skip_unchanged !== false },
    batch_size: typeof batch === 'number' ? batch : 5,
  };
}

export async function createAuditJob(
  d1: D1DatabaseLike | undefined, input: { scope: AuditScope; batch_size: number }, actor: string, model = AUDIT_MODEL,
): Promise<AuditJob> {
  const db = requireDb(d1);
  const now = nowIso();
  const id = newId('job_');
  await db.prepare(`
    INSERT INTO taxonomy_audit_jobs (id, status, scope, cursor, batch_size, model, snapshot_at, created_by, created_at, updated_at)
    VALUES (?, 'queued', ?, '', ?, ?, ?, ?, ?, ?)
  `).bind(id, JSON.stringify(input.scope), input.batch_size, model, now, actor, now, now).run();
  await writeAuditLog(db, { actor, action: 'audit_job.create', targetType: 'audit_job', targetId: id, after: input });
  const job = await getAuditJob(db, id);
  if (!job) throw new AppError(500, 'internal_error', 'Audit job was not persisted');
  return job;
}

export async function cancelAuditJob(d1: D1DatabaseLike | undefined, id: string, actor: string): Promise<AuditJob> {
  const db = requireDb(d1);
  const now = nowIso();
  const res = await db.prepare(`UPDATE taxonomy_audit_jobs SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running', 'paused')`)
    .bind(now, now, id).run();
  const job = await getAuditJob(db, id);
  if (!job) throw new AppError(404, 'not_found', 'Audit job not found');
  if (!res.meta?.changes) throw new AppError(409, 'job_closed', `Audit job is ${job.status}`);
  await writeAuditLog(db, { actor, action: 'audit_job.cancel', targetType: 'audit_job', targetId: id });
  return job;
}

interface Candidate { key: string; articleId: string; locale: Locale; revision: number; title: string; text: string }

/** Published editions in stable "<article_id>|<locale>" order after the cursor (only what readers can see is audited). */
async function nextCandidates(db: D1DatabaseLike, job: AuditJob, limit: number): Promise<Candidate[]> {
  const { results } = await db.prepare(`
    SELECT e.article_id, e.locale, e.revision, e.title, e.published_json FROM article_editions e
    JOIN articles a ON a.id = e.article_id
    WHERE a.deleted_at IS NULL AND e.deleted_at IS NULL AND e.published_json IS NOT NULL AND (e.article_id || '|' || e.locale) > ?
    ORDER BY e.article_id || '|' || e.locale
  `).bind(job.cursor).all<Row>();
  const out: Candidate[] = [];
  for (const r of results ?? []) {
    const locale = r.locale;
    if (!isLocale(locale)) continue;
    const articleId = str(r, 'article_id');
    if (job.scope.locales.length && !job.scope.locales.includes(locale)) continue;
    if (job.scope.article_ids.length && !job.scope.article_ids.includes(articleId)) continue;
    const parsed = validateDocument(parseJson(r.published_json));
    out.push({
      key: `${articleId}|${locale}`, articleId, locale, revision: num(r, 'revision'), title: str(r, 'title'),
      text: parsed.ok ? documentText(parsed.doc) : '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface AiLabelSuggestion { assignments: unknown[]; questions: string[]; rationale: string }

export function buildAuditMessages(c: Pick<Candidate, 'title' | 'locale' | 'text'>, vocabulary: string[]): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You review one article edition for an editor and PROPOSE taxonomy labels. A human approves every change.',
        `Allowed labels (kind:slug): ${vocabulary.join(', ')}.`,
        'Rules: claim:* and freshness:* must use scope "locale". Use claim:fact ONLY with evidence.source_url (https, cited in the text) and evidence.as_of (YYYY-MM-DD);',
        'otherwise use freshness:needs-review and ask a question. Never invent sources. When unsure, add a question instead of a label.',
        'Reply with JSON only: {"assignments":[{"label":"kind:slug","scope":"article|locale","evidence":{"claim":"...","source_url":"https://...","as_of":"YYYY-MM-DD","note":"..."}}],"questions":["..."],"rationale":"..."}',
      ].join('\n'),
    },
    { role: 'user', content: `Locale: ${c.locale}\nTitle: ${c.title}\n\n${c.text.slice(0, AUDIT_INPUT_CHARS)}` },
  ];
}

/** Extracts the JSON suggestion from a Workers AI response (string or already-parsed object). */
export function parseAiSuggestion(result: unknown): AiLabelSuggestion {
  let payload: unknown = result;
  if (isObj(result) && 'response' in result) payload = result.response;
  if (typeof payload === 'string') {
    const start = payload.indexOf('{');
    const end = payload.lastIndexOf('}');
    payload = start >= 0 && end > start ? parseJson(payload.slice(start, end + 1)) : null;
  }
  if (!isObj(payload)) throw new AppError(502, 'llm_bad_response', 'Workers AI did not return a JSON label proposal');
  const assignments = Array.isArray(payload.assignments) ? payload.assignments.slice(0, 40) : [];
  const questions = Array.isArray(payload.questions) ? payload.questions.filter((q): q is string => typeof q === 'string').slice(0, 10) : [];
  const rationale = typeof payload.rationale === 'string' ? payload.rationale : '';
  return { assignments, questions, rationale };
}

function requireAi(env: RuntimeEnv): WorkersAiLike {
  if (!env.AI) throw new AppError(503, 'ai_unavailable', 'Workers AI binding (AI) is not configured; label audits cannot run');
  return env.AI;
}

/**
 * Processes the next batch of a job. Resumable: the cursor advances only after an edition is
 * proposed or skipped, so a failure pauses the job at the failing edition and the next run retries it.
 * Unchanged editions (a proposal already exists for that edition revision) are skipped when configured.
 */
export async function runAuditBatch(d1: D1DatabaseLike | undefined, env: RuntimeEnv, id: string, actor: string): Promise<AuditJob> {
  const db = requireDb(d1);
  const ai = requireAi(env);
  const job = await getAuditJob(db, id);
  if (!job) throw new AppError(404, 'not_found', 'Audit job not found');
  if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') throw new AppError(409, 'job_closed', `Audit job is ${job.status}`);
  const claim = await db.prepare(`UPDATE taxonomy_audit_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('queued', 'paused', 'running')`)
    .bind(nowIso(), id).run();
  if (!claim.meta?.changes) throw new AppError(409, 'job_closed', 'Audit job is no longer runnable');

  const vocabulary = (await listLabels(db)).map(labelKey);
  const candidates = await nextCandidates(db, job, job.batch_size);
  let { cursor, processed, skipped } = job;
  let proposals = job.proposal_count;
  for (const c of candidates) {
    if (job.scope.skip_unchanged) {
      const existing = await db.prepare('SELECT id FROM taxonomy_label_proposals WHERE article_id = ? AND locale = ? AND edition_revision = ? LIMIT 1')
        .bind(c.articleId, c.locale, c.revision).first<Row>();
      if (existing) {
        skipped++; cursor = c.key;
        continue;
      }
    }
    try {
      let raw: unknown;
      try {
        raw = await ai.run(job.model || AUDIT_MODEL, { messages: buildAuditMessages(c, vocabulary), max_tokens: 1_200, response_format: { type: 'json_object' } });
      } catch (err) {
        throw new AppError(502, 'llm_error', `Workers AI call failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
      const suggestion = parseAiSuggestion(raw);
      await createProposal(db, {
        articleId: c.articleId, locale: c.locale, assignments: suggestion.assignments, questions: suggestion.questions,
        rationale: suggestion.rationale, jobId: id, actor: `ai:${job.model || AUDIT_MODEL}`,
      });
      processed++; proposals++; cursor = c.key;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      await db.prepare(`UPDATE taxonomy_audit_jobs SET status = 'paused', cursor = ?, processed = ?, skipped = ?, proposal_count = ?,
        error_count = error_count + 1, last_error = ?, updated_at = ? WHERE id = ?`)
        .bind(cursor, processed, skipped, proposals, `${c.key}: ${message}`.slice(0, 500), nowIso(), id).run();
      const paused = await getAuditJob(db, id);
      if (!paused) throw new AppError(500, 'internal_error', 'Audit job disappeared');
      return paused;
    }
  }
  const done = candidates.length < job.batch_size || (await nextCandidates(db, { ...job, cursor }, 1)).length === 0;
  const now = nowIso();
  await db.prepare(`UPDATE taxonomy_audit_jobs SET status = ?, cursor = ?, processed = ?, skipped = ?, proposal_count = ?, updated_at = ?,
    completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END WHERE id = ? AND status = 'running'`)
    .bind(done ? 'completed' : 'paused', cursor, processed, skipped, proposals, now, done ? 'completed' : 'paused', now, id).run();
  await writeAuditLog(db, { actor, action: 'audit_job.run', targetType: 'audit_job', targetId: id, after: { cursor, processed, skipped, proposals } });
  const updated = await getAuditJob(db, id);
  if (!updated) throw new AppError(500, 'internal_error', 'Audit job disappeared');
  return updated;
}
