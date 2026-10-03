import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import type { Row } from './common';
import { bad, isObj, newId, nowIso, num, parseStringArray, requireDb, requireRevision, str, strOrNull, writeAuditLog } from './common';
import type { LabelAssignment, LabelState } from './labels';
import { applyLabelSet, assertValid, getLabelState, normalizeAssignments, parseAssignments } from './labels';

export const PROPOSAL_STATUSES = ['pending', 'deferred', 'applied', 'rejected', 'stale'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const DECISIONS = ['approve', 'edit', 'reject', 'defer'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface LabelProposal {
  id: string;
  job_id: string | null;
  article_id: string;
  article_slug: string;
  article_title: string;
  locale: Locale;
  /** Edition revision the proposal was made against. */
  edition_revision: number;
  /** Current edition revision; differs from edition_revision when the text changed since. */
  current_edition_revision: number | null;
  base_label_revision: number;
  current_label_revision: number;
  /** Assignments that the proposal replaces (article-wide plus this locale's), as they were at proposal time. */
  before: LabelAssignment[];
  proposed: LabelAssignment[];
  questions: string[];
  rationale: string;
  status: ProposalStatus;
  /** True when the edition text changed after the proposal (it can no longer be approved). */
  outdated: boolean;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  applied_label_revision: number | null;
  created_at: string;
  updated_at: string;
}

function isStatus(v: unknown): v is ProposalStatus {
  return typeof v === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(v);
}

/** The slice of an article's labels that a proposal for `locale` owns: article-wide labels plus that locale's. */
export function inProposalScope(a: LabelAssignment, locale: Locale): boolean {
  return a.scope === 'article' || a.locale === locale;
}

function rowToProposal(r: Row): LabelProposal {
  const edition = r.edition_revision_now;
  const editionNow = edition === null || edition === undefined ? null : num(r, 'edition_revision_now');
  const locale = r.locale;
  return {
    id: str(r, 'id'), job_id: strOrNull(r, 'job_id'), article_id: str(r, 'article_id'), article_slug: str(r, 'article_slug'),
    article_title: str(r, 'article_title'), locale: isLocale(locale) ? locale : 'vi', edition_revision: num(r, 'edition_revision'),
    current_edition_revision: editionNow, base_label_revision: num(r, 'base_label_revision'),
    current_label_revision: num(r, 'label_revision_now'), before: parseAssignments(r.before_json), proposed: parseAssignments(r.proposed_json),
    questions: parseStringArray(r.questions), rationale: str(r, 'rationale'), status: isStatus(r.status) ? r.status : 'pending',
    outdated: editionNow !== num(r, 'edition_revision'),
    decided_by: strOrNull(r, 'decided_by'), decided_at: strOrNull(r, 'decided_at'), decision_reason: strOrNull(r, 'decision_reason'),
    applied_label_revision: r.applied_label_revision === null || r.applied_label_revision === undefined ? null : num(r, 'applied_label_revision'),
    created_at: str(r, 'created_at'), updated_at: str(r, 'updated_at'),
  };
}

const SELECT_PROPOSAL = `
  SELECT p.*, a.slug AS article_slug, COALESCE(e.title, a.title) AS article_title, a.label_revision AS label_revision_now,
    e.revision AS edition_revision_now
  FROM taxonomy_label_proposals p
  JOIN articles a ON a.id = p.article_id
  LEFT JOIN article_editions e ON e.article_id = p.article_id AND e.locale = p.locale AND e.deleted_at IS NULL
`;

export async function getProposal(d1: D1DatabaseLike | undefined, id: string): Promise<LabelProposal | null> {
  const db = requireDb(d1);
  const row = await db.prepare(`${SELECT_PROPOSAL} WHERE p.id = ?`).bind(id).first<Row>();
  return row ? rowToProposal(row) : null;
}

export async function listProposals(
  d1: D1DatabaseLike | undefined, opts: { status?: string; articleId?: string; jobId?: string; limit?: number } = {},
): Promise<LabelProposal[]> {
  const db = requireDb(d1);
  const where: string[] = ['a.deleted_at IS NULL'];
  const binds: unknown[] = [];
  if (opts.status !== undefined) {
    if (!isStatus(opts.status)) bad('status', `must be one of ${PROPOSAL_STATUSES.join(', ')}`);
    where.push('p.status = ?'); binds.push(opts.status);
  }
  if (opts.articleId) { where.push('p.article_id = ?'); binds.push(opts.articleId); }
  if (opts.jobId) { where.push('p.job_id = ?'); binds.push(opts.jobId); }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await db.prepare(`${SELECT_PROPOSAL} WHERE ${where.join(' AND ')} ORDER BY a.slug, p.locale, p.created_at DESC LIMIT ${limit}`)
    .bind(...binds).all<Row>();
  return (results ?? []).map(rowToProposal);
}

/**
 * Stores a label proposal for one article edition. Assignments are normalised in proposal mode, so an
 * unverified "fact" becomes needs-review with a reviewer question, never an automatic fact.
 * Only article-wide labels and labels of this locale are kept (other editions are not touched).
 */
export async function createProposal(
  d1: D1DatabaseLike | undefined,
  input: { articleId: string; locale: Locale; assignments: unknown; questions?: string[]; rationale?: string; jobId?: string | null; actor: string },
): Promise<LabelProposal> {
  const db = requireDb(d1);
  const edition = await db.prepare('SELECT revision FROM article_editions WHERE article_id = ? AND locale = ? AND deleted_at IS NULL')
    .bind(input.articleId, input.locale).first<Row>();
  if (!edition) throw new AppError(404, 'not_found', `Article has no ${input.locale} edition`);
  const state = await getLabelState(db, input.articleId);
  const raw = Array.isArray(input.assignments)
    ? input.assignments.map((item: unknown) => (isObj(item) && item.scope !== 'article' && item.locale === undefined ? { ...item, locale: input.locale } : item))
    : input.assignments;
  const normalized = await normalizeAssignments(db, input.articleId, raw, 'proposal');
  const proposed = normalized.assignments.filter(a => inProposalScope(a, input.locale));
  const questions = [
    ...(input.questions ?? []),
    ...normalized.questions,
    ...normalized.issues.map(i => `Đề xuất #${i.index + 1} không hợp lệ: ${i.message}`),
  ].map(q => q.slice(0, 500)).slice(0, 30);
  const now = nowIso();
  const id = newId('prop_');
  await db.prepare(`
    INSERT INTO taxonomy_label_proposals (id, job_id, article_id, locale, edition_revision, base_label_revision, before_json, proposed_json,
      questions, rationale, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(
    id, input.jobId ?? null, input.articleId, input.locale, num(edition, 'revision'), state.label_revision,
    JSON.stringify(state.assignments.filter(a => inProposalScope(a, input.locale))), JSON.stringify(proposed),
    JSON.stringify(questions), (input.rationale ?? '').slice(0, 2_000), now, now,
  ).run();
  await writeAuditLog(db, { actor: input.actor, action: 'proposal.create', targetType: 'proposal', targetId: id, after: { article_id: input.articleId, locale: input.locale, proposed, questions } });
  const created = await getProposal(db, id);
  if (!created) throw new AppError(500, 'internal_error', 'Proposal was not persisted');
  return created;
}

export interface DecisionResult { proposal: LabelProposal; labels: LabelState | null; already_applied: boolean }

/**
 * Admin decision on a proposal.
 * - approve / edit: requires confirm === true and expected_label_revision; the edition must be unchanged
 *   since the proposal (else 409 edition_changed and the proposal becomes stale). Applying is idempotent:
 *   approving an already applied proposal returns it without writing a second label revision.
 * - reject / defer: status change only.
 */
export async function decideProposal(
  d1: D1DatabaseLike | undefined, id: string, body: Record<string, unknown>, actor: string,
): Promise<DecisionResult> {
  const db = requireDb(d1);
  const decision = body.decision;
  if (typeof decision !== 'string' || !(DECISIONS as readonly string[]).includes(decision)) bad('decision', `must be one of ${DECISIONS.join(', ')}`);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  const proposal = await getProposal(db, id);
  if (!proposal) throw new AppError(404, 'not_found', 'Proposal not found');

  if (proposal.status === 'applied') {
    if (decision === 'approve' || decision === 'edit') return { proposal, labels: await getLabelState(db, proposal.article_id), already_applied: true };
    throw new AppError(409, 'proposal_closed', 'Proposal was already applied; revert the label revision instead');
  }
  if (proposal.status === 'rejected' || proposal.status === 'stale') {
    throw new AppError(409, 'proposal_closed', `Proposal is ${proposal.status}`);
  }
  const now = nowIso();

  if (decision === 'reject' || decision === 'defer') {
    const status: ProposalStatus = decision === 'reject' ? 'rejected' : 'deferred';
    await db.prepare(`UPDATE taxonomy_label_proposals SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'deferred')`).bind(status, actor, now, reason, now, id).run();
    await writeAuditLog(db, { actor, action: `proposal.${decision}`, targetType: 'proposal', targetId: id, reason });
    const updated = await getProposal(db, id);
    if (!updated) throw new AppError(500, 'internal_error', 'Proposal disappeared');
    return { proposal: updated, labels: null, already_applied: false };
  }

  if (body.confirm !== true) throw new AppError(400, 'confirmation_required', 'Applying labels requires confirm: true');
  const expected = requireRevision(body.expected_label_revision, 'expected_label_revision');
  if (proposal.outdated) {
    await db.prepare(`UPDATE taxonomy_label_proposals SET status = 'stale', updated_at = ? WHERE id = ? AND status IN ('pending', 'deferred')`).bind(now, id).run();
    throw new AppError(409, 'edition_changed', 'The edition changed after this proposal; run a new audit for the current text', {
      proposal_edition_revision: proposal.edition_revision, current_edition_revision: proposal.current_edition_revision,
    });
  }
  let chosen: unknown = proposal.proposed;
  if (decision === 'edit') {
    if (!Array.isArray(body.assignments)) bad('assignments', 'is required for edit and must be an array');
    chosen = body.assignments;
  }
  const strict = assertValid(await normalizeAssignments(db, proposal.article_id, chosen, 'strict'));
  const outside = strict.filter(a => !inProposalScope(a, proposal.locale));
  if (outside.length) bad('assignments', `may only target article-wide labels or the ${proposal.locale} edition`);
  const current = await getLabelState(db, proposal.article_id);
  const next = [...current.assignments.filter(a => !inProposalScope(a, proposal.locale)), ...strict];
  const labels = await applyLabelSet(db, proposal.article_id, next, {
    expectedLabelRevision: expected, source: 'proposal', proposalId: id, actor,
    reason: reason || `${decision === 'edit' ? 'Edited and applied' : 'Approved'} proposal ${id}`,
  });
  const res = await db.prepare(`
    UPDATE taxonomy_label_proposals SET status = 'applied', decided_by = ?, decided_at = ?, decision_reason = ?, applied_label_revision = ?,
      proposed_json = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'deferred')
  `).bind(actor, now, reason, labels.label_revision, JSON.stringify(strict), now, id).run();
  if (!res.meta?.changes) console.error(`Proposal ${id} changed status while being applied`);
  const updated = await getProposal(db, id);
  if (!updated) throw new AppError(500, 'internal_error', 'Proposal disappeared');
  return { proposal: updated, labels, already_applied: false };
}

/** Parses a proposal-list status filter from a query string value. */
export function parseStatusFilter(value: string | null): ProposalStatus | undefined {
  if (value === null || value === '') return undefined;
  if (!isStatus(value)) bad('status', `must be one of ${PROPOSAL_STATUSES.join(', ')}`);
  return value;
}
