/** Data blocks: table, chart, diagram and survey (interactive lives in ./interactive). */
import type { BlockDefinition, BlockValidator, RawBlock } from '../block-definition';
import { CHART_KINDS, LIMITS, TABLE_COLUMN_TYPES, TABLE_MOBILE_MODES } from '../schema';
import type { ChartBlock, ChartSeries, DiagramBlock, SurveyBlock, SurveyOption, TableBlock, TableColumn } from '../schema';
import { fence, gfmTable, mdCaption } from '../markdown-format';
import { CELL_FORMATS, CURRENCY_RE, NUMERIC_COLUMN_TYPES, canonicalCell, columnOf, formatCell, isDataTable, isProseColumn } from '../table-data';
import { blockId, inline, short } from './schema-fragments';
import { ID_RE, flag, isInt, isObj, isOneOf, plain, plainLength } from './shared';

const T = LIMITS.text;
const S = LIMITS.shortText;

/** Example data table using the optional fields (also returned by the block_schema MCP tool). */
export const TABLE_EXAMPLE = {
  type: 'table', title: 'Bảng giá gói', caption: 'Giá đã gồm VAT.',
  headers: ['Gói', 'Giá', 'Giảm', 'Ra mắt', 'Hỗ trợ 24/7', 'Chi tiết', 'Nhãn'],
  columns: [
    { type: 'text' }, { type: 'currency', currency: 'VND', filter: true }, { type: 'percent', decimals: 1 }, { type: 'date' },
    { type: 'boolean', filter: true }, { type: 'link' }, { type: 'badge', filter: true },
  ],
  rows: [
    ['**Pro**', '490000', '12.5', '2026-01-15', 'true', '[Xem gói](https://zuey.me/pricing)', 'Phổ biến'],
    ['Cơ bản', '190000', '0', '2025-06', 'false', 'https://zuey.me/pricing', 'Mới'],
  ],
  sortable: true, search: true, stickyHeader: true, csv: true, mobile: 'cards',
} as const;

/** Column types, or undefined when absent or every column is plain text; null when invalid (errors recorded). */
function tableColumns(v: BlockValidator, raw: RawBlock, count: number, path: string): TableColumn[] | undefined | null {
  if (raw.columns === undefined || raw.columns === null) return undefined;
  if (!Array.isArray(raw.columns) || raw.columns.length !== count) {
    v.err(`${path}.columns`, `must be an array of ${count} column objects (one per header)`);
    return null;
  }
  const out: TableColumn[] = [];
  raw.columns.forEach((c: unknown, i: number) => {
    const p = `${path}.columns[${i}]`;
    if (!isObj(c)) { v.err(p, 'must be an object {type, decimals?, currency?, filter?}'); return; }
    const type = c.type ?? 'text';
    if (!isOneOf(TABLE_COLUMN_TYPES, type)) { v.err(`${p}.type`, `must be one of ${TABLE_COLUMN_TYPES.join(', ')}`); return; }
    const col: TableColumn = { type };
    let ok = true;
    if (c.decimals !== undefined && c.decimals !== null) {
      if (!NUMERIC_COLUMN_TYPES.includes(type)) { v.err(`${p}.decimals`, 'only number, currency and percent columns take decimals'); ok = false; }
      else if (!isInt(c.decimals, 0, LIMITS.tableDecimalsMax)) { v.err(`${p}.decimals`, `must be an integer from 0 to ${LIMITS.tableDecimalsMax}`); ok = false; }
      else col.decimals = c.decimals;
    }
    if (type === 'currency') {
      if (typeof c.currency !== 'string' || !CURRENCY_RE.test(c.currency)) { v.err(`${p}.currency`, 'currency columns need an ISO 4217 code such as VND or USD'); ok = false; }
      else col.currency = c.currency;
    } else if (c.currency !== undefined && c.currency !== null) { v.err(`${p}.currency`, 'only currency columns take currency'); ok = false; }
    const filter = flag(v, c, 'filter', p);
    if (filter === null) ok = false;
    else if (filter) col.filter = true;
    if (ok) out.push(col);
  });
  if (out.length !== count) return null;
  return out.every(c => c.type === 'text' && !c.filter) ? undefined : out;
}

/**
 * Data tables are bounded more tightly (cell length, total size) and their typed cells must hold the canonical
 * value of their type; booleans are stored lowercase. Returns false when a cell is rejected.
 */
function checkDataCells(v: BlockValidator, b: TableBlock, path: string): boolean {
  let ok = true;
  let total = b.headers.reduce((n, h) => n + h.length, 0);
  b.rows.forEach((row, r) => row.forEach((cell, c) => {
    const p = `${path}.rows[${r}][${c}]`;
    total += cell.length;
    if (cell.length > LIMITS.dataTableCell) { v.err(p, `must be at most ${LIMITS.dataTableCell} characters in a data table`); ok = false; return; }
    const col = columnOf(b, c);
    const value = canonicalCell(col.type, cell);
    if (value === null) { v.err(p, `must be ${CELL_FORMATS[col.type]} (column "${b.headers[c] ?? ''}" is ${col.type}), or empty`); ok = false; return; }
    row[c] = value;
  }));
  if (total > LIMITS.dataTableChars) { v.err(`${path}.rows`, `a data table holds at most ${LIMITS.dataTableChars} characters in total`); ok = false; }
  return ok;
}

/** Headers with the unit of currency and percent columns, for Markdown and Zuey AI (cells stay canonical). */
function labelledHeaders(b: TableBlock): string[] {
  return b.headers.map((h, i) => {
    const col = columnOf(b, i);
    return col.type === 'currency' ? `${h} (${col.currency ?? ''})` : col.type === 'percent' ? `${h} (%)` : h;
  });
}

export const table: BlockDefinition<TableBlock> = {
  type: 'table',
  validate(v, raw, { id, path }) {
    const headers = v.strArray(raw, 'headers', path, LIMITS.tableColumns, S, 1);
    if (!headers) return undefined;
    if (!Array.isArray(raw.rows) || raw.rows.length > LIMITS.tableRows) {
      v.err(`${path}.rows`, `must be an array of at most ${LIMITS.tableRows} rows`);
      return undefined;
    }
    const rows: string[][] = [];
    raw.rows.forEach((row: unknown, i: number) => {
      const p = `${path}.rows[${i}]`;
      if (!Array.isArray(row) || row.length !== headers.length || !row.every(c => typeof c === 'string' && c.length <= T)) {
        v.err(p, `must be an array of ${headers.length} strings (one per header)`);
        return;
      }
      rows.push(row.map(String));
    });
    const columns = tableColumns(v, raw, headers.length, path);
    const title = v.str(raw, 'title', path, LIMITS.tableTitle, { optional: true })?.trim();
    const titleOk = !title || !/[\r\n]/.test(title);
    if (!titleOk) v.err(`${path}.title`, 'must be one line');
    const caption = v.str(raw, 'caption', path, S, { optional: true })?.trim();
    const sortable = flag(v, raw, 'sortable', path);
    const search = flag(v, raw, 'search', path);
    const stickyHeader = flag(v, raw, 'stickyHeader', path);
    const csv = flag(v, raw, 'csv', path);
    const mobile = raw.mobile ?? undefined;
    const mobileOk = mobile === undefined || isOneOf(TABLE_MOBILE_MODES, mobile);
    if (!mobileOk) v.err(`${path}.mobile`, `must be one of ${TABLE_MOBILE_MODES.join(', ')}`);
    if (rows.length !== raw.rows.length || columns === null || sortable === null || search === null || stickyHeader === null || csv === null || !mobileOk || !titleOk) {
      return undefined;
    }
    const block: TableBlock = {
      id, type: 'table', headers, rows,
      ...(columns ? { columns } : {}),
      ...(title ? { title } : {}),
      ...(caption ? { caption } : {}),
      ...(sortable ? { sortable } : {}),
      ...(search ? { search } : {}),
      ...(stickyHeader ? { stickyHeader } : {}),
      ...(csv ? { csv } : {}),
      ...(mobile === 'cards' ? { mobile: 'cards' as const } : {}),
    };
    return !isDataTable(block) || checkDataCells(v, block, path) ? block : undefined;
  },
  markdown: b => (isDataTable(b)
    ? `${b.title ? `**${b.title}**\n\n` : ''}${gfmTable(labelledHeaders(b), b.rows)}${mdCaption(b.caption)}`
    : gfmTable(b.headers, b.rows)),
  // Typed cells are indexed as stored and as readers see them, so both `490000` and `490.000` find the row.
  searchText: b => [
    ...(b.title ? [b.title] : []), ...b.headers,
    ...b.rows.flatMap(row => row.map((raw, c) => {
      const col = columnOf(b, c);
      return raw && !isProseColumn(col) && col.type !== 'link' ? `${raw} ${formatCell(col, raw)}` : raw;
    })),
    ...(b.caption ? [b.caption] : []),
  ].map(plain),
  aiText: b => [
    ...(b.title ? [b.title] : []),
    ...[labelledHeaders(b), ...b.rows].map(r => r.map(plain).join(' | ')),
    ...(b.caption ? [plain(b.caption)] : []),
  ].join('\n'),
  weight: b => [b.headers, ...b.rows].flat().reduce((n, s) => n + plainLength(s), 0) + plainLength(b.title) + plainLength(b.caption),
  schema: {
    properties: {
      headers: { type: 'array', minItems: 1, maxItems: LIMITS.tableColumns, items: short },
      rows: { type: 'array', maxItems: LIMITS.tableRows, items: { type: 'array', items: inline, description: 'Same length as headers' } },
      columns: {
        type: 'array', maxItems: LIMITS.tableColumns,
        description: `One per header; cells of a typed column hold its canonical value, or are empty. Cell formats: ${TABLE_COLUMN_TYPES.map(t => `${t}: ${CELL_FORMATS[t]}`).join('; ')}. Values are shown formatted (1.234.567 ₫, 12,5%, 15/01/2026) and sort by value`,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...TABLE_COLUMN_TYPES], default: 'text' },
            decimals: { type: 'integer', minimum: 0, maximum: LIMITS.tableDecimalsMax, description: 'number, currency and percent only: fixed decimals' },
            currency: { type: 'string', pattern: CURRENCY_RE.source, description: 'Required for currency columns: ISO 4217 code such as VND or USD' },
            filter: { type: 'boolean', default: false, description: 'Readers get a filter for this column: a from/to range for numbers and dates, a value list (or text box) otherwise' },
          },
        },
      },
      title: { type: 'string', maxLength: LIMITS.tableTitle, description: 'Plain-text name above the table (its accessible name and the CSV file name)' },
      caption: { ...short, description: 'Inline text under the table' },
      sortable: { type: 'boolean', default: false, description: 'Column headers become sort buttons (ascending, descending, original order)' },
      search: { type: 'boolean', default: false, description: 'A search box filters rows by every word (accents ignored)' },
      stickyHeader: { type: 'boolean', default: false, description: 'The table scrolls inside a box at most 70% of the screen tall, keeping the header row in view' },
      csv: { type: 'boolean', default: false, description: 'A button downloads the rows on screen as CSV (UTF-8, formula-safe)' },
      mobile: { type: 'string', enum: [...TABLE_MOBILE_MODES], default: 'scroll', description: 'Narrow screens: scroll sideways, or show each row as a card of label/value pairs' },
    },
    required: ['headers', 'rows'],
    extra: { examples: [TABLE_EXAMPLE] },
  },
};

export const chart: BlockDefinition<ChartBlock> = {
  type: 'chart',
  validate(v, raw, { id, path }) {
    if (!isOneOf(CHART_KINDS, raw.kind)) { v.err(`${path}.kind`, `must be one of ${CHART_KINDS.join(', ')}`); return undefined; }
    const kind = raw.kind;
    const title = v.str(raw, 'title', path, S, { optional: true });
    const labels = v.strArray(raw, 'labels', path, LIMITS.chartLabels, 120, 1);
    if (!labels) return undefined;
    if (!Array.isArray(raw.series) || raw.series.length < 1 || raw.series.length > LIMITS.chartSeries) {
      v.err(`${path}.series`, `must contain 1–${LIMITS.chartSeries} series`);
      return undefined;
    }
    const series: ChartSeries[] = [];
    raw.series.forEach((s: unknown, i: number) => {
      const p = `${path}.series[${i}]`;
      if (!isObj(s)) { v.err(p, 'must be an object {name, data}'); return; }
      const name = v.str(s, 'name', p, 120);
      const data = s.data;
      if (!Array.isArray(data) || !data.every(n => typeof n === 'number' && Number.isFinite(n))) {
        v.err(`${p}.data`, 'must be an array of finite numbers');
        return;
      }
      if (data.length !== labels.length) {
        v.err(`${p}.data`, `length ${data.length} must equal labels length ${labels.length}`);
        return;
      }
      if (name !== undefined) series.push({ name, data: data.map(Number) });
    });
    if (series.length !== raw.series.length) return undefined;
    return { id, type: 'chart', kind, labels, series, ...(title ? { title } : {}) };
  },
  markdown(b) {
    const title = b.title ? `**${b.title}** (${b.kind} chart)` : `*${b.kind} chart*`;
    const headers = ['Label', ...b.series.map(s => s.name)];
    const rows = b.labels.map((label, i) => [label, ...b.series.map(s => String(s.data[i]))]);
    return `${title}\n\n${gfmTable(headers, rows)}`;
  },
  searchText: b => [b.title ?? '', ...b.labels, ...b.series.map(s => s.name)],
  aiText: b => [b.title ?? '', b.labels.join(', ')].join(' '),
  weight: b => 40 + b.labels.join('').length + b.series.length * b.labels.length * 3,
  schema: {
    properties: {
      kind: { type: 'string', enum: [...CHART_KINDS] },
      title: short,
      labels: { type: 'array', minItems: 1, maxItems: LIMITS.chartLabels, items: { type: 'string', maxLength: 120 } },
      series: {
        type: 'array', minItems: 1, maxItems: LIMITS.chartSeries,
        items: { type: 'object', required: ['name', 'data'], properties: { name: { type: 'string', maxLength: 120 }, data: { type: 'array', items: { type: 'number' }, description: 'Same length as labels' } } },
      },
    },
    required: ['kind', 'labels', 'series'],
  },
};

export const diagram: BlockDefinition<DiagramBlock> = {
  type: 'diagram',
  validate(v, raw, { id, path }) {
    if (raw.syntax !== undefined && raw.syntax !== 'mermaid') { v.err(`${path}.syntax`, "must be 'mermaid'"); return undefined; }
    const source = v.str(raw, 'source', path, LIMITS.mermaid, { nonEmpty: true });
    const caption = v.str(raw, 'caption', path, S, { optional: true });
    return source === undefined ? undefined : { id, type: 'diagram', syntax: 'mermaid', source, ...(caption ? { caption } : {}) };
  },
  markdown: b => fence(b.source, 'mermaid') + mdCaption(b.caption),
  searchText: b => [plain(b.caption)],
  aiText: b => plain(b.caption),
  weight: b => b.source.length + plainLength(b.caption),
  schema: { properties: { syntax: { type: 'string', const: 'mermaid' }, source: { type: 'string', maxLength: LIMITS.mermaid }, caption: short }, required: ['source'] },
};

export const survey: BlockDefinition<SurveyBlock> = {
  type: 'survey',
  validate(v, raw, { id, path }) {
    const question = v.str(raw, 'question', path, S, { nonEmpty: true });
    if (!Array.isArray(raw.options) || raw.options.length < LIMITS.surveyOptionsMin || raw.options.length > LIMITS.surveyOptionsMax) {
      v.err(`${path}.options`, `must contain ${LIMITS.surveyOptionsMin}–${LIMITS.surveyOptionsMax} options`);
      return undefined;
    }
    const options: SurveyOption[] = [];
    const optionIds = new Set<string>();
    raw.options.forEach((opt: unknown, i: number) => {
      const p = `${path}.options[${i}]`;
      if (!isObj(opt)) { v.err(p, 'must be an object {id, label}'); return; }
      const label = v.str(opt, 'label', p, 200, { nonEmpty: true });
      let optId = typeof opt.id === 'string' && opt.id ? opt.id : '';
      if (!optId) { let n = i + 1; do optId = `o${n++}`; while (optionIds.has(optId)); }
      if (!ID_RE.test(optId)) { v.err(`${p}.id`, 'must match [A-Za-z0-9_-]{1,64}'); return; }
      if (optionIds.has(optId)) { v.err(`${p}.id`, `duplicate option id "${optId}"`); return; }
      optionIds.add(optId);
      if (label !== undefined) options.push({ id: optId, label });
    });
    if (raw.allowMultiple !== undefined && typeof raw.allowMultiple !== 'boolean') {
      v.err(`${path}.allowMultiple`, 'must be a boolean');
      return undefined;
    }
    if (question === undefined || options.length !== raw.options.length) return undefined;
    return { id, type: 'survey', question, options, allowMultiple: raw.allowMultiple === true };
  },
  markdown(b, ctx) {
    const options = b.options.map(o => `- ${o.label}`).join('\n');
    const where = ctx.articleUrl ? `(vote at ${ctx.articleUrl})` : '(vote on the article page)';
    return `**Survey:** ${b.question}\n\n${options}\n\n${where}`;
  },
  searchText: b => [b.question, ...b.options.map(o => o.label)],
  aiText: b => [b.question, ...b.options.map(o => o.label)].join(' '),
  weight: b => plainLength(b.question) + b.options.reduce((n, o) => n + o.label.length, 0),
  schema: {
    properties: {
      question: short,
      options: {
        type: 'array', minItems: LIMITS.surveyOptionsMin, maxItems: LIMITS.surveyOptionsMax,
        items: { type: 'object', required: ['label'], properties: { id: blockId, label: { type: 'string', maxLength: 200 } } },
      },
      allowMultiple: { type: 'boolean', default: false },
    },
    required: ['question', 'options'],
  },
};
