/**
 * `article_localization_prepare` / `article_localization_apply`: the server owns state, revision
 * consistency and structural integrity; the agent (or a person) owns the translations themselves.
 *
 * prepare: translatable manifest of the source edition plus the state of every target locale.
 * apply:   merges translations keyed by manifest key into the preserved source block tree, checks the
 *          invariants, writes the target edition draft through the revision-guarded `updateArticle`, and
 *          records provenance so a later source edit marks the translation stale.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { LOCALES, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { getArticle, parseArticleInput, updateArticle } from './articles';
import type { ArticleRecord, WriteContext } from './articles';
import { buildManifest, contentHash, mergeTranslations, sha256Hex, structuralSkeleton } from './localization';
import type { LocalizableText, ManifestEntry, SkippedItem, TranslationIssue } from './localization';

type Row = Record<string, unknown>;

export type LocaleState = 'missing' | 'unmanaged' | 'current' | 'stale';

export interface LocaleStatus {
  locale: Locale;
  /** missing: no edition. unmanaged: written by hand, not by apply. current/stale: applied from this/an older source. */
  state: LocaleState;
  edition_status?: 'draft' | 'published';
  /** The edition was changed by hand after the last apply; apply refuses to overwrite it without `overwrite: true`. */
  edited_since_apply?: boolean;
  applied_from_revision?: number;
  applied_at?: string;
}

export interface PrepareResult {
  slug: string;
  source_locale: Locale;
  /** Article revision at the time of the read. */
  source_revision: number;
  /** Pass back to apply; changes whenever any source text or structure changes. */
  source_hash: string;
  locales: LocaleStatus[];
  entries: ManifestEntry[];
  skipped: SkippedItem[];
  stats: { entries: number; characters: number };
  notes: string[];
}

export interface ApplyInput {
  locale?: unknown;
  source_locale?: unknown;
  source_hash?: unknown;
  /** Optional per-key hashes from prepare; only used to name which keys changed when the source is stale. */
  source_hashes?: unknown;
  translations?: unknown;
  expected_revision?: unknown;
  overwrite?: unknown;
  dry_run?: unknown;
  glossary?: unknown;
}

export interface LocalizationReport {
  locale: Locale;
  coverage: { entries: number; translated: number; percent: number };
  /** Entries whose translation equals the source text (names, numbers, or untranslated text). */
  unchanged: string[];
  placeholders: { total: number; preserved: number };
  glossary: Array<{ term: string; expected: string; sources: string[]; applied: boolean }>;
  /** Numbers, prices, dates and legal wording found in the source, and whether the translation kept the figures. */
  high_risk: Array<{ key: string; kind: 'number' | 'price' | 'date' | 'legal'; status: 'preserved' | 'changed'; source: string[]; translation: string[] }>;
  warnings: Array<{ key?: string; code: string; message: string }>;
  skipped: SkippedItem[];
  /** The report is mechanical: it cannot certify translation quality. */
  quality: 'not_assessed';
}

export interface ApplyResult {
  dry_run: boolean;
  valid: boolean;
  committed: boolean;
  slug: string;
  locale: Locale;
  source_locale: Locale;
  source_hash: string;
  errors: TranslationIssue[];
  report: LocalizationReport | null;
  /** Present once committed. */
  article_revision?: number;
  provenance_recorded?: boolean;
  next_action: string;
}

// ---------- shared helpers ----------

function requireDb(d1: D1DatabaseLike | undefined): D1DatabaseLike {
  if (!d1) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  return d1;
}

function localeArg(value: unknown, field: string): Locale {
  if (!isLocale(value)) throw new AppError(400, 'invalid_field', `${field} must be one of ${LOCALES.join(', ')}`, { field });
  return value;
}

async function loadSource(db: D1DatabaseLike, slug: string, requested: unknown): Promise<{ rec: ArticleRecord; locale: Locale; text: LocalizableText }> {
  const primary = await getArticle(db, slug);
  if (!primary) throw new AppError(404, 'not_found', 'Article not found');
  const locale = requested === undefined ? primary.primary_locale : localeArg(requested, 'source_locale');
  const rec = locale === primary.locale ? primary : await getArticle(db, slug, { locale });
  if (!rec || rec.locale !== locale || rec.locale_fallback) throw new AppError(404, 'source_edition_missing', `The ${locale} edition does not exist`, { locale });
  // Translating from a recovered draft would bake the recovery loss into every translation.
  if (rec.draft_recovery) {
    throw new AppError(409, 'source_document_recovered',
      `The stored ${locale} draft only reads after recovery (dropped or downgraded blocks); repair it before localizing`, { locale, recovery: rec.draft_recovery });
  }
  return { rec, locale, text: { title: rec.title, excerpt: rec.excerpt, document: rec.draft } };
}

interface Provenance { source_hash: string; source_revision: number; result_hash: string; updated_at: string }

async function loadProvenance(db: D1DatabaseLike, articleId: string, locale: Locale): Promise<Provenance | null> {
  const row = await db.prepare('SELECT source_hash, source_revision, result_hash, updated_at FROM article_localizations WHERE article_id = ? AND locale = ?')
    .bind(articleId, locale).first<Row>();
  if (!row) return null;
  return {
    source_hash: String(row.source_hash), source_revision: Number(row.source_revision),
    result_hash: String(row.result_hash), updated_at: String(row.updated_at),
  };
}

async function localeStatus(db: D1DatabaseLike, slug: string, rec: ArticleRecord, locale: Locale, currentSourceHash: string): Promise<LocaleStatus> {
  const edition = rec.editions.find(e => e.locale === locale);
  if (!edition) return { locale, state: 'missing' };
  const target = await getArticle(db, slug, { locale });
  const prov = await loadProvenance(db, rec.id, locale);
  const base = { locale, edition_status: edition.status };
  if (!prov || !target || target.locale !== locale) return { ...base, state: 'unmanaged' };
  const hash = await contentHash({ title: target.title, excerpt: target.excerpt, document: target.draft });
  return {
    ...base,
    state: prov.source_hash === currentSourceHash ? 'current' : 'stale',
    edited_since_apply: hash !== prov.result_hash,
    applied_from_revision: prov.source_revision,
    applied_at: prov.updated_at,
  };
}

// ---------- prepare ----------

export async function prepareLocalization(
  d1: D1DatabaseLike | undefined, slug: string,
  input: { locales?: unknown; source_locale?: unknown; source_revision?: unknown },
): Promise<PrepareResult> {
  const db = requireDb(d1);
  const { rec, locale: sourceLocale, text } = await loadSource(db, slug, input.source_locale);
  if (input.source_revision !== undefined) {
    if (typeof input.source_revision !== 'number' || !Number.isInteger(input.source_revision)) {
      throw new AppError(400, 'invalid_field', 'source_revision must be an integer', { field: 'source_revision' });
    }
    if (input.source_revision !== rec.revision) {
      throw new AppError(409, 'revision_conflict', 'The article changed since source_revision; read it again', { current_revision: rec.revision });
    }
  }
  let targets: Locale[];
  if (input.locales === undefined) targets = LOCALES.filter(l => l !== sourceLocale);
  else if (Array.isArray(input.locales) && input.locales.length > 0) {
    targets = [...new Set(input.locales.map(l => localeArg(l, 'locales')))];
    if (targets.includes(sourceLocale)) throw new AppError(400, 'invalid_field', 'locales must not include the source locale', { field: 'locales' });
  } else throw new AppError(400, 'invalid_field', 'locales must be a non-empty array of locales', { field: 'locales' });

  const [{ entries, skipped }, hash] = await Promise.all([buildManifest(text), contentHash(text)]);
  const locales = await Promise.all(targets.map(l => localeStatus(db, slug, rec, l, hash)));
  return {
    slug, source_locale: sourceLocale, source_revision: rec.revision, source_hash: hash, locales, entries, skipped,
    stats: { entries: entries.length, characters: entries.reduce((n, e) => n + e.source_text.length, 0) },
    notes: [
      'Translate source_text of every entry and send {key: translation} to article_localization_apply with source_hash.',
      'Keep each constraints.placeholders item verbatim (link URLs, `code`, {{tokens}}); everything not listed here is copied from the source unchanged.',
      'The same manifest serves every target locale; apply one locale per call.',
    ],
  };
}

// ---------- report ----------

const NUMBER_RE = /\d[\d.,\s]*\d|\d/g;
const PRICE_RE = /[$€£¥₫]|\b(?:USD|EUR|VND|JPY|CNY)\b|đồng|美元|円|원/i;
const DATE_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/;
const LEGAL_RE = /\b(?:terms|refund|warranty|liability|privacy|license|licence|gdpr|điều khoản|hoàn tiền|bảo hành|quyền riêng tư|giấy phép)\b|条款|退款|隐私|약관|환불|利用規約|返金/i;

/** Digit strings with separators stripped, sorted: equal for "1,299" and "1.299" and "1 299". */
function figures(text: string): string[] {
  return (text.match(NUMBER_RE) ?? []).map(n => n.replace(/\D/g, '')).filter(Boolean).sort();
}

function riskKind(text: string): 'number' | 'price' | 'date' | 'legal' | null {
  if (LEGAL_RE.test(text)) return 'legal';
  if (DATE_RE.test(text)) return 'date';
  if (PRICE_RE.test(text) && /\d/.test(text)) return 'price';
  if (/\d/.test(text)) return 'number';
  return null;
}

function parseGlossary(raw: unknown): Array<[string, string]> {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new AppError(400, 'invalid_field', 'glossary must be an object {source term: required translation}', { field: 'glossary' });
  const pairs = Object.entries(raw);
  if (pairs.length > 200 || !pairs.every(([k, v]) => typeof v === 'string' && k.length > 0 && k.length <= 100 && v.length <= 100)) {
    throw new AppError(400, 'invalid_field', 'glossary must have at most 200 short string entries', { field: 'glossary' });
  }
  return pairs.flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : []));
}

function buildReport(
  locale: Locale, entries: ManifestEntry[], translations: Record<string, string>, skipped: SkippedItem[], glossary: Array<[string, string]>,
): LocalizationReport {
  const warnings: LocalizationReport['warnings'] = [];
  const unchanged: string[] = [];
  const highRisk: LocalizationReport['high_risk'] = [];
  let translated = 0;
  let placeholdersTotal = 0;
  let placeholdersKept = 0;
  const terms = glossary.map(([term, expected]) => ({ term, expected, sources: [] as string[], applied: true }));
  for (const e of entries) {
    const t = translations[e.key];
    if (typeof t !== 'string') continue;
    translated += 1;
    const lower = e.source_text.toLowerCase();
    const sameText = t.trim() === e.source_text.trim();
    if (sameText) {
      unchanged.push(e.key);
      if (/\p{L}{4,}/u.test(e.source_text) && !e.constraints?.placeholders?.length && e.kind !== 'diagram_label') {
        warnings.push({ key: e.key, code: 'unchanged_text', message: 'translation is identical to the source; confirm it is a name or intentionally untranslated' });
      }
    }
    const expectedPlaceholders = e.constraints?.placeholders ?? [];
    placeholdersTotal += expectedPlaceholders.length;
    placeholdersKept += expectedPlaceholders.filter(p => t.includes(p.startsWith('`') ? p.slice(1, -1) : p)).length;
    const kind = riskKind(e.source_text);
    if (kind) {
      const a = figures(e.source_text);
      const b = figures(t);
      const same = a.length === b.length && a.every((v, i) => v === b[i]);
      highRisk.push({ key: e.key, kind, status: same ? 'preserved' : 'changed', source: a, translation: b });
      if (!same || kind === 'legal') {
        warnings.push({ key: e.key, code: same ? 'review_legal' : 'figures_changed', message: same ? 'legal wording: have a person review this translation' : 'numbers differ from the source; verify prices, dates and quantities' });
      }
    }
    const ratio = t.length / Math.max(1, e.source_text.length);
    if (e.source_text.length >= 40 && (ratio > 3 || ratio < 0.25)) {
      warnings.push({ key: e.key, code: 'length_ratio', message: `translation is ${ratio.toFixed(2)}x the source length; check for omitted or added text` });
    }
    for (const term of terms) {
      if (!lower.includes(term.term.toLowerCase())) continue;
      term.sources.push(e.key);
      if (!t.toLowerCase().includes(term.expected.toLowerCase())) {
        term.applied = false;
        warnings.push({ key: e.key, code: 'glossary_term_missing', message: `"${term.term}" should appear as "${term.expected}"` });
      }
    }
  }
  const percent = entries.length ? Math.round((translated / entries.length) * 1000) / 10 : 100;
  return {
    locale, coverage: { entries: entries.length, translated, percent }, unchanged,
    placeholders: { total: placeholdersTotal, preserved: placeholdersKept },
    glossary: terms.filter(t => t.sources.length > 0),
    high_risk: highRisk, warnings, skipped, quality: 'not_assessed',
  };
}

// ---------- apply ----------

function asTranslations(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError(400, 'invalid_field', 'translations must be an object {manifest key: translated text}', { field: 'translations' });
  }
  return Object.fromEntries(Object.entries(raw));
}

async function changedKeys(entries: ManifestEntry[], previous: unknown): Promise<string[] | undefined> {
  if (typeof previous !== 'object' || previous === null || Array.isArray(previous)) return undefined;
  const before = new Map(Object.entries(previous));
  const now = new Map(entries.map(e => [e.key, e.source_hash]));
  const changed = new Set<string>();
  for (const [key, hash] of now) if (before.get(key) !== hash) changed.add(key);
  for (const key of before.keys()) if (!now.has(key)) changed.add(key);
  return [...changed].sort();
}

export async function applyLocalization(d1: D1DatabaseLike | undefined, slug: string, input: ApplyInput, ctx: WriteContext = {}): Promise<ApplyResult> {
  const db = requireDb(d1);
  const locale = localeArg(input.locale, 'locale');
  if (typeof input.source_hash !== 'string' || !input.source_hash) throw new AppError(400, 'invalid_field', 'source_hash is required (from article_localization_prepare)', { field: 'source_hash' });
  const translations = asTranslations(input.translations);
  const glossary = parseGlossary(input.glossary);
  const dryRun = input.dry_run === true;
  const { rec, locale: sourceLocale, text } = await loadSource(db, slug, input.source_locale);
  if (locale === sourceLocale) throw new AppError(400, 'invalid_field', 'locale must differ from the source locale', { field: 'locale' });

  const { entries, skipped } = await buildManifest(text);
  const hash = await contentHash(text);
  if (hash !== input.source_hash) {
    throw new AppError(409, 'stale_source', 'The source changed since article_localization_prepare; prepare again and re-translate the changed entries', {
      current_source_hash: hash, current_revision: rec.revision, changed_keys: await changedKeys(entries, input.source_hashes),
    });
  }
  const status = await localeStatus(db, slug, rec, locale, hash);
  if (status.state !== 'missing' && input.overwrite !== true) {
    if (status.state === 'unmanaged') {
      throw new AppError(409, 'translation_exists', `The ${locale} edition was written by hand; pass overwrite: true to replace it`, { locale });
    }
    if (status.edited_since_apply) {
      throw new AppError(409, 'translation_edited', `The ${locale} edition was edited after the last apply; pass overwrite: true to replace those edits`, { locale });
    }
  }

  const merged = mergeTranslations(text, entries, translations);
  const errors: TranslationIssue[] = [...merged.errors];
  let valid = errors.length === 0;
  if (valid) {
    try {
      const parsed = parseArticleInput({ title: merged.title, excerpt: merged.excerpt, locale, document: merged.document }, 'update');
      if (!parsed.document || structuralSkeleton(parsed.document) !== structuralSkeleton(text.document)) {
        errors.push({ code: 'structure_changed', message: 'the merged document differs from the source in ids, types, nesting, URLs, code or diagram structure; nothing was written' });
      }
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      const list = err.extra.errors;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'object' && item !== null && 'path' in item && 'message' in item) errors.push({ code: 'invalid_document', path: String(item.path), message: String(item.message) });
        }
      } else errors.push({ code: err.code, path: typeof err.extra.field === 'string' ? err.extra.field : undefined, message: err.message });
    }
    valid = errors.length === 0;
  }
  const strings = Object.fromEntries(Object.entries(translations).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])));
  const report = buildReport(locale, entries, strings, skipped, glossary);
  const base = { dry_run: dryRun, slug, locale, source_locale: sourceLocale, source_hash: hash, errors, report };
  if (!valid) return { ...base, valid: false, committed: false, next_action: 'Fix the listed errors (paths name the manifest key or document path) and call apply again; nothing was written.' };
  if (dryRun) return { ...base, valid: true, committed: false, next_action: 'Call again without dry_run to write the draft.' };

  let expected = input.expected_revision;
  if (expected === undefined) expected = rec.revision;
  const parsed = parseArticleInput({ title: merged.title, excerpt: merged.excerpt, locale, document: merged.document }, 'update');
  const updated = await updateArticle(db, slug, parsed, expected, ctx);
  const resultHash = await sha256Hex(JSON.stringify([merged.title.trim(), merged.excerpt.trim(), parsed.document]));
  const written = await getArticle(db, slug, { locale });
  const actualHash = written && written.locale === locale
    ? await contentHash({ title: written.title, excerpt: written.excerpt, document: written.draft }) : resultHash;
  let recorded = true;
  try {
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO article_localizations (article_id, locale, source_locale, source_hash, source_revision, result_hash, applied_revision, entry_count, actor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (article_id, locale) DO UPDATE SET source_locale = excluded.source_locale, source_hash = excluded.source_hash,
        source_revision = excluded.source_revision, result_hash = excluded.result_hash, applied_revision = excluded.applied_revision,
        entry_count = excluded.entry_count, actor = excluded.actor, updated_at = excluded.updated_at
    `).bind(rec.id, locale, sourceLocale, hash, rec.revision, actualHash, updated.revision, entries.length, ctx.actor ?? 'admin', now, now).run();
  } catch (err) {
    // The translation is committed; only the stale-tracking row is missing. Say so instead of failing the write.
    recorded = false;
    console.error('Localization provenance was not recorded:', err instanceof Error ? err.message : 'unknown');
  }
  return {
    ...base, valid: true, committed: true, article_revision: updated.revision, provenance_recorded: recorded,
    next_action: `The ${locale} draft is saved (not published). Review the report, then publish it with article_publish (locale: ${locale}, expected_revision: ${updated.revision}).`,
  };
}
