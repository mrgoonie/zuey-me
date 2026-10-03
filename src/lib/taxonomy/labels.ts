import type { D1DatabaseLike } from '../../db/store';
import { findBlock } from '../blocks/schema';
import { validateDocument } from '../blocks/validate';
import { AppError } from '../http';
import { LOCALES, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import type { LocalizedNames, Row } from './common';
import {
  bad, isObj, localizedName, newId, nowIso, num, parseDate, parseJson, parseNames, parseNamesInput, parseSlug,
  parseStringArray, requireDb, requireRevision, safeText, str, strOrNull, writeAuditLog,
} from './common';

export const LABEL_KINDS = ['claim', 'freshness', 'domain', 'tool', 'model', 'workflow', 'mindset', 'extension'] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];
/** Closed built-in vocabularies; other kinds are admin-managed. */
export const BUILTIN_KINDS: LabelKind[] = ['claim', 'freshness'];
export const LABEL_SCOPES = ['article', 'locale', 'revision', 'block'] as const;
export type LabelScope = (typeof LABEL_SCOPES)[number];
/** Kinds whose evidence/freshness is tied to one locale edition (never blanket-certified across translations). */
const LOCALE_BOUND_KINDS: LabelKind[] = ['claim', 'freshness'];
export const FACT_LABEL_ID = 'lbl_claim_fact';
export const NEEDS_REVIEW_LABEL_ID = 'lbl_fresh_needs_review';
const MAX_ASSIGNMENTS = 60;

export interface TaxonomyLabel {
  id: string;
  kind: LabelKind;
  slug: string;
  names: LocalizedNames;
  aliases: string[];
  description: string;
  version: string | null;
  builtin: boolean;
  approved: boolean;
  approved_at: string | null;
  approved_by: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** What readers see: approved label names only, never evidence. */
export interface PublicLabel { id: string; kind: LabelKind; slug: string; name: string; version: string | null }

export interface LabelEvidence {
  source_url?: string;
  source_title?: string;
  retrieved_at?: string;
  as_of?: string;
  review_date?: string;
  version_applicability?: string;
  claim?: string;
  note?: string;
}

export interface LabelAssignment {
  label_id: string;
  scope: LabelScope;
  locale?: Locale;
  edition_revision?: number;
  block_id?: string;
  evidence: LabelEvidence;
}

function isKind(v: unknown): v is LabelKind {
  return typeof v === 'string' && (LABEL_KINDS as readonly string[]).includes(v);
}

function isScope(v: unknown): v is LabelScope {
  return typeof v === 'string' && (LABEL_SCOPES as readonly string[]).includes(v);
}

function rowToLabel(r: Row): TaxonomyLabel {
  const kind = r.kind;
  return {
    id: str(r, 'id'), kind: isKind(kind) ? kind : 'extension', slug: str(r, 'slug'), names: parseNames(r.names),
    aliases: parseStringArray(r.aliases), description: str(r, 'description'), version: strOrNull(r, 'version'),
    builtin: num(r, 'builtin') === 1, approved: typeof r.approved_at === 'string', approved_at: strOrNull(r, 'approved_at'),
    approved_by: strOrNull(r, 'approved_by'), revision: num(r, 'revision', 1), created_at: str(r, 'created_at'), updated_at: str(r, 'updated_at'),
  };
}

export function toPublicLabel(label: TaxonomyLabel, locale: Locale): PublicLabel {
  return { id: label.id, kind: label.kind, slug: label.slug, name: localizedName(label.names, locale, label.slug), version: label.version };
}

/** Filter key used in URLs: `<kind>:<slug>` (e.g. claim:fact, freshness:outdated, domain:ai). */
export function labelKey(label: Pick<TaxonomyLabel, 'kind' | 'slug'>): string {
  return `${label.kind}:${label.slug}`;
}

export async function listLabels(d1: D1DatabaseLike | undefined, opts: { includeUnapproved?: boolean } = {}): Promise<TaxonomyLabel[]> {
  if (!d1) return [];
  const { results } = await d1.prepare(`
    SELECT * FROM taxonomy_labels WHERE deleted_at IS NULL ${opts.includeUnapproved ? '' : 'AND approved_at IS NOT NULL'}
    ORDER BY CASE kind WHEN 'claim' THEN 0 WHEN 'freshness' THEN 1 ELSE 2 END, kind, slug
  `).all<Row>();
  return (results ?? []).map(rowToLabel);
}

export async function getLabel(d1: D1DatabaseLike | undefined, idOrKey: string): Promise<TaxonomyLabel | null> {
  const db = requireDb(d1);
  const [kind, slug] = idOrKey.includes(':') ? idOrKey.split(':', 2) : ['', ''];
  const row = await db.prepare('SELECT * FROM taxonomy_labels WHERE (id = ? OR (kind = ? AND slug = ?)) AND deleted_at IS NULL')
    .bind(idOrKey, kind, slug).first<Row>();
  return row ? rowToLabel(row) : null;
}

export interface LabelInput {
  kind?: LabelKind;
  slug?: string;
  names?: LocalizedNames;
  aliases?: string[];
  description?: string;
  version?: string | null;
  approve?: boolean;
}

export function parseLabelInput(body: Record<string, unknown>, mode: 'create' | 'update'): LabelInput {
  const out: LabelInput = {};
  if (body.kind !== undefined) {
    if (!isKind(body.kind)) bad('kind', `must be one of ${LABEL_KINDS.join(', ')}`);
    out.kind = body.kind;
  }
  if (body.slug !== undefined) out.slug = parseSlug('slug', body.slug);
  if (body.names !== undefined) out.names = parseNamesInput('names', body.names, 60);
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.length > 10) bad('aliases', 'must be an array of at most 10 strings');
    out.aliases = body.aliases.map((a: unknown, i: number) => safeText(`aliases[${i}]`, a, 60) ?? '');
  }
  if (body.description !== undefined) out.description = safeText('description', body.description, 500, { optional: true }) ?? '';
  if (body.version !== undefined) out.version = body.version === null ? null : safeText('version', body.version, 60) ?? null;
  if (body.approve !== undefined) {
    if (typeof body.approve !== 'boolean') bad('approve', 'must be a boolean');
    out.approve = body.approve;
  }
  if (mode === 'create') {
    if (!out.kind) bad('kind', 'is required');
    if (!out.slug) bad('slug', 'is required');
    if (!out.names) bad('names', 'is required');
  }
  return out;
}

/** Admin-created labels are approved; `extension` labels suggested elsewhere stay unapproved until approved here. */
export async function createLabel(d1: D1DatabaseLike | undefined, input: LabelInput, actor: string): Promise<TaxonomyLabel> {
  const db = requireDb(d1);
  if (!input.kind || !input.slug || !input.names) throw new AppError(400, 'invalid_field', 'kind, slug and names are required');
  if (BUILTIN_KINDS.includes(input.kind)) throw new AppError(400, 'builtin_kind', `The ${input.kind} vocabulary is built in and cannot be extended`);
  const exists = await db.prepare('SELECT id FROM taxonomy_labels WHERE kind = ? AND slug = ?').bind(input.kind, input.slug).first<Row>();
  if (exists) throw new AppError(409, 'label_conflict', `Label ${input.kind}:${input.slug} already exists`);
  const now = nowIso();
  const id = newId('lbl_');
  const approved = input.kind !== 'extension' || input.approve === true;
  await db.prepare(`
    INSERT INTO taxonomy_labels (id, kind, slug, names, aliases, description, version, builtin, approved_at, approved_by, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)
  `).bind(
    id, input.kind, input.slug, JSON.stringify(input.names), JSON.stringify(input.aliases ?? []), input.description ?? '',
    input.version ?? null, approved ? now : null, approved ? actor : null, now, now,
  ).run();
  const label = await getLabel(db, id);
  if (!label) throw new AppError(500, 'internal_error', 'Label was not persisted');
  await writeAuditLog(db, { actor, action: 'label.create', targetType: 'label', targetId: id, after: label });
  return label;
}

export async function updateLabel(d1: D1DatabaseLike | undefined, idOrKey: string, input: LabelInput, expectedRevision: unknown, actor: string): Promise<TaxonomyLabel> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const label = await getLabel(db, idOrKey);
  if (!label) throw new AppError(404, 'not_found', 'Label not found');
  if (label.builtin && (input.slug !== undefined || input.kind !== undefined)) {
    throw new AppError(400, 'builtin_label', 'Built-in labels keep their kind and slug; only names and description may change');
  }
  if (input.kind !== undefined && input.kind !== label.kind) throw new AppError(400, 'invalid_field', 'kind cannot be changed', { field: 'kind' });
  const now = nowIso();
  const approve = input.approve === true && !label.approved;
  const res = await db.prepare(`
    UPDATE taxonomy_labels SET slug = ?, names = ?, aliases = ?, description = ?, version = ?,
      approved_at = COALESCE(approved_at, ?), approved_by = COALESCE(approved_by, ?), revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(
    input.slug ?? label.slug, JSON.stringify(input.names ?? label.names), JSON.stringify(input.aliases ?? label.aliases),
    input.description ?? label.description, input.version === undefined ? label.version : input.version,
    approve ? now : null, approve ? actor : null, now, label.id, expected,
  ).run();
  if (!res.meta?.changes) throw new AppError(409, 'revision_conflict', 'Label was changed by someone else; reload and retry', { current_revision: label.revision });
  const updated = await getLabel(db, label.id);
  if (!updated) throw new AppError(500, 'internal_error', 'Label disappeared after update');
  await writeAuditLog(db, { actor, action: approve ? 'label.approve' : 'label.update', targetType: 'label', targetId: label.id, before: label, after: updated });
  return updated;
}

export async function deleteLabel(d1: D1DatabaseLike | undefined, idOrKey: string, expectedRevision: unknown, actor: string): Promise<void> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const label = await getLabel(db, idOrKey);
  if (!label) throw new AppError(404, 'not_found', 'Label not found');
  if (label.builtin) throw new AppError(400, 'builtin_label', 'Built-in labels cannot be deleted');
  const used = await db.prepare('SELECT COUNT(*) AS n FROM article_labels WHERE label_id = ?').bind(label.id).first<Row>();
  if (used && num(used, 'n') > 0) throw new AppError(409, 'label_in_use', 'Remove this label from articles before deleting it', { articles: num(used, 'n') });
  const now = nowIso();
  const res = await db.prepare('UPDATE taxonomy_labels SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
    .bind(now, now, label.id, expected).run();
  if (!res.meta?.changes) throw new AppError(409, 'revision_conflict', 'Label was changed by someone else; reload and retry', { current_revision: label.revision });
  await writeAuditLog(db, { actor, action: 'label.delete', targetType: 'label', targetId: label.id, before: label });
}

// ---------- Assignments ----------

export interface AssignmentIssue { index: number; message: string }

function evidenceFrom(raw: unknown, path: string, issues: AssignmentIssue[], index: number): LabelEvidence {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) { issues.push({ index, message: `${path} must be an object` }); return {}; }
  const ev: LabelEvidence = {};
  const text = (key: keyof LabelEvidence, max: number) => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') return;
    if (typeof v !== 'string' || v.length > max) { issues.push({ index, message: `${path}.${key} must be a string of at most ${max} characters` }); return; }
    ev[key] = v.trim();
  };
  text('source_title', 300);
  text('version_applicability', 200);
  text('claim', 1_000);
  text('note', 1_000);
  if (raw.source_url !== undefined && raw.source_url !== null && raw.source_url !== '') {
    try {
      if (typeof raw.source_url === 'string' && new URL(raw.source_url).protocol === 'https:' && raw.source_url.length <= 2048) ev.source_url = raw.source_url;
      else issues.push({ index, message: `${path}.source_url must be an https:// URL` });
    } catch {
      issues.push({ index, message: `${path}.source_url must be an https:// URL` });
    }
  }
  for (const key of ['retrieved_at', 'as_of', 'review_date'] as const) {
    try {
      const v = parseDate(`${path}.${key}`, raw[key]);
      if (v) ev[key] = v;
    } catch (err) {
      issues.push({ index, message: err instanceof Error ? err.message : `${path}.${key} is invalid` });
    }
  }
  return ev;
}

/** A fact needs a retrievable source and the date it was true as of; URL presence alone is not verification. */
export function factEvidenceComplete(ev: LabelEvidence): boolean {
  return Boolean(ev.source_url && (ev.as_of || ev.retrieved_at));
}

interface EditionInfo { revision: number; published_revision: number | null; docs: string[] }

async function editionInfo(db: D1DatabaseLike, articleId: string): Promise<Map<string, EditionInfo>> {
  const { results } = await db.prepare('SELECT locale, revision, published_revision, draft_json, published_json FROM article_editions WHERE article_id = ? AND deleted_at IS NULL')
    .bind(articleId).all<Row>();
  const out = new Map<string, EditionInfo>();
  for (const r of results ?? []) {
    out.set(str(r, 'locale'), {
      revision: num(r, 'revision', 1),
      published_revision: r.published_revision === null || r.published_revision === undefined ? null : num(r, 'published_revision'),
      docs: [str(r, 'draft_json'), str(r, 'published_json')].filter(Boolean),
    });
  }
  return out;
}

function blockExists(docs: string[], blockId: string): boolean {
  return docs.some(text => {
    const res = validateDocument(parseJson(text));
    return res.ok && findBlock(res.doc.blocks, blockId) !== null;
  });
}

function targetKey(a: LabelAssignment): string {
  return [a.scope, a.locale ?? '', a.edition_revision ?? '', a.block_id ?? ''].join('|');
}

export interface NormalizedAssignments {
  assignments: LabelAssignment[];
  /** Strict mode: problems that block saving. Proposal mode: unresolved items turned into reviewer questions. */
  issues: AssignmentIssue[];
  questions: string[];
}

/**
 * Validates label assignments for one article.
 * - strict (admin apply): any problem is an error; a fact without complete evidence is rejected.
 * - proposal (AI or draft proposals): unknown labels become questions, and a fact without complete
 *   evidence is never kept — it is replaced by needs-review plus a reviewer question.
 */
export async function normalizeAssignments(
  db: D1DatabaseLike, articleId: string, raw: unknown, mode: 'strict' | 'proposal',
): Promise<NormalizedAssignments> {
  const issues: AssignmentIssue[] = [];
  const questions: string[] = [];
  if (!Array.isArray(raw)) return { assignments: [], issues: [{ index: -1, message: 'assignments must be an array' }], questions };
  if (raw.length > MAX_ASSIGNMENTS) return { assignments: [], issues: [{ index: -1, message: `at most ${MAX_ASSIGNMENTS} assignments` }], questions };
  const labels = new Map((await listLabels(db, { includeUnapproved: true })).map(l => [l.id, l]));
  const byKey = new Map([...labels.values()].map(l => [labelKey(l), l]));
  const editions = await editionInfo(db, articleId);
  const out: LabelAssignment[] = [];
  const seen = new Set<string>();
  const singleKind = new Map<string, string>();

  raw.forEach((item: unknown, index: number) => {
    const path = `assignments[${index}]`;
    const issueCount = issues.length;
    if (!isObj(item)) { issues.push({ index, message: `${path} must be an object` }); return; }
    const ref = typeof item.label_id === 'string' ? item.label_id : typeof item.label === 'string' ? item.label : '';
    const label = labels.get(ref) ?? byKey.get(ref);
    if (!label) {
      if (mode === 'proposal') questions.push(`Nhãn "${ref || '?'}" chưa có trong bộ nhãn — có nên tạo nhãn mới không?`);
      else issues.push({ index, message: `${path}.label_id "${ref}" is not a known label` });
      return;
    }
    if (!label.approved) {
      if (mode === 'proposal') questions.push(`Nhãn mở rộng "${labelKey(label)}" chưa được duyệt.`);
      else issues.push({ index, message: `${path}: extension label ${labelKey(label)} is not approved yet` });
      return;
    }
    const scope: LabelScope = isScope(item.scope) ? item.scope : LOCALE_BOUND_KINDS.includes(label.kind) ? 'locale' : 'article';
    if (item.scope !== undefined && !isScope(item.scope)) issues.push({ index, message: `${path}.scope must be one of ${LABEL_SCOPES.join(', ')}` });
    const a: LabelAssignment = { label_id: label.id, scope, evidence: evidenceFrom(item.evidence, `${path}.evidence`, issues, index) };
    if (scope !== 'article') {
      if (!isLocale(item.locale)) { issues.push({ index, message: `${path}.locale is required for ${scope} scope (${LOCALES.join(', ')})` }); return; }
      const ed = editions.get(item.locale);
      if (!ed) { issues.push({ index, message: `${path}.locale ${item.locale} has no edition` }); return; }
      a.locale = item.locale;
      if (scope === 'revision' || scope === 'block') {
        const rev = typeof item.edition_revision === 'number' && Number.isInteger(item.edition_revision) ? item.edition_revision : ed.revision;
        a.edition_revision = rev;
      }
      if (scope === 'block') {
        if (typeof item.block_id !== 'string' || !blockExists(ed.docs, item.block_id)) {
          issues.push({ index, message: `${path}.block_id must name a block in the ${item.locale} edition` });
          return;
        }
        a.block_id = item.block_id;
      }
    } else if (LOCALE_BOUND_KINDS.includes(label.kind)) {
      issues.push({ index, message: `${path}: ${label.kind} labels must be scoped to a locale, revision or block (translations are not certified together)` });
      return;
    }
    if (issues.length > issueCount) return;
    if (label.id === FACT_LABEL_ID && !factEvidenceComplete(a.evidence)) {
      if (mode === 'strict') {
        issues.push({ index, message: `${path}: a fact needs evidence.source_url (https) and evidence.as_of or retrieved_at` });
        return;
      }
      // Never an automatic fact: missing or unverifiable evidence becomes needs-review plus a question.
      questions.push(`Khẳng định${a.evidence.claim ? ` "${a.evidence.claim}"` : ''} (${a.locale ?? 'article'}) thiếu nguồn hoặc ngày — đã chuyển thành "needs-review".`);
      const downgraded: LabelAssignment = { ...a, label_id: NEEDS_REVIEW_LABEL_ID, evidence: { ...a.evidence, note: [a.evidence.note, 'AI proposed "fact" without complete evidence'].filter(Boolean).join(' — ') } };
      pushUnique(downgraded, labels.get(NEEDS_REVIEW_LABEL_ID));
      return;
    }
    pushUnique(a, label);
  });

  function pushUnique(a: LabelAssignment, label: TaxonomyLabel | undefined): void {
    if (!label) return;
    const dup = `${a.label_id}|${targetKey(a)}`;
    if (seen.has(dup)) return;
    if (label.kind === 'claim' || label.kind === 'freshness') {
      const k = `${label.kind}|${targetKey(a)}`;
      const other = singleKind.get(k);
      if (other) {
        const message = `Nhãn ${label.kind} mâu thuẫn trên cùng phạm vi (${other} và ${label.slug}).`;
        if (mode === 'strict') issues.push({ index: out.length, message });
        else questions.push(`${message} Giữ "${other}", cần quyết định.`);
        return;
      }
      singleKind.set(k, label.slug);
    }
    seen.add(dup);
    out.push(a);
  }

  return { assignments: out, issues, questions };
}

export function assertValid(result: NormalizedAssignments): LabelAssignment[] {
  if (result.issues.length) {
    throw new AppError(422, 'invalid_labels', 'Label assignments failed validation', { errors: result.issues });
  }
  return result.assignments;
}

// ---------- Label sets (revisioned) ----------

export interface LabelState { article_id: string; label_revision: number; assignments: LabelAssignment[] }

export interface LabelSetRevision {
  label_revision: number;
  assignments: LabelAssignment[];
  source: 'manual' | 'proposal' | 'revert';
  proposal_id: string | null;
  actor: string;
  reason: string;
  created_at: string;
}

export function parseAssignments(text: unknown): LabelAssignment[] {
  const raw = parseJson(text);
  if (!Array.isArray(raw)) return [];
  const out: LabelAssignment[] = [];
  for (const item of raw) {
    if (!isObj(item) || typeof item.label_id !== 'string' || !isScope(item.scope)) continue;
    out.push({
      label_id: item.label_id,
      scope: item.scope,
      ...(isLocale(item.locale) ? { locale: item.locale } : {}),
      ...(typeof item.edition_revision === 'number' ? { edition_revision: item.edition_revision } : {}),
      ...(typeof item.block_id === 'string' ? { block_id: item.block_id } : {}),
      evidence: isObj(item.evidence) ? evidenceFrom(item.evidence, 'evidence', [], 0) : {},
    });
  }
  return out;
}

export async function getLabelState(d1: D1DatabaseLike | undefined, articleId: string): Promise<LabelState> {
  const db = requireDb(d1);
  const art = await db.prepare('SELECT label_revision FROM articles WHERE id = ?').bind(articleId).first<Row>();
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  const revision = num(art, 'label_revision');
  const set = await db.prepare('SELECT assignments FROM article_label_sets WHERE article_id = ? AND label_revision = ?').bind(articleId, revision).first<Row>();
  return { article_id: articleId, label_revision: revision, assignments: set ? parseAssignments(set.assignments) : [] };
}

export async function listLabelHistory(d1: D1DatabaseLike | undefined, articleId: string): Promise<LabelSetRevision[]> {
  const db = requireDb(d1);
  const { results } = await db.prepare('SELECT * FROM article_label_sets WHERE article_id = ? ORDER BY label_revision DESC LIMIT 100').bind(articleId).all<Row>();
  return (results ?? []).map(r => ({
    label_revision: num(r, 'label_revision'), assignments: parseAssignments(r.assignments),
    source: r.source === 'proposal' ? 'proposal' : r.source === 'revert' ? 'revert' : 'manual',
    proposal_id: strOrNull(r, 'proposal_id'), actor: str(r, 'actor'), reason: str(r, 'reason'), created_at: str(r, 'created_at'),
  }));
}

/**
 * Applies a complete, already-validated label set as a new label revision (compare-and-swap on
 * articles.label_revision) and rebuilds the materialised assignment rows.
 */
export async function applyLabelSet(
  db: D1DatabaseLike,
  articleId: string,
  assignments: LabelAssignment[],
  opts: { expectedLabelRevision: number; source: 'manual' | 'proposal' | 'revert'; proposalId?: string; actor: string; reason: string },
): Promise<LabelState> {
  const before = await getLabelState(db, articleId);
  const next = opts.expectedLabelRevision + 1;
  const res = await db.prepare('UPDATE articles SET label_revision = ? WHERE id = ? AND label_revision = ?')
    .bind(next, articleId, opts.expectedLabelRevision).run();
  if (!res.meta?.changes) {
    throw new AppError(409, 'label_revision_conflict', 'Labels were changed by someone else; reload and review again', { current_label_revision: before.label_revision });
  }
  const now = nowIso();
  await db.prepare(`
    INSERT INTO article_label_sets (id, article_id, label_revision, assignments, source, proposal_id, actor, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(newId('lset_'), articleId, next, JSON.stringify(assignments), opts.source, opts.proposalId ?? null, opts.actor, opts.reason, now).run();
  await db.prepare('DELETE FROM article_labels WHERE article_id = ?').bind(articleId).run();
  for (const a of assignments) {
    await db.prepare(`
      INSERT INTO article_labels (id, article_id, label_id, scope, locale, edition_revision, block_id, evidence, label_revision, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newId('al_'), articleId, a.label_id, a.scope, a.locale ?? null, a.edition_revision ?? null, a.block_id ?? null, JSON.stringify(a.evidence), next, now).run();
  }
  await writeAuditLog(db, {
    actor: opts.actor, action: `labels.${opts.source}`, targetType: 'article', targetId: articleId,
    before: { label_revision: before.label_revision, assignments: before.assignments },
    after: { label_revision: next, assignments },
    reason: opts.reason,
  });
  return { article_id: articleId, label_revision: next, assignments };
}

/** Admin manual edit: validates strictly (facts need evidence) and writes a new label revision. */
export async function setArticleLabels(
  d1: D1DatabaseLike | undefined, articleId: string, raw: unknown, expectedLabelRevision: unknown, actor: string, reason: unknown,
): Promise<LabelState> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedLabelRevision, 'expected_label_revision');
  const assignments = assertValid(await normalizeAssignments(db, articleId, raw, 'strict'));
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : 'Manual label edit';
  return applyLabelSet(db, articleId, assignments, { expectedLabelRevision: expected, source: 'manual', actor, reason: why });
}

/** Restores an earlier label set by writing it as a new revision (history is never rewritten). */
export async function revertLabels(
  d1: D1DatabaseLike | undefined, articleId: string, toRevision: unknown, expectedLabelRevision: unknown, actor: string, reason: unknown,
): Promise<LabelState> {
  const db = requireDb(d1);
  const target = requireRevision(toRevision, 'to_label_revision');
  const expected = requireRevision(expectedLabelRevision, 'expected_label_revision');
  let assignments: LabelAssignment[] = [];
  if (target > 0) {
    const set = await db.prepare('SELECT assignments FROM article_label_sets WHERE article_id = ? AND label_revision = ?').bind(articleId, target).first<Row>();
    if (!set) throw new AppError(404, 'not_found', `Label revision ${target} not found`);
    assignments = parseAssignments(set.assignments);
  }
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : `Revert to label revision ${target}`;
  return applyLabelSet(db, articleId, assignments, { expectedLabelRevision: expected, source: 'revert', actor, reason: why });
}

/**
 * Approved public labels for the given articles in one locale: article-wide labels plus labels of that
 * locale edition. Revision/block-scoped labels show only while they match the published revision.
 */
export async function publicLabelsFor(db: D1DatabaseLike, articleIds: string[], locale: Locale): Promise<Map<string, PublicLabel[]>> {
  const out = new Map<string, PublicLabel[]>();
  if (articleIds.length === 0) return out;
  const { results } = await db.prepare(`
    SELECT al.article_id, l.* FROM article_labels al
    JOIN taxonomy_labels l ON l.id = al.label_id AND l.deleted_at IS NULL AND l.approved_at IS NOT NULL
    LEFT JOIN article_editions e ON e.article_id = al.article_id AND e.locale = al.locale AND e.deleted_at IS NULL
    WHERE al.scope = 'article' OR (al.locale = ? AND (al.scope = 'locale' OR al.edition_revision = e.published_revision))
  `).bind(locale).all<Row>();
  const wanted = new Set(articleIds);
  for (const r of results ?? []) {
    const articleId = str(r, 'article_id');
    if (!wanted.has(articleId)) continue;
    const list = out.get(articleId) ?? [];
    const label = toPublicLabel(rowToLabel(r), locale);
    if (!list.some(l => l.id === label.id)) list.push(label);
    out.set(articleId, list);
  }
  return out;
}
