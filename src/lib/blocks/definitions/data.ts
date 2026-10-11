/** Data and interactive blocks: table, chart, diagram, survey and interactive. */
import type { BlockDefinition } from '../block-definition';
import { CHART_KINDS, LIMITS } from '../schema';
import type { ChartBlock, ChartSeries, DiagramBlock, InteractiveBlock, SurveyBlock, SurveyOption, TableBlock } from '../schema';
import { fence, gfmTable, mdCaption } from '../markdown-format';
import { blockId, inline, short } from './schema-fragments';
import { ID_RE, isInt, isObj, isOneOf, plain, plainLength } from './shared';

const T = LIMITS.text;
const S = LIMITS.shortText;

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
    return rows.length === raw.rows.length ? { id, type: 'table', headers, rows } : undefined;
  },
  markdown: b => gfmTable(b.headers, b.rows),
  searchText: b => [...b.headers, ...b.rows.flat()].map(plain),
  aiText: b => [b.headers, ...b.rows].map(r => r.map(plain).join(' | ')).join('\n'),
  weight: b => [b.headers, ...b.rows].flat().reduce((n, s) => n + plainLength(s), 0),
  schema: {
    properties: {
      headers: { type: 'array', minItems: 1, maxItems: LIMITS.tableColumns, items: short },
      rows: { type: 'array', maxItems: LIMITS.tableRows, items: { type: 'array', items: inline, description: 'Same length as headers' } },
    },
    required: ['headers', 'rows'],
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

export const interactive: BlockDefinition<InteractiveBlock> = {
  type: 'interactive',
  validate(v, raw, { id, path }) {
    const title = v.str(raw, 'title', path, LIMITS.shortText, { nonEmpty: true });
    const html = v.str(raw, 'html', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const css = v.str(raw, 'css', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const js = v.str(raw, 'js', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const caption = v.str(raw, 'caption', path, LIMITS.shortText, { optional: true });
    if (html.length + css.length + js.length > LIMITS.interactiveTotal) {
      v.err(path, `html + css + js must be at most ${LIMITS.interactiveTotal} characters in total`);
      return undefined;
    }
    if (!html.trim() && !js.trim()) { v.err(`${path}.html`, 'html or js must not be empty'); return undefined; }
    if (raw.height !== undefined && !isInt(raw.height, LIMITS.interactiveHeightMin, LIMITS.interactiveHeightMax)) {
      v.err(`${path}.height`, `must be an integer ${LIMITS.interactiveHeightMin}–${LIMITS.interactiveHeightMax}`);
      return undefined;
    }
    const height = typeof raw.height === 'number' ? raw.height : undefined;
    if (title === undefined) return undefined;
    return { id, type: 'interactive', title, html, css, js, ...(height ? { height } : {}), ...(caption ? { caption } : {}) };
  },
  markdown(b, ctx) {
    // Source code never leaves the sandboxed renderer through Markdown: text fallback plus a link to run it.
    const where = ctx.articleUrl ? `[Open the interactive version](${ctx.articleUrl})` : '(open the article page to run it)';
    return `**Interactive:** ${b.title}${b.caption ? `\n\n*${b.caption}*` : ''}\n\n${where}`;
  },
  // Search indexes reading text only; the demo's source is not prose.
  searchText: () => [],
  aiText: b => [b.title, plain(b.caption)].join(' '),
  weight: b => 40 + plainLength(b.title) + plainLength(b.caption),
  schema: {
    properties: {
      title: short,
      html: { type: 'string', maxLength: LIMITS.interactiveField, description: 'Body HTML' },
      css: { type: 'string', maxLength: LIMITS.interactiveField },
      js: { type: 'string', maxLength: LIMITS.interactiveField, description: 'Runs in a sandboxed opaque-origin iframe with CSP connect-src none; call zuey.fetch(url) for allowlisted GET requests via the server proxy' },
      height: { type: 'integer', minimum: LIMITS.interactiveHeightMin, maximum: LIMITS.interactiveHeightMax },
      caption: short,
    },
    required: ['title'],
  },
};
