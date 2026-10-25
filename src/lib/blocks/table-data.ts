/**
 * Data table helpers shared by validation, the server and client renderers, email and Studio: canonical cell
 * values per column type, deterministic formatting (the same text on the server and in every browser, so
 * hydration matches), sorting, search, filters and CSV export. Client-safe: no Node APIs, no Intl data.
 */
import { inlineToPlain } from './inline';
import { LIMITS } from './schema';
import type { TableBlock, TableColumn, TableColumnType } from './schema';

export const NUMERIC_COLUMN_TYPES: readonly TableColumnType[] = ['number', 'currency', 'percent'];
/** Badge cells are short labels. */
export const BADGE_MAX = 100;
/** Categorical filters list at most this many distinct values; beyond that the filter is a text box. */
export const FILTER_CHOICES_MAX = 50;

/** Canonical number: optional minus, up to 15 integer digits, an optional fraction, no grouping. */
export const NUMBER_RE = /^-?\d{1,15}(?:\.\d{1,10})?$/;
/** ISO date: YYYY, YYYY-MM or YYYY-MM-DD. */
export const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
export const CURRENCY_RE = /^[A-Z]{3}$/;
const MD_LINK_RE = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/;

const TEXT_COLUMN: TableColumn = { type: 'text' };

export { isDataTable } from './schema';

export function columnOf(b: TableBlock, index: number): TableColumn {
  return b.columns?.[index] ?? TEXT_COLUMN;
}

/** Columns whose cells are prose (translated, indexed as text); the others hold data such as numbers or URLs. */
export function isProseColumn(col: TableColumn): boolean {
  return col.type === 'text' || col.type === 'badge';
}

export function isNumericColumn(col: TableColumn): boolean {
  return NUMERIC_COLUMN_TYPES.includes(col.type);
}

function isDate(raw: string): boolean {
  const m = DATE_RE.exec(raw);
  if (!m) return false;
  const [, y, mo, d] = m;
  if (mo === undefined) return true;
  const month = Number(mo);
  if (month < 1 || month > 12) return false;
  if (d === undefined) return true;
  const day = Number(d);
  const last = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
  return day >= 1 && day <= last;
}

function isHttpsUrl(raw: string): boolean {
  if (raw.length > LIMITS.url || /\s/.test(raw)) return false;
  try {
    const url = new URL(raw);
    // `https://zuey.me@evil.com` would show as a zuey.me address, so links never carry credentials.
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** A link cell: a bare https URL or a single `[label](https://…)`. */
export function linkCell(raw: string): { href: string; label: string } | null {
  const md = MD_LINK_RE.exec(raw);
  if (md?.[1] && md[2] && isHttpsUrl(md[2])) return { href: md[2], label: md[1] };
  if (!isHttpsUrl(raw)) return null;
  const shown = raw.replace(/^https:\/\//i, '').replace(/\/$/, '');
  return { href: raw, label: shown };
}

/** Drops leading zeros (`00012` → `12`) and the sign of zero (`-0.0` → `0.0`) from a value matching NUMBER_RE. */
export function normalizeNumber(raw: string): string {
  const negative = raw.startsWith('-');
  const [int = '', frac] = (negative ? raw.slice(1) : raw).split('.');
  const digits = int.replace(/^0+(?=\d)/, '');
  const zero = /^0+$/.test(digits) && (!frac || /^0+$/.test(frac));
  return `${negative && !zero ? '-' : ''}${digits}${frac === undefined ? '' : `.${frac}`}`;
}

/** Canonical value of a cell for its column type ('' stays empty), or null when the value does not fit the type. */
export function canonicalCell(type: TableColumnType, raw: string): string | null {
  if (raw === '') return '';
  switch (type) {
    case 'text': return raw;
    case 'number': case 'currency': case 'percent': return NUMBER_RE.test(raw) ? normalizeNumber(raw) : null;
    case 'date': return isDate(raw) ? raw : null;
    case 'boolean': {
      const v = raw.toLowerCase();
      return v === 'true' || v === 'false' ? v : null;
    }
    case 'link': return linkCell(raw) ? raw : null;
    case 'badge': return raw.length <= BADGE_MAX && !/[\r\n]/.test(raw) ? raw : null;
  }
}

/** What a cell of each type must look like (validation messages and the schema). */
export const CELL_FORMATS: Record<TableColumnType, string> = {
  text: 'inline text',
  number: 'a plain number such as 1234.5 or -3 (no thousands separators)',
  currency: 'a plain number such as 1234.5 (the column sets the currency)',
  percent: 'a plain number of percent such as 12.5 for 12.5%',
  date: 'an ISO date: YYYY, YYYY-MM or YYYY-MM-DD',
  boolean: 'true or false',
  link: 'an https:// URL or [label](https://…)',
  badge: `a one-line label of at most ${BADGE_MAX} characters`,
};

// ---------- formatting ----------

/**
 * Number and date style of the reader's edition: Vietnamese (1.234,5 · 15/01/2026 · Có) for `vi`, English
 * (1,234.5 · Jan 15, 2026 · Yes) for every other locale, where a Vietnamese decimal comma would misread.
 */
export type TableLocale = 'vi' | 'en';

export function tableLocale(locale: string | undefined): TableLocale {
  return locale === undefined || locale === 'vi' ? 'vi' : 'en';
}

const SEPARATORS: Record<TableLocale, { group: string; decimal: string }> = {
  vi: { group: '.', decimal: ',' },
  en: { group: ',', decimal: '.' },
};
const YES_NO: Record<TableLocale, [string, string]> = { vi: ['Có', 'Không'], en: ['Yes', 'No'] };
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CURRENCY_PREFIX: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
const CURRENCY_SUFFIX: Record<string, string> = { VND: '₫' };

/** Grouped number (1.234.567,5 in vi, 1,234,567.5 in en), computed by hand so every runtime prints the same text. */
export function formatNumber(raw: string, decimals?: number, locale: TableLocale = 'vi'): string {
  let s = NUMBER_RE.test(raw) ? normalizeNumber(raw) : raw;
  if (decimals !== undefined) s = normalizeNumber(Number(s).toFixed(decimals));
  const { group, decimal } = SEPARATORS[locale];
  const negative = s.startsWith('-');
  const [int = '', frac] = (negative ? s.slice(1) : s).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${negative ? '-' : ''}${grouped}${frac ? `${decimal}${frac}` : ''}`;
}

function formatDate(raw: string, locale: TableLocale): string {
  const m = DATE_RE.exec(raw);
  if (!m) return raw;
  const [, y = '', mo, d] = m;
  if (mo === undefined) return y;
  if (locale === 'en') {
    const month = MONTHS_EN[Number(mo) - 1] ?? mo;
    return d === undefined ? `${month} ${y}` : `${month} ${Number(d)}, ${y}`;
  }
  return d === undefined ? `${mo}/${y}` : `${d}/${mo}/${y}`;
}

/** Display text of a non-empty cell (inline markers removed for text cells). */
export function formatCell(col: TableColumn, raw: string, locale: TableLocale = 'vi'): string {
  if (raw === '') return '';
  switch (col.type) {
    case 'text': return inlineToPlain(raw);
    case 'badge': return raw;
    case 'number': return formatNumber(raw, col.decimals, locale);
    case 'percent': return `${formatNumber(raw, col.decimals, locale)}%`;
    case 'currency': {
      const code = col.currency ?? '';
      const n = formatNumber(raw, col.decimals, locale);
      const prefix = CURRENCY_PREFIX[code];
      if (prefix) return n.startsWith('-') ? `-${prefix}${n.slice(1)}` : `${prefix}${n}`;
      return `${n} ${CURRENCY_SUFFIX[code] ?? code}`;
    }
    case 'date': return formatDate(raw, locale);
    case 'boolean': return YES_NO[locale][raw === 'true' ? 0 : 1];
    case 'link': return linkCell(raw)?.label ?? raw;
  }
}
/** Stable tone (0–5) for a badge value, so equal labels share a colour. */
export function badgeTone(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h % 6;
}

// ---------- search, filters and sort ----------

/** Lowercase without diacritics (đ → d), so "ha noi" finds "Hà Nội". */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

export type ColumnFilter =
  | { kind: 'value'; value: string }
  | { kind: 'contains'; value: string }
  | { kind: 'range'; min: string; max: string };

export interface TableSort { column: number; dir: 'asc' | 'desc' }

export interface TableView {
  query: string;
  filters: Record<number, ColumnFilter>;
  sort: TableSort | null;
}

/** Filter control a column offers: a range for numbers and dates, a choice list or a text box otherwise. */
export function filterKind(col: TableColumn): 'range' | 'value' {
  return isNumericColumn(col) || col.type === 'date' ? 'range' : 'value';
}

/** Distinct non-empty values of a categorical column in display order, or null when there are too many to list. */
export function filterChoices(b: TableBlock, column: number, locale: TableLocale = 'vi'): string[] | null {
  const col = columnOf(b, column);
  const seen = new Set<string>();
  for (const row of b.rows) {
    const v = row[column] ?? '';
    if (v) seen.add(v);
    if (seen.size > FILTER_CHOICES_MAX) return null;
  }
  return [...seen].sort((a, z) => compareKeys(formatCell(col, a, locale), formatCell(col, z, locale)));
}

/** Pads a partial ISO date to its first day, so ranges compare whole dates. */
function dateKey(raw: string): string {
  return raw.length === 4 ? `${raw}-01-01` : raw.length === 7 ? `${raw}-01` : raw;
}

function inRange(col: TableColumn, raw: string, min: string, max: string): boolean {
  if (!min && !max) return true;
  if (raw === '') return false;
  if (col.type === 'date') {
    const key = dateKey(raw);
    return (!min || key >= dateKey(min)) && (!max || key <= dateKey(max));
  }
  const n = Number(raw);
  const lo = min ? Number(min) : NaN;
  const hi = max ? Number(max) : NaN;
  return (Number.isNaN(lo) || n >= lo) && (Number.isNaN(hi) || n <= hi);
}

export function isFilterActive(f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  return f.kind === 'range' ? Boolean(f.min.trim() || f.max.trim()) : Boolean(f.value.trim());
}

let collator: Intl.Collator | null = null;

/** Numbers by value, text in Vietnamese order (numeric-aware, case and accent insensitive). */
function compareKeys(a: number | string, z: number | string): number {
  if (typeof a === 'number' && typeof z === 'number') return a - z;
  collator ??= new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
  return collator.compare(String(a), String(z));
}

/**
 * Per-table work done once instead of on every keystroke or comparison: display text, folded cell text, the
 * folded search text of each row and (on first use) each column's sort keys. Inline Markdown is parsed once per
 * cell, so search is a string scan and sort compares ready keys.
 */
interface TableIndex {
  shown: string[][];
  folded: string[][];
  haystack: string[];
  sortKeys: Map<number, Array<number | string>>;
}

const indexes = new WeakMap<TableBlock, Partial<Record<TableLocale, TableIndex>>>();

/** Cells processed while building indexes (tests use it to check the work stays one pass per table). */
export const tableWork = { cells: 0 };

function tableIndex(b: TableBlock, locale: TableLocale): TableIndex {
  const cached = indexes.get(b)?.[locale];
  if (cached) return cached;
  const columns = b.headers.map((_, i) => columnOf(b, i));
  const shown = b.rows.map(row => row.map((raw, c) => formatCell(columns[c] ?? TEXT_COLUMN, raw, locale)));
  tableWork.cells += b.rows.reduce((n, row) => n + row.length, 0);
  const folded = shown.map(row => row.map(foldText));
  const haystack = b.rows.map((row, r) => foldText(row.join(' ')) + ' ' + (folded[r] ?? []).join(' '));
  const index: TableIndex = { shown, folded, haystack, sortKeys: new Map() };
  indexes.set(b, { ...indexes.get(b), [locale]: index });
  return index;
}

function columnSortKeys(b: TableBlock, index: TableIndex, column: number): Array<number | string> {
  const cached = index.sortKeys.get(column);
  if (cached) return cached;
  const col = columnOf(b, column);
  const keys = b.rows.map((row, r) => {
    const raw = row[column] ?? '';
    if (isNumericColumn(col)) return Number(raw);
    if (col.type === 'boolean') return raw === 'true' ? 1 : 0;
    if (col.type === 'date') return dateKey(raw);
    return index.shown[r]?.[column] ?? '';
  });
  index.sortKeys.set(column, keys);
  return keys;
}

/** Indexes of the rows to show, in display order: search (every word), then filters, then a stable sort (empty cells last). */
export function visibleRows(b: TableBlock, view: TableView, locale: TableLocale = 'vi'): number[] {
  const index = tableIndex(b, locale);
  const words = foldText(view.query).split(/\s+/).filter(Boolean);
  const filters = Object.entries(view.filters).flatMap(([k, f]) => (isFilterActive(f) ? [{ column: Number(k), f }] : []));
  let order = b.rows.map((_, i) => i).filter(r => {
    const row = b.rows[r] ?? [];
    if (words.length) {
      const haystack = index.haystack[r] ?? '';
      if (!words.every(w => haystack.includes(w))) return false;
    }
    return filters.every(({ column, f }) => {
      const raw = row[column] ?? '';
      switch (f.kind) {
        case 'value': return !f.value || raw === f.value;
        case 'contains': return !f.value || (index.folded[r]?.[column] ?? '').includes(foldText(f.value.trim()));
        case 'range': return inRange(columnOf(b, column), raw, f.min.trim(), f.max.trim());
      }
    });
  });
  const sort = view.sort;
  if (sort) {
    const keys = columnSortKeys(b, index, sort.column);
    const sign = sort.dir === 'asc' ? 1 : -1;
    order = [...order].sort((r1, r2) => {
      const a = b.rows[r1]?.[sort.column] ?? '';
      const z = b.rows[r2]?.[sort.column] ?? '';
      if (!a || !z) return a ? -1 : z ? 1 : 0;
      return sign * compareKeys(keys[r1] ?? '', keys[r2] ?? '');
    });
  }
  return order;
}
// ---------- CSV ----------

/**
 * Cells a spreadsheet would run as a formula (CSV injection); such cells get a leading apostrophe. Full-width
 * signs count (some CJK spreadsheets read them as formulas), and so do leading zero-width characters.
 */
const FORMULA_START = /^[\u200B-\u200D\u2060\uFEFF]*[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;

/**
 * One CSV field: formula-like values are neutralised with a leading `'`, then quoted when needed. Validated
 * numbers (e.g. -12.5 in a number column) can only be digits, so they stay numeric.
 */
export function csvField(value: string, numeric = false): string {
  const safe = FORMULA_START.test(value) && !(numeric && NUMBER_RE.test(value)) ? `'${value}` : value;
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Machine-readable cell value: plain text for text cells, the URL for links, the canonical value otherwise. */
function csvValue(col: TableColumn, raw: string): string {
  if (col.type === 'text') return inlineToPlain(raw);
  if (col.type === 'link') return linkCell(raw)?.href ?? raw;
  return raw;
}

/** RFC 4180 CSV (CRLF, UTF-8 BOM for spreadsheets) of the header and the given rows. */
export function tableCsv(b: TableBlock, rows: number[]): string {
  const columns = b.headers.map((_, i) => columnOf(b, i));
  const lines = [b.headers.map(h => csvField(inlineToPlain(h)))];
  for (const r of rows) {
    const row = b.rows[r] ?? [];
    lines.push(columns.map((col, c) => csvField(csvValue(col, row[c] ?? ''), isNumericColumn(col))));
  }
  return `﻿${lines.map(l => l.join(',')).join('\r\n')}\r\n`;
}

/** Download name from the title (ASCII slug), else the block id. */
export function csvFilename(b: TableBlock): string {
  const slug = foldText(b.title ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || `table-${b.id}`}.csv`;
}

/**
 * Where each new header came from when an editor rewrites the header list: the old column index, or -1 for a new
 * column. Same count means renamed in place; otherwise headers match by text, so deleting or inserting a column
 * keeps the other columns' settings and cells with their header.
 */
export function headerSources(oldHeaders: string[], newHeaders: string[]): number[] {
  if (oldHeaders.length === newHeaders.length) return newHeaders.map((_, i) => i);
  const used = new Set<number>();
  return newHeaders.map(h => {
    const i = oldHeaders.findIndex((o, j) => !used.has(j) && o.trim() === h.trim());
    if (i >= 0) used.add(i);
    return i;
  });
}
