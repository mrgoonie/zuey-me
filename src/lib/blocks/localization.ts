/**
 * Structural localization: extracts the visible text of a block document as a flat manifest keyed by
 * stable block id + field path, and merges translations back into the preserved source block tree.
 *
 * Only fields enumerated in `stringFields` are ever read or written. Ids, URLs, code, CSS, JS, schema
 * data and diagram structure are never part of the manifest, and extraction is fail-closed: anything
 * it cannot isolate safely (a Mermaid type it does not parse, an interactive widget without explicit
 * `data-i18n` markers) is reported under `skipped` and left untouched. No widget code is ever run or
 * rewritten by pattern; the only widget text touched is the plain text of an element that carries a
 * `data-i18n` attribute and has no child markup.
 */
import { parseInline } from './inline';
import type { ArticleDocument, Block } from './schema';
import { childBlockLists } from './schema';
import { columnOf, isProseColumn } from './table-data';

export type EntryKind = 'text' | 'inline' | 'diagram_label' | 'widget_text' | 'meta';

export interface ManifestEntry {
  /** `<block_id>#<field_path>`; the only identifier a translation may use. */
  key: string;
  block_id: string;
  field_path: string;
  kind: EntryKind;
  source_text: string;
  source_hash: string;
  constraints?: { placeholders?: string[]; plain?: boolean };
}

export interface SkippedItem {
  block_id: string;
  field_path?: string;
  reason: string;
}

export const ARTICLE_BLOCK_ID = '$article';
export const entryKey = (blockId: string, fieldPath: string) => `${blockId}#${fieldPath}`;

interface RawEntry { block_id: string; field_path: string; kind: EntryKind; text: string; plain: boolean }

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------- field enumeration ----------

type FieldSpec = [path: string, kind: EntryKind, plain: boolean];

/** Leaf string fields of a block in document order (nested block lists are visited separately). */
function stringFields(block: Block): FieldSpec[] {
  const out: FieldSpec[] = [];
  const inline = (path: string, v: string | undefined) => { if (v) out.push([path, 'inline', false]); };
  const plainText = (path: string, v: string | undefined) => { if (v) out.push([path, 'text', true]); };
  switch (block.type) {
    case 'paragraph': case 'heading': inline('text', block.text); break;
    case 'list': block.items.forEach((t, i) => inline(`items[${i}]`, t)); break;
    case 'checklist': block.items.forEach((it, i) => inline(`items[${i}].text`, it.text)); break;
    case 'quote': inline('text', block.text); inline('cite', block.cite); break;
    case 'callout': inline('text', block.text); break;
    case 'image': plainText('alt', block.alt); inline('caption', block.caption); break;
    case 'embed': inline('caption', block.caption); break;
    case 'table':
      plainText('title', block.title);
      block.headers.forEach((t, i) => inline(`headers[${i}]`, t));
      // Numbers, dates, booleans and links are data, not prose: only text and badge cells are translated.
      block.rows.forEach((row, r) => row.forEach((t, c) => { if (isProseColumn(columnOf(block, c))) inline(`rows[${r}][${c}]`, t); }));
      inline('caption', block.caption);
      break;
    case 'chart':
      plainText('title', block.title);
      // ISO date labels are data, not prose; annotations point at labels by index, so they survive translation.
      if (block.x?.format !== 'date') block.labels.forEach((t, i) => plainText(`labels[${i}]`, t));
      block.series.forEach((s, i) => plainText(`series[${i}].name`, s.name));
      for (const key of ['x', 'y', 'y2'] as const) { plainText(`${key}.title`, block[key]?.title); plainText(`${key}.unit`, block[key]?.unit); }
      block.references?.forEach((r, i) => plainText(`references[${i}].label`, r.label));
      block.annotations?.forEach((a, i) => plainText(`annotations[${i}].text`, a.text));
      inline('caption', block.caption);
      break;
    case 'diagram': inline('caption', block.caption); break;
    case 'survey':
      plainText('question', block.question);
      block.options.forEach((o, i) => plainText(`options[${i}].label`, o.label));
      break;
    case 'interactive': plainText('title', block.title); inline('caption', block.caption); break;
    case 'math': inline('caption', block.caption); break;
    case 'gallery':
      block.images.forEach((im, i) => { plainText(`images[${i}].alt`, im.alt); inline(`images[${i}].caption`, im.caption); });
      inline('caption', block.caption);
      break;
    case 'audio': case 'video': plainText('title', block.title); inline('caption', block.caption); break;
    case 'file': plainText('name', block.name); inline('caption', block.caption); break;
    case 'bookmark': plainText('title', block.title); plainText('description', block.description); plainText('siteName', block.siteName); break;
    case 'toggle': inline('summary', block.summary); break;
    case 'icon': plainText('label', block.label); break;
    case 'card': plainText('title', block.title); plainText('image.alt', block.image?.alt); inline('footer', block.footer); break;
    case 'tabs': block.tabs.forEach((t, i) => plainText(`tabs[${i}].label`, t.label)); break;
    case 'stat':
      plainText('title', block.title);
      block.items.forEach((s, i) => {
        plainText(`items[${i}].label`, s.label); plainText(`items[${i}].unit`, s.unit); plainText(`items[${i}].delta.label`, s.delta?.label); inline(`items[${i}].note`, s.note);
      });
      break;
    case 'steps': block.items.forEach((s, i) => { inline(`items[${i}].title`, s.title); plainText(`items[${i}].date`, s.date); }); break;
    case 'comparison':
      plainText('title', block.title);
      block.options.forEach((o, i) => {
        plainText(`options[${i}].name`, o.name); plainText(`options[${i}].badge`, o.badge); inline(`options[${i}].description`, o.description);
        o.pros?.forEach((s, j) => inline(`options[${i}].pros[${j}]`, s));
        o.cons?.forEach((s, j) => inline(`options[${i}].cons[${j}]`, s));
      });
      block.features?.forEach((f, i) => {
        plainText(`features[${i}].label`, f.label);
        f.values.forEach((x, j) => { if (typeof x === 'string') plainText(`features[${i}].values[${j}]`, x); });
      });
      break;
    case 'progress':
      plainText('title', block.title);
      block.items.forEach((s, i) => { plainText(`items[${i}].label`, s.label); inline(`items[${i}].note`, s.note); });
      break;
    default: break;
  }
  return out;
}

// ---------- path access ----------

type Segment = string | number;

function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  for (const m of path.matchAll(/([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) segments.push(m[1] !== undefined ? m[1] : Number(m[2]));
  return segments;
}

function getAt(root: unknown, segments: Segment[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (typeof seg === 'number') cur = Array.isArray(cur) ? cur[seg] : undefined;
    else cur = isRecord(cur) ? cur[seg] : undefined;
  }
  return cur;
}

function setAt(root: unknown, segments: Segment[], value: string): boolean {
  const parent = getAt(root, segments.slice(0, -1));
  const last = segments[segments.length - 1];
  if (typeof last === 'number' && Array.isArray(parent) && typeof parent[last] === 'string') { parent[last] = value; return true; }
  if (typeof last === 'string' && isRecord(parent) && typeof parent[last] === 'string') { parent[last] = value; return true; }
  return false;
}

// ---------- Mermaid labels ----------

/** Flowchart-family diagrams whose node and edge labels are isolated below; other types are skipped whole. */
const FLOWCHART_HEAD = /^\s*(?:%%[^\n]*\n\s*)*(?:graph|flowchart)\b/i;
/** A node label inside its brackets. Group 1: opening bracket, 2: quoted text, 3: bare text. */
const NODE_LABEL = /(\[\[|\(\(|\[\(|\[|\(|\{|>)\s*(?:"([^"\n]*)"|([^"[\](){}|\n]+))\s*(?=\]\]|\)\)|\)\]|\]|\)|\})/g;
/** An edge label between pipes. Group 1: quoted text, 2: bare text. */
const EDGE_LABEL = /\|\s*(?:"([^"\n]*)"|([^"|\n]+))\s*\|/g;

interface DiagramLabel { start: number; end: number; text: string; quoted: boolean }

/** Labels in source order with their exact ranges (quotes excluded). Empty for diagram types it does not parse. */
export function mermaidLabels(source: string): DiagramLabel[] {
  if (!FLOWCHART_HEAD.test(source)) return [];
  const found: DiagramLabel[] = [];
  const add = (m: RegExpMatchArray, text: string | undefined, quoted: boolean, from: number) => {
    if (text === undefined || !text.trim()) return;
    const start = (m.index ?? 0) + m[0].indexOf(text, from);
    found.push({ start, end: start + text.length, text, quoted });
  };
  for (const m of source.matchAll(NODE_LABEL)) add(m, m[2] ?? m[3], m[2] !== undefined, m[1].length);
  for (const m of source.matchAll(EDGE_LABEL)) add(m, m[1] ?? m[2], m[1] !== undefined, 1);
  found.sort((a, b) => a.start - b.start);
  // Overlapping ranges mean the source is not simple enough to edit by position: treat it as unparsed.
  for (let i = 1; i < found.length; i++) if (found[i].start < found[i - 1].end) return [];
  return found;
}

/** The diagram source with every label emptied: the structure that must survive translation. */
export function mermaidSkeleton(source: string): string {
  let out = '';
  let last = 0;
  for (const l of mermaidLabels(source)) { out += source.slice(last, l.start); last = l.end; }
  return out + source.slice(last);
}

function replaceMermaidLabels(source: string, texts: string[]): string {
  let out = '';
  let last = 0;
  mermaidLabels(source).forEach((l, i) => { out += source.slice(last, l.start) + texts[i]; last = l.end; });
  return out + source.slice(last);
}

/** Characters that would change how a Mermaid label parses. */
function mermaidLabelProblem(text: string, quoted: boolean): string | null {
  if (/[\n\r]/.test(text)) return 'must be a single line';
  if (/[[\]{}|"]/.test(text)) return 'must not contain [ ] { } | or "';
  if (!quoted && /[()]/.test(text)) return 'must not contain parentheses (the source label is not quoted)';
  return null;
}

// ---------- interactive widget text ----------

/** `<tag ... data-i18n="key" ...>plain text</tag>`: the only widget markup that is ever read or replaced. */
const WIDGET_TEXT = /<([a-zA-Z][a-zA-Z0-9]*)\b[^<>]*?\sdata-i18n="([A-Za-z0-9_.-]{1,64})"[^<>]*>([^<]*)<\/\1>/g;
const ANY_I18N_ATTR = /\sdata-i18n\b/g;

interface WidgetText { key: string; start: number; end: number; text: string }

export function scanWidgetHtml(html: string): { texts: WidgetText[]; skipped: string[] } {
  const matches = [...html.matchAll(WIDGET_TEXT)];
  const counts = new Map<string, number>();
  for (const m of matches) counts.set(m[2], (counts.get(m[2]) ?? 0) + 1);
  const texts: WidgetText[] = [];
  const skipped: string[] = [];
  for (const m of matches) {
    const text = m[3];
    if ((counts.get(m[2]) ?? 0) > 1) {
      const reason = `duplicate data-i18n key "${m[2]}"`;
      if (!skipped.includes(reason)) skipped.push(reason);
      continue;
    }
    if (!text.trim()) continue;
    const start = (m.index ?? 0) + m[0].length - `</${m[1]}>`.length - text.length;
    texts.push({ key: m[2], start, end: start + text.length, text });
  }
  if ((html.match(ANY_I18N_ATTR) ?? []).length > matches.length) skipped.push('data-i18n element with child markup or an unsupported shape');
  return { texts, skipped };
}

function widgetSkeleton(html: string): string {
  let out = '';
  let last = 0;
  for (const t of scanWidgetHtml(html).texts) { out += html.slice(last, t.start); last = t.end; }
  return out + html.slice(last);
}

function replaceWidgetTexts(html: string, byKey: Map<string, string>): string {
  let out = '';
  let last = 0;
  for (const t of scanWidgetHtml(html).texts) {
    out += html.slice(last, t.start) + (byKey.get(t.key) ?? t.text);
    last = t.end;
  }
  return out + html.slice(last);
}

/** Widget text may carry entities but never markup or a bare ampersand. */
function widgetTextProblem(text: string): string | null {
  if (/[<>]/.test(text)) return 'must not contain < or > (widget text is plain text)';
  if (/&(?!(?:[a-zA-Z]{2,8}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/.test(text)) return 'must escape & as &amp;';
  if (/[\n\r]/.test(text)) return 'must be a single line';
  return null;
}

// ---------- placeholders ----------

const TOKEN_RE = /\{\{[^{}\n]{1,64}\}\}|%[sd]|\{\d+\}/g;

/** Tokens a translation must carry over unchanged: link URLs, inline code spans and `{{x}}`-style tokens (sorted). */
export function placeholdersOf(text: string): string[] {
  const out: string[] = [];
  const walk = (nodes: ReturnType<typeof parseInline>) => {
    for (const n of nodes) {
      if (n.kind === 'code') out.push('`' + n.value + '`');
      else if (n.kind === 'link') { out.push(n.href); walk(n.children); }
      else if (n.kind !== 'text') walk(n.children);
    }
  };
  walk(parseInline(text));
  for (const m of text.matchAll(TOKEN_RE)) out.push(m[0]);
  return out.sort();
}

// ---------- extraction ----------

function collectEntries(doc: ArticleDocument): { raw: RawEntry[]; skipped: SkippedItem[] } {
  const raw: RawEntry[] = [];
  const skipped: SkippedItem[] = [];
  const visit = (blocks: Block[]) => {
    for (const block of blocks) {
      for (const [path, kind, plain] of stringFields(block)) {
        const text = getAt(block, parsePath(path));
        if (typeof text === 'string' && text) raw.push({ block_id: block.id, field_path: path, kind, text, plain });
      }
      if (block.type === 'diagram') {
        const labels = mermaidLabels(block.source);
        if (!labels.length) skipped.push({ block_id: block.id, field_path: 'source', reason: 'diagram labels not extracted (only flowchart/graph diagrams with simple labels are supported); source kept as is' });
        labels.forEach((l, i) => raw.push({ block_id: block.id, field_path: `source.labels[${i}]`, kind: 'diagram_label', text: l.text, plain: true }));
      }
      if (block.type === 'interactive') {
        const scan = scanWidgetHtml(block.html);
        if (!scan.texts.length) skipped.push({ block_id: block.id, field_path: 'html', reason: 'widget has no data-i18n text; its visible strings stay in the source language' });
        for (const reason of scan.skipped) skipped.push({ block_id: block.id, field_path: 'html', reason });
        for (const t of scan.texts) raw.push({ block_id: block.id, field_path: `html.i18n[${t.key}]`, kind: 'widget_text', text: t.text, plain: true });
      }
      for (const list of childBlockLists(block)) visit(list);
    }
  };
  visit(doc.blocks);
  return { raw, skipped };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface LocalizableText { title: string; excerpt: string; document: ArticleDocument }

/** Hash of everything a translation depends on; changes whenever any source text or structure changes. */
export function contentHash(src: LocalizableText): Promise<string> {
  return sha256Hex(JSON.stringify([src.title, src.excerpt, src.document]));
}

/** The translatable manifest of one edition (title and excerpt first, then blocks in reading order). */
export async function buildManifest(src: LocalizableText): Promise<{ entries: ManifestEntry[]; skipped: SkippedItem[] }> {
  const { raw, skipped } = collectEntries(src.document);
  const metas: RawEntry[] = [{ block_id: ARTICLE_BLOCK_ID, field_path: 'title', kind: 'meta', text: src.title, plain: true }];
  if (src.excerpt) metas.push({ block_id: ARTICLE_BLOCK_ID, field_path: 'excerpt', kind: 'meta', text: src.excerpt, plain: true });
  const entries: ManifestEntry[] = [];
  for (const r of [...metas, ...raw]) {
    const placeholders = placeholdersOf(r.text);
    const constraints: ManifestEntry['constraints'] = { ...(placeholders.length ? { placeholders } : {}), ...(r.plain ? { plain: true } : {}) };
    entries.push({
      key: entryKey(r.block_id, r.field_path), block_id: r.block_id, field_path: r.field_path, kind: r.kind,
      source_text: r.text, source_hash: (await sha256Hex(r.text)).slice(0, 16),
      ...(Object.keys(constraints).length ? { constraints } : {}),
    });
  }
  return { entries, skipped };
}

// ---------- merging ----------

export interface TranslationIssue { key?: string; path?: string; code: string; message: string }

export interface MergeResult {
  title: string;
  excerpt: string;
  document: ArticleDocument;
  errors: TranslationIssue[];
}

function entryProblems(entry: ManifestEntry, text: string, quoted: boolean | undefined): TranslationIssue[] {
  const issues: TranslationIssue[] = [];
  const fail = (code: string, message: string) => issues.push({ key: entry.key, code, message });
  if (!text.trim()) { fail('empty_translation', 'translation must not be empty'); return issues; }
  const expected = entry.constraints?.placeholders ?? [];
  const actual = placeholdersOf(text);
  if (expected.length !== actual.length || expected.some((p, i) => p !== actual[i])) {
    const missing = expected.filter(p => !actual.includes(p));
    const extra = actual.filter(p => !expected.includes(p));
    fail('placeholder_mismatch', `links, code spans and tokens must be kept unchanged${missing.length ? `; missing: ${missing.join(' ')}` : ''}${extra.length ? `; unexpected: ${extra.join(' ')}` : ''}`);
  }
  if (entry.kind === 'diagram_label') {
    const problem = mermaidLabelProblem(text, quoted === true);
    if (problem) fail('diagram_label_invalid', `diagram label ${problem}`);
  }
  if (entry.kind === 'widget_text') {
    const problem = widgetTextProblem(text);
    if (problem) fail('widget_text_invalid', `widget text ${problem}`);
  }
  return issues;
}

const bracketIndex = (fieldPath: string) => Number(/\[(\d+)\]/.exec(fieldPath)?.[1]);

/**
 * Applies translations (keyed by manifest key) to a clone of the source. Reports missing and extraneous
 * keys and placeholder, diagram and widget problems; never drops or invents blocks. The caller validates the
 * result with `validateDocument` and compares `structuralSkeleton`s.
 */
export function mergeTranslations(src: LocalizableText, entries: ManifestEntry[], translations: Record<string, unknown>): MergeResult {
  const errors: TranslationIssue[] = [];
  const known = new Set(entries.map(e => e.key));
  for (const key of Object.keys(translations)) {
    if (!known.has(key)) errors.push({ key, code: 'unknown_key', message: 'key is not in the manifest for this source' });
  }
  const document = structuredClone(src.document);
  const blocks = new Map<string, Block>();
  const index = (list: Block[]) => { for (const b of list) { blocks.set(b.id, b); for (const l of childBlockLists(b)) index(l); } };
  index(document.blocks);

  let title = src.title;
  let excerpt = src.excerpt;
  const labelEdits = new Map<string, string[]>();
  const widgetEdits = new Map<string, Map<string, string>>();

  for (const entry of entries) {
    const value = translations[entry.key];
    if (value === undefined) { errors.push({ key: entry.key, code: 'missing_translation', message: 'no translation for this manifest key' }); continue; }
    if (typeof value !== 'string') { errors.push({ key: entry.key, code: 'invalid_translation', message: 'translation must be a string' }); continue; }
    const isMeta = entry.block_id === ARTICLE_BLOCK_ID;
    const block = isMeta ? undefined : blocks.get(entry.block_id);
    if (!isMeta && !block) { errors.push({ key: entry.key, code: 'block_missing', message: 'block not found in the source document' }); continue; }
    const quoted = entry.kind === 'diagram_label' && block?.type === 'diagram'
      ? mermaidLabels(block.source)[bracketIndex(entry.field_path)]?.quoted : undefined;
    const problems = entryProblems(entry, value, quoted);
    errors.push(...problems);
    if (problems.length) continue;
    if (isMeta) {
      if (entry.field_path === 'title') title = value; else excerpt = value;
    } else if (entry.kind === 'diagram_label' && block?.type === 'diagram') {
      const list = labelEdits.get(block.id) ?? mermaidLabels(block.source).map(l => l.text);
      list[bracketIndex(entry.field_path)] = value;
      labelEdits.set(block.id, list);
    } else if (entry.kind === 'widget_text' && block?.type === 'interactive') {
      const map = widgetEdits.get(block.id) ?? new Map<string, string>();
      map.set(/\[([^\]]+)\]/.exec(entry.field_path)?.[1] ?? '', value);
      widgetEdits.set(block.id, map);
    } else if (block && !setAt(block, parsePath(entry.field_path), value)) {
      errors.push({ key: entry.key, code: 'field_missing', message: 'field not found in the source block' });
    }
  }
  for (const [id, texts] of labelEdits) {
    const block = blocks.get(id);
    if (block?.type === 'diagram') block.source = replaceMermaidLabels(block.source, texts);
  }
  for (const [id, map] of widgetEdits) {
    const block = blocks.get(id);
    if (block?.type === 'interactive') block.html = replaceWidgetTexts(block.html, map);
  }
  return { title, excerpt, document, errors };
}

/**
 * The document with every translatable text emptied (Mermaid labels and widget texts included): equal for
 * a source and its translation exactly when ids, types, nesting, URLs, code and diagram topology survived.
 */
export function structuralSkeleton(doc: ArticleDocument): string {
  const clone = structuredClone(doc);
  const visit = (blocks: Block[]) => {
    for (const block of blocks) {
      for (const [path] of stringFields(block)) setAt(block, parsePath(path), '');
      if (block.type === 'diagram') block.source = mermaidSkeleton(block.source);
      if (block.type === 'interactive') block.html = widgetSkeleton(block.html);
      for (const list of childBlockLists(block)) visit(list);
    }
  };
  visit(clone.blocks);
  return JSON.stringify(clone);
}
