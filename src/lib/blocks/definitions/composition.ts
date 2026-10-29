/**
 * Composition widgets: tabs, stat, steps, comparison and progress. Tabs, steps and comparison items hold
 * nested block lists (see ../nesting.ts); stat and progress are leaf blocks with bounded numeric data.
 */
import type { BlockDefinition, BlockValidator, RawBlock } from '../block-definition';
import { childContext } from '../nesting';
import type { NestContext } from '../nesting';
import {
  ANCHOR_RE, CARD_LEVELS, DEFAULT_CARD_LEVEL, LIMITS, PROGRESS_STATES, PROGRESS_VARIANTS, STAT_STATES, STAT_TRENDS,
  STEP_CONNECTORS, STEP_ORIENTATIONS, STEP_STATUSES, STEP_VARIANTS,
} from '../schema';
import type {
  Block, ComparisonBlock, ComparisonFeature, ComparisonOption, ProgressBlock, ProgressItem, ProgressThreshold, StatBlock,
  StatDelta, StatItem, StepItem, StepStatus, StepsBlock, TabItem, TabsBlock,
} from '../schema';
import { RESERVED_ANCHORS } from '../page-ids';
import { gfmTable } from '../markdown-format';
import { canonicalNumber, progressScale, progressText, statDelta, statTrend, statValue } from '../widget-format';
import { iconName, inline, ref } from './schema-fragments';
import { isInt, isObj, isOneOf, plain, plainLength } from './shared';

const S = LIMITS.shortText;
const L = LIMITS.widgetLabel;

/** Examples (also returned by the block_schema MCP tool). */
export const TABS_EXAMPLE = {
  type: 'tabs', defaultTab: 0,
  tabs: [
    { label: 'npm', anchor: 'cai-dat-npm', blocks: [{ type: 'code', language: 'bash', code: 'npm install zuey' }] },
    { label: 'bun', anchor: 'cai-dat-bun', blocks: [{ type: 'code', language: 'bash', code: 'bun add zuey' }] },
  ],
} as const;
export const STAT_EXAMPLE = {
  type: 'stat', title: 'Kết quả quý 3',
  items: [
    { label: 'Doanh thu', value: 1250000, prefix: '$', delta: { value: 12.5, decimals: 1, suffix: '%', label: 'so với quý 2' }, sparkline: [820000, 940000, 1100000, 1250000] },
    { label: 'Tỷ lệ rời bỏ', value: 2.1, decimals: 1, suffix: '%', delta: { value: -0.4, decimals: 1, suffix: ' điểm' }, state: 'positive', note: 'Thấp nhất từ trước tới nay' },
    { label: 'Người dùng', value: 48200, unit: 'người' },
  ],
} as const;
export const STEPS_EXAMPLE = {
  type: 'steps', variant: 'timeline',
  items: [
    { title: 'Thiết kế', date: 'Q1 2026', icon: 'pencil', status: 'done', blocks: [{ type: 'paragraph', text: 'Chốt phạm vi và giao diện.' }] },
    { title: 'Phát triển', date: 'Q2 2026', status: 'current', blocks: [] },
    { title: 'Ra mắt', date: 'Q3 2026', status: 'upcoming', blocks: [] },
  ],
} as const;
export const COMPARISON_EXAMPLE = {
  type: 'comparison', title: 'Chọn gói phù hợp',
  options: [
    { name: 'Miễn phí', description: 'Cho người mới bắt đầu.', pros: ['Không tốn phí'], cons: ['Giới hạn bài viết'], blocks: [] },
    { name: 'Knowledges', badge: 'Phổ biến', highlight: true, pros: ['Đọc toàn bộ', 'Hỏi Zuey AI'], blocks: [{ type: 'paragraph', text: '[Đăng ký](https://zuey.me/pricing)' }] },
  ],
  features: [
    { label: 'Bài viết miễn phí', values: [true, true] },
    { label: 'Bài viết trả phí', values: [false, true] },
    { label: 'Hỗ trợ', values: ['Cộng đồng', 'Ưu tiên'] },
  ],
} as const;
export const PROGRESS_EXAMPLE = {
  type: 'progress', variant: 'bar', title: 'Tiến độ dự án',
  thresholds: [{ at: 0, state: 'negative' }, { at: 40, state: 'warning' }, { at: 75, state: 'positive' }],
  items: [{ label: 'Backend', value: 80 }, { label: 'Frontend', value: 55, note: 'Còn trang thanh toán' }],
} as const;

// ---------- shared readers ----------

/** One-line plain text: undefined when absent (or blank and optional), null when invalid. */
function line(v: BlockValidator, o: RawBlock, key: string, path: string, max: number, required: boolean): string | undefined | null {
  if (o[key] === undefined || o[key] === null) {
    if (required) { v.err(`${path}.${key}`, 'is required'); return null; }
    return undefined;
  }
  const s = v.str(o, key, path, max);
  if (s === undefined) return null;
  const t = s.trim();
  if (/[\r\n]/.test(t)) { v.err(`${path}.${key}`, 'must be one line'); return null; }
  if (!t && required) { v.err(`${path}.${key}`, 'must not be empty'); return null; }
  return t || undefined;
}

/** Prefix or suffix printed next to a number: kept verbatim (a leading space separates it, e.g. " pts"); blank means none. */
function affixText(v: BlockValidator, o: RawBlock, key: string, path: string): string | undefined | null {
  if (o[key] === undefined || o[key] === null) return undefined;
  const s = v.str(o, key, path, LIMITS.widgetAffix);
  if (s === undefined) return null;
  if (/[\r\n]/.test(s)) { v.err(`${path}.${key}`, 'must be one line'); return null; }
  return s.trim() ? s : undefined;
}

/** Optional inline-Markdown text: undefined when absent or blank, null when invalid. */
function optInline(v: BlockValidator, o: RawBlock, key: string, path: string, max: number): string | undefined | null {
  if (o[key] === undefined || o[key] === null) return undefined;
  const s = v.str(o, key, path, max);
  if (s === undefined) return null;
  return s.trim() ? s : undefined;
}

function finiteNumber(v: BlockValidator, value: unknown, path: string): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > LIMITS.widgetNumberMax) {
    v.err(path, `must be a finite number of at most ${LIMITS.widgetNumberMax} in absolute value`);
    return null;
  }
  return value;
}

/** Optional number field: undefined when absent, null when invalid. */
function optNumber(v: BlockValidator, o: RawBlock, key: string, path: string): number | undefined | null {
  return o[key] === undefined || o[key] === null ? undefined : finiteNumber(v, o[key], `${path}.${key}`);
}

function optDecimals(v: BlockValidator, o: RawBlock, path: string): number | undefined | null {
  const d = o.decimals;
  if (d === undefined || d === null) return undefined;
  if (!isInt(d, 0, LIMITS.widgetDecimalsMax)) { v.err(`${path}.decimals`, `must be an integer 0–${LIMITS.widgetDecimalsMax}`); return null; }
  return d;
}

function optEnum<T extends string>(v: BlockValidator, list: readonly T[], o: RawBlock, key: string, path: string): T | undefined | null {
  const value = o[key];
  if (value === undefined || value === null) return undefined;
  if (!isOneOf(list, value)) { v.err(`${path}.${key}`, `must be one of ${list.join(', ')}`); return null; }
  return value;
}

/** Array field with a size range; null (with an error) when it is not one. */
function sizedArray(v: BlockValidator, value: unknown, path: string, min: number, max: number, what: string): unknown[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    v.err(path, min > 0 ? `must contain ${min}–${max} ${what}` : `must be an array of at most ${max} ${what}`);
    return null;
  }
  return value;
}

/** Nested blocks of one widget item (absent means none). */
function itemBlocks(v: BlockValidator, o: RawBlock, path: string, max: number, ctx: NestContext): Block[] | undefined {
  const raw = o.blocks === undefined ? [] : o.blocks;
  if (!sizedArray(v, raw, `${path}.blocks`, 0, max, 'blocks')) return undefined;
  return v.blocks(raw, `${path}.blocks`, childContext(ctx, 'widget'));
}

/** Validates each array entry; undefined when any entry failed. */
function eachItem<T>(raw: unknown[], read: (item: RawBlock, path: string, index: number) => T | undefined, v: BlockValidator, path: string, shape: string): T[] | undefined {
  const out: T[] = [];
  raw.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(item)) { v.err(p, `must be an object ${shape}`); return; }
    const value = read(item, p, i);
    if (value !== undefined) out.push(value);
  });
  return out.length === raw.length ? out : undefined;
}

const levelSchema = { type: 'integer', enum: [...CARD_LEVELS], default: DEFAULT_CARD_LEVEL };
const label = { type: 'string', maxLength: L, description: 'One line of plain text' };
const number = { type: 'number', minimum: -LIMITS.widgetNumberMax, maximum: LIMITS.widgetNumberMax };
const decimals = { type: 'integer', minimum: 0, maximum: LIMITS.widgetDecimalsMax, description: 'Fixed decimals shown (default 0)' };
const affix = { type: 'string', maxLength: LIMITS.widgetAffix };
const nestedBlocks = (max: number) => ({
  type: 'array', maxItems: max, items: ref('Block'), description: 'Nested blocks: anything except section, tabs, steps and comparison',
});

// ---------- tabs ----------

export const tabs: BlockDefinition<TabsBlock> = {
  type: 'tabs',
  validate(v, raw, { id, path, ctx }) {
    const list = sizedArray(v, raw.tabs, `${path}.tabs`, LIMITS.tabsMin, LIMITS.tabsMax, 'tabs');
    if (!list) return undefined;
    const level = raw.level;
    if (level !== undefined && !isOneOf(CARD_LEVELS, level)) { v.err(`${path}.level`, `must be one of ${CARD_LEVELS.join(', ')}`); return undefined; }
    const defaultTab = raw.defaultTab;
    if (defaultTab !== undefined && !isInt(defaultTab, 0, list.length - 1)) { v.err(`${path}.defaultTab`, `must be a tab index 0–${list.length - 1}`); return undefined; }
    const items = eachItem(list, (t, p) => {
      const lbl = line(v, t, 'label', p, L, true);
      let anchor = line(v, t, 'anchor', p, LIMITS.anchor, false);
      const anchorError = anchor === undefined || anchor === null ? null
        : !ANCHOR_RE.test(anchor) ? 'must be a lowercase slug (a-z, 0-9 and single hyphens)'
          : RESERVED_ANCHORS.includes(anchor) ? `"${anchor}" is used by the article page; pick another anchor` : null;
      if (anchorError) {
        if (!v.lenient) { v.err(`${p}.anchor`, anchorError); return undefined; }
        anchor = undefined;
        v.degraded();
      }
      const blocks = itemBlocks(v, t, p, LIMITS.tabChildren, ctx);
      if (!lbl || anchor === null || !blocks) return undefined;
      if (anchor !== undefined && !v.claimAnchor(anchor, `${p}.anchor`)) {
        if (!v.lenient) return undefined;
        anchor = undefined;
        v.degraded();
      }
      const tab: TabItem = { label: lbl, ...(anchor ? { anchor } : {}), blocks };
      return tab;
    }, v, `${path}.tabs`, '{label, anchor?, blocks}');
    if (!items) return undefined;
    return { id, type: 'tabs', tabs: items, ...(defaultTab ? { defaultTab } : {}), ...(level !== undefined ? { level } : {}) };
  },
  // Every panel in order under its label, like the page without JavaScript.
  markdown: (b, ctx) => b.tabs.map(t => [`${'#'.repeat(b.level ?? DEFAULT_CARD_LEVEL)} ${t.label}`, ctx.blocks(t.blocks)].filter(Boolean).join('\n\n')).join('\n\n'),
  searchText: b => b.tabs.map(t => t.label),
  aiText: b => `Tabs: ${b.tabs.map(t => t.label).join(' | ')}`,
  weight: (b, nested) => b.tabs.reduce((n, t) => n + t.label.length + nested(t.blocks), 0),
  schema: {
    properties: {
      tabs: {
        type: 'array', minItems: LIMITS.tabsMin, maxItems: LIMITS.tabsMax,
        items: {
          type: 'object', required: ['label', 'blocks'],
          properties: {
            label,
            anchor: { type: 'string', pattern: ANCHOR_RE.source, maxLength: LIMITS.anchor, description: 'Deep link: #anchor opens this tab. Unique among section and tab anchors.' },
            blocks: nestedBlocks(LIMITS.tabChildren),
          },
        },
      },
      defaultTab: { type: 'integer', minimum: 0, maximum: LIMITS.tabsMax - 1, default: 0, description: 'Index of the tab shown first' },
      level: { ...levelSchema, description: 'Heading level of each tab label when every panel is shown (no JavaScript, Markdown, email)' },
    },
    required: ['tabs'],
    extra: { examples: [TABS_EXAMPLE] },
  },
};

// ---------- stat ----------

function readDelta(v: BlockValidator, raw: unknown, path: string): StatDelta | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) { v.err(path, 'must be an object {value, decimals?, suffix?, label?}'); return null; }
  const value = finiteNumber(v, raw.value, `${path}.value`);
  const d = optDecimals(v, raw, path);
  const suffix = affixText(v, raw, 'suffix', path);
  const lbl = line(v, raw, 'label', path, L, false);
  if (value === null || d === null || suffix === null || lbl === null) return null;
  return { value, ...(d !== undefined ? { decimals: d } : {}), ...(suffix ? { suffix } : {}), ...(lbl ? { label: lbl } : {}) };
}

function readStat(v: BlockValidator, o: RawBlock, p: string): StatItem | undefined {
  const lbl = line(v, o, 'label', p, L, true);
  const value = finiteNumber(v, o.value, `${p}.value`);
  const d = optDecimals(v, o, p);
  const prefix = affixText(v, o, 'prefix', p);
  const suffix = affixText(v, o, 'suffix', p);
  const unit = line(v, o, 'unit', p, L, false);
  const delta = readDelta(v, o.delta, `${p}.delta`);
  const trend = optEnum(v, STAT_TRENDS, o, 'trend', p);
  const state = optEnum(v, STAT_STATES, o, 'state', p);
  const note = optInline(v, o, 'note', p, S);
  let sparkline: number[] | undefined;
  if (o.sparkline !== undefined && o.sparkline !== null) {
    const list = sizedArray(v, o.sparkline, `${p}.sparkline`, LIMITS.sparklineMin, LIMITS.sparklineMax, 'numbers');
    if (!list) return undefined;
    const values = list.map((n, i) => finiteNumber(v, n, `${p}.sparkline[${i}]`));
    if (values.some(n => n === null)) return undefined;
    sparkline = values.filter((n): n is number => n !== null);
  }
  if (!lbl || value === null || d === null || prefix === null || suffix === null || unit === null || delta === null
    || trend === null || state === null || note === null) return undefined;
  return {
    label: lbl, value, ...(d !== undefined ? { decimals: d } : {}), ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}),
    ...(unit ? { unit } : {}), ...(delta ? { delta } : {}), ...(trend ? { trend } : {}), ...(state ? { state } : {}),
    ...(sparkline ? { sparkline } : {}), ...(note ? { note } : {}),
  };
}

/** One stat in canonical text: `Revenue: $1250000 (+12.5% vs Q2, up)`. */
function statLine(item: StatItem): string {
  const delta = statDelta(item, canonicalNumber);
  const trend = statTrend(item);
  const extra = [delta && `${delta}${item.delta?.label ? ` ${item.delta.label}` : ''}`, trend].filter(Boolean).join(', ');
  return `${item.label}: ${statValue(item, canonicalNumber)}${extra ? ` (${extra})` : ''}`;
}

const sparkRange = (s: number[]) => `${canonicalNumber(Math.min(...s), 2).replace(/\.?0+$/, '')}–${canonicalNumber(Math.max(...s), 2).replace(/\.?0+$/, '')}`;

export const stat: BlockDefinition<StatBlock> = {
  type: 'stat',
  validate(v, raw, { id, path }) {
    const title = line(v, raw, 'title', path, S, false);
    const list = sizedArray(v, raw.items, `${path}.items`, 1, LIMITS.statItems, 'items');
    if (!list || title === null) return undefined;
    const items = eachItem(list, (o, p) => readStat(v, o, p), v, `${path}.items`, '{label, value, …}');
    if (!items) return undefined;
    return { id, type: 'stat', ...(title ? { title } : {}), items };
  },
  markdown(b) {
    const lines = b.items.map(item => {
      const spark = item.sparkline ? ` · trend ${item.sparkline.map(n => canonicalNumber(n, item.decimals)).join(' → ')}` : '';
      return `- **${statLine(item)}**${spark}${item.note ? ` — ${item.note}` : ''}`;
    });
    return [b.title ? `**${b.title}**` : '', lines.join('\n')].filter(Boolean).join('\n\n');
  },
  // Raw and formatted forms, so "1250000" and "$1250000" both match.
  searchText: b => [b.title ?? '', ...b.items.flatMap(i => [i.label, statValue(i, canonicalNumber), String(i.value), i.delta?.label ?? '', plain(i.note)])],
  aiText: b => [b.title ?? '', ...b.items.map(i => `${statLine(i)}${i.sparkline ? `, range ${sparkRange(i.sparkline)}` : ''}${i.note ? ` — ${plain(i.note)}` : ''}`)].filter(Boolean).join('; '),
  weight: b => (b.title?.length ?? 0) + b.items.reduce((n, i) => n + statLine(i).length + plainLength(i.note), 0),
  schema: {
    properties: {
      title: { ...label, maxLength: S },
      items: {
        type: 'array', minItems: 1, maxItems: LIMITS.statItems,
        items: {
          type: 'object', required: ['label', 'value'],
          properties: {
            label,
            value: number,
            decimals,
            prefix: { ...affix, description: 'Shown before the value, e.g. $' },
            suffix: { ...affix, description: 'Shown right after the value, e.g. % or k' },
            unit: { ...label, description: 'Unit word after the value, separated by a space' },
            delta: {
              type: 'object', required: ['value'],
              properties: { value: number, decimals, suffix: affix, label: { ...label, description: 'Comparison basis, e.g. "vs last month"' } },
              description: 'Change shown with an explicit sign',
            },
            trend: { type: 'string', enum: [...STAT_TRENDS], description: 'Arrow; defaults to the sign of delta.value' },
            state: { type: 'string', enum: [...STAT_STATES], description: 'Colour meaning; defaults to positive for up, negative for down' },
            sparkline: { type: 'array', minItems: LIMITS.sparklineMin, maxItems: LIMITS.sparklineMax, items: number, description: 'Recent values, oldest first' },
            note: { ...inline, maxLength: S, description: 'Annotation under the value (inline text)' },
          },
        },
      },
    },
    required: ['items'],
    extra: { examples: [STAT_EXAMPLE] },
  },
};

// ---------- steps ----------

const STATUS_MARK: Record<StepStatus, string> = { done: '✓ done', current: '▶ current', upcoming: '○ upcoming' };

export const steps: BlockDefinition<StepsBlock> = {
  type: 'steps',
  validate(v, raw, { id, path, ctx }) {
    const variant = raw.variant === undefined ? 'steps' : raw.variant;
    if (!isOneOf(STEP_VARIANTS, variant)) { v.err(`${path}.variant`, `must be one of ${STEP_VARIANTS.join(', ')}`); return undefined; }
    const orientation = optEnum(v, STEP_ORIENTATIONS, raw, 'orientation', path);
    const connector = optEnum(v, STEP_CONNECTORS, raw, 'connector', path);
    const list = sizedArray(v, raw.items, `${path}.items`, 1, LIMITS.stepItems, 'items');
    if (!list || orientation === null || connector === null) return undefined;
    const items = eachItem(list, (o, p) => {
      const title = v.str(o, 'title', p, S, { nonEmpty: true });
      const date = line(v, o, 'date', p, L, false);
      const icon = v.iconName(o, 'icon', p, true);
      const status = optEnum(v, STEP_STATUSES, o, 'status', p);
      const blocks = itemBlocks(v, o, p, LIMITS.stepChildren, ctx);
      if (title === undefined || date === null || icon === null || status === null || !blocks) return undefined;
      const item: StepItem = { title, ...(date ? { date } : {}), ...(icon ? { icon } : {}), ...(status ? { status } : {}), blocks };
      return item;
    }, v, `${path}.items`, '{title, date?, icon?, status?, blocks}');
    if (!items) return undefined;
    return {
      id, type: 'steps', variant, ...(orientation === 'horizontal' ? { orientation } : {}), ...(connector === 'none' ? { connector } : {}), items,
    };
  },
  markdown: (b, ctx) => b.items.map((item, i) => {
    const meta = [item.date, item.status ? STATUS_MARK[item.status] : ''].filter(Boolean).join(' · ');
    return [`**${i + 1}. ${item.title}**${meta ? ` · ${meta}` : ''}`, ctx.blocks(item.blocks)].filter(Boolean).join('\n\n');
  }).join('\n\n'),
  searchText: b => b.items.flatMap(i => [plain(i.title), i.date ?? '']),
  aiText: b => `${b.variant === 'timeline' ? 'Timeline' : 'Steps'}: ${b.items.map((i, n) => `${n + 1}. ${plain(i.title)}${i.date ? ` (${i.date})` : ''}${i.status ? ` [${i.status}]` : ''}`).join('; ')}`,
  weight: (b, nested) => b.items.reduce((n, i) => n + plainLength(i.title) + (i.date?.length ?? 0) + nested(i.blocks), 0),
  schema: {
    properties: {
      variant: { type: 'string', enum: [...STEP_VARIANTS], default: 'steps', description: 'steps: numbered process; timeline: dated sequence' },
      orientation: { type: 'string', enum: [...STEP_ORIENTATIONS], default: 'vertical', description: 'horizontal falls back to vertical on narrow screens' },
      connector: { type: 'string', enum: [...STEP_CONNECTORS], default: 'line' },
      items: {
        type: 'array', minItems: 1, maxItems: LIMITS.stepItems,
        items: {
          type: 'object', required: ['title'],
          properties: {
            title: { ...inline, maxLength: S },
            date: { ...label, description: 'Free-form date or period, e.g. "Q3 2026"' },
            icon: { ...iconName, description: 'Optional allowlisted icon used as the marker' },
            status: { type: 'string', enum: [...STEP_STATUSES] },
            blocks: nestedBlocks(LIMITS.stepChildren),
          },
        },
      },
    },
    required: ['items'],
    extra: { examples: [STEPS_EXAMPLE] },
  },
};

// ---------- comparison ----------

function points(v: BlockValidator, o: RawBlock, key: 'pros' | 'cons', p: string): string[] | undefined | null {
  if (o[key] === undefined || o[key] === null) return undefined;
  const list = v.strArray(o, key, p, LIMITS.comparisonPoints, S);
  if (!list) return null;
  const kept = list.filter(s => s.trim());
  return kept.length ? kept : undefined;
}

const yesNo = (value: string | boolean) => (value === true ? 'Yes' : value === false ? 'No' : value);

export const comparison: BlockDefinition<ComparisonBlock> = {
  type: 'comparison',
  validate(v, raw, { id, path, ctx }) {
    const title = line(v, raw, 'title', path, S, false);
    const list = sizedArray(v, raw.options, `${path}.options`, LIMITS.comparisonOptionsMin, LIMITS.comparisonOptionsMax, 'options');
    if (!list || title === null) return undefined;
    const options = eachItem(list, (o, p) => {
      const name = line(v, o, 'name', p, L, true);
      const badge = line(v, o, 'badge', p, L, false);
      if (o.highlight !== undefined && o.highlight !== null && typeof o.highlight !== 'boolean') { v.err(`${p}.highlight`, 'must be a boolean'); return undefined; }
      const description = optInline(v, o, 'description', p, S);
      const pros = points(v, o, 'pros', p);
      const cons = points(v, o, 'cons', p);
      const blocks = itemBlocks(v, o, p, LIMITS.optionChildren, ctx);
      if (!name || badge === null || description === null || pros === null || cons === null || !blocks) return undefined;
      const option: ComparisonOption = {
        name, ...(badge ? { badge } : {}), ...(o.highlight === true ? { highlight: true } : {}), ...(description ? { description } : {}),
        ...(pros ? { pros } : {}), ...(cons ? { cons } : {}), blocks,
      };
      return option;
    }, v, `${path}.options`, '{name, badge?, highlight?, description?, pros?, cons?, blocks}');
    if (!options) return undefined;
    if (options.filter(o => o.highlight).length > 1) { v.err(`${path}.options`, 'at most one option may be highlighted'); return undefined; }
    let features: ComparisonFeature[] | undefined;
    if (raw.features !== undefined && raw.features !== null) {
      const rows = sizedArray(v, raw.features, `${path}.features`, 0, LIMITS.comparisonFeatures, 'features');
      if (!rows) return undefined;
      const read = eachItem(rows, (f, p) => {
        const lbl = line(v, f, 'label', p, L, true);
        const values = f.values;
        if (!Array.isArray(values) || values.length !== options.length) { v.err(`${p}.values`, `must have one value per option (${options.length})`); return undefined; }
        const bad = values.findIndex(x => typeof x !== 'boolean' && (typeof x !== 'string' || x.length > L || /[\r\n]/.test(x)));
        if (bad >= 0) { v.err(`${p}.values[${bad}]`, `must be a boolean or one line of at most ${L} characters`); return undefined; }
        if (!lbl) return undefined;
        const feature: ComparisonFeature = { label: lbl, values: values.map(x => (typeof x === 'string' ? x.trim() : x === true)) };
        return feature;
      }, v, `${path}.features`, '{label, values}');
      if (!read) return undefined;
      if (read.length) features = read;
    }
    return { id, type: 'comparison', ...(title ? { title } : {}), options, ...(features ? { features } : {}) };
  },
  markdown(b, ctx) {
    const options = b.options.map(o => [
      `### ${o.name}${o.badge ? ` · ${o.badge}` : ''}${o.highlight ? ' (recommended)' : ''}`,
      o.description ?? '',
      [...(o.pros ?? []).map(s => `- ✓ ${s}`), ...(o.cons ?? []).map(s => `- ✗ ${s}`)].join('\n'),
      ctx.blocks(o.blocks),
    ].filter(Boolean).join('\n\n'));
    const matrix = b.features ? gfmTable(['', ...b.options.map(o => o.name)], b.features.map(f => [f.label, ...f.values.map(yesNo)])) : '';
    return [b.title ? `**${b.title}**` : '', ...options, matrix].filter(Boolean).join('\n\n');
  },
  searchText: b => [
    b.title ?? '',
    ...b.options.flatMap(o => [o.name, o.badge ?? '', plain(o.description), ...(o.pros ?? []).map(plain), ...(o.cons ?? []).map(plain)]),
    ...(b.features ?? []).flatMap(f => [f.label, ...f.values.filter((x): x is string => typeof x === 'string')]),
  ],
  aiText: b => [
    b.title ? `Comparison: ${b.title}` : 'Comparison',
    ...b.options.map(o => `${o.name}${o.highlight ? ' (recommended)' : ''}${o.badge ? ` [${o.badge}]` : ''}${o.description ? `: ${plain(o.description)}` : ''}`
      + `${o.pros ? `; pros: ${o.pros.map(plain).join(', ')}` : ''}${o.cons ? `; cons: ${o.cons.map(plain).join(', ')}` : ''}`),
    ...(b.features ?? []).map(f => `${f.label}: ${f.values.map((x, i) => `${b.options[i]?.name ?? ''} ${yesNo(x)}`).join(', ')}`),
  ].join('. '),
  weight: (b, nested) => (b.title?.length ?? 0)
    + b.options.reduce((n, o) => n + o.name.length + plainLength(o.description) + [...(o.pros ?? []), ...(o.cons ?? [])].reduce((m, s) => m + plainLength(s), 0) + nested(o.blocks), 0)
    + (b.features ?? []).reduce((n, f) => n + f.label.length + f.values.reduce((m, x) => m + (typeof x === 'string' ? x.length : 3), 0), 0),
  schema: {
    properties: {
      title: { ...label, maxLength: S },
      options: {
        type: 'array', minItems: LIMITS.comparisonOptionsMin, maxItems: LIMITS.comparisonOptionsMax,
        items: {
          type: 'object', required: ['name'],
          properties: {
            name: label,
            badge: { ...label, description: 'Short tag, e.g. "Popular"' },
            highlight: { type: 'boolean', default: false, description: 'Recommended option; at most one' },
            description: { ...inline, maxLength: S },
            pros: { type: 'array', maxItems: LIMITS.comparisonPoints, items: { ...inline, maxLength: S } },
            cons: { type: 'array', maxItems: LIMITS.comparisonPoints, items: { ...inline, maxLength: S } },
            blocks: nestedBlocks(LIMITS.optionChildren),
          },
        },
      },
      features: {
        type: 'array', maxItems: LIMITS.comparisonFeatures,
        items: {
          type: 'object', required: ['label', 'values'],
          properties: {
            label,
            values: { type: 'array', items: { oneOf: [{ type: 'boolean' }, { type: 'string', maxLength: L }] }, description: 'One value per option, in option order; true/false show as yes/no marks' },
          },
        },
        description: 'Feature matrix rows',
      },
    },
    required: ['options'],
    extra: { examples: [COMPARISON_EXAMPLE] },
  },
};

// ---------- progress ----------

export const progress: BlockDefinition<ProgressBlock> = {
  type: 'progress',
  validate(v, raw, { id, path }) {
    const variant = raw.variant === undefined ? 'bar' : raw.variant;
    if (!isOneOf(PROGRESS_VARIANTS, variant)) { v.err(`${path}.variant`, `must be one of ${PROGRESS_VARIANTS.join(', ')}`); return undefined; }
    const title = line(v, raw, 'title', path, S, false);
    const d = optDecimals(v, raw, path);
    const suffix = affixText(v, raw, 'suffix', path);
    if (title === null || d === null || suffix === null) return undefined;
    let min: number | undefined;
    let max: number | undefined;
    if (variant === 'rating') {
      if (raw.min !== undefined && raw.min !== null && raw.min !== 0) { v.err(`${path}.min`, 'a rating always starts at 0'); return undefined; }
      if (raw.max !== undefined && raw.max !== null) {
        if (!isInt(raw.max, 1, LIMITS.ratingMax)) { v.err(`${path}.max`, `must be the number of stars, 1–${LIMITS.ratingMax}`); return undefined; }
        max = raw.max;
      }
    } else {
      const lo = optNumber(v, raw, 'min', path);
      const hi = optNumber(v, raw, 'max', path);
      if (lo === null || hi === null) return undefined;
      if ((hi ?? 100) <= (lo ?? 0)) { v.err(`${path}.max`, 'must be greater than min'); return undefined; }
      min = lo;
      max = hi;
    }
    let segments: number | undefined;
    if (raw.segments !== undefined && raw.segments !== null) {
      if (variant !== 'segments') { v.err(`${path}.segments`, 'only applies to the segments variant'); return undefined; }
      if (!isInt(raw.segments, LIMITS.progressSegmentsMin, LIMITS.progressSegmentsMax)) { v.err(`${path}.segments`, `must be an integer ${LIMITS.progressSegmentsMin}–${LIMITS.progressSegmentsMax}`); return undefined; }
      segments = raw.segments;
    }
    const scale = { min: min ?? 0, max: max ?? (variant === 'rating' ? 5 : 100) };
    let thresholds: ProgressThreshold[] | undefined;
    if (raw.thresholds !== undefined && raw.thresholds !== null) {
      const list = sizedArray(v, raw.thresholds, `${path}.thresholds`, 0, LIMITS.progressThresholds, 'thresholds');
      if (!list) return undefined;
      const read = eachItem(list, (t, p) => {
        const at = finiteNumber(v, t.at, `${p}.at`);
        const state = optEnum(v, PROGRESS_STATES, t, 'state', p);
        if (state === undefined) v.err(`${p}.state`, 'is required');
        if (at === null || !state) return undefined;
        const threshold: ProgressThreshold = { at, state };
        return threshold;
      }, v, `${path}.thresholds`, '{at, state}');
      if (!read) return undefined;
      if (read.some((t, i) => i > 0 && t.at <= read[i - 1].at)) { v.err(`${path}.thresholds`, 'must be in strictly ascending order of at'); return undefined; }
      if (read.length) thresholds = read;
    }
    const list = sizedArray(v, raw.items, `${path}.items`, 1, LIMITS.progressItems, 'items');
    if (!list) return undefined;
    const items = eachItem(list, (o, p) => {
      const lbl = line(v, o, 'label', p, L, true);
      const value = finiteNumber(v, o.value, `${p}.value`);
      const note = optInline(v, o, 'note', p, S);
      if (!lbl || value === null || note === null) return undefined;
      if (value < scale.min || value > scale.max) { v.err(`${p}.value`, `must be between ${scale.min} and ${scale.max}`); return undefined; }
      const item: ProgressItem = { label: lbl, value, ...(note ? { note } : {}) };
      return item;
    }, v, `${path}.items`, '{label, value, note?}');
    if (!items) return undefined;
    return {
      id, type: 'progress', variant, ...(title ? { title } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
      ...(segments !== undefined ? { segments } : {}), ...(d !== undefined ? { decimals: d } : {}), ...(suffix ? { suffix } : {}),
      ...(thresholds ? { thresholds } : {}), items,
    };
  },
  markdown(b) {
    const stars = b.variant === 'rating' ? ' ★' : '';
    const lines = b.items.map(i => `- **${i.label}:** ${progressText(b, i, canonicalNumber)}${stars}${i.note ? ` — ${i.note}` : ''}`);
    return [b.title ? `**${b.title}**` : '', lines.join('\n')].filter(Boolean).join('\n\n');
  },
  searchText: b => [b.title ?? '', ...b.items.flatMap(i => [i.label, progressText(b, i, canonicalNumber), plain(i.note)])],
  aiText(b) {
    const { min, max } = progressScale(b);
    const scale = b.variant === 'rating' ? `rating out of ${max}` : `${b.variant} on ${canonicalNumber(min, b.decimals)}–${canonicalNumber(max, b.decimals)}${b.suffix ?? ''}`;
    return `${b.title ? `${b.title} ` : ''}(${scale}): ${b.items.map(i => `${i.label} ${progressText(b, i, canonicalNumber)}${i.note ? ` — ${plain(i.note)}` : ''}`).join('; ')}`;
  },
  weight: b => (b.title?.length ?? 0) + b.items.reduce((n, i) => n + i.label.length + 8 + plainLength(i.note), 0),
  schema: {
    properties: {
      variant: { type: 'string', enum: [...PROGRESS_VARIANTS], default: 'bar', description: 'bar, segmented bar, semicircle gauge or star rating' },
      title: { ...label, maxLength: S },
      min: { ...number, default: 0, description: 'Scale start; ratings always start at 0' },
      max: { ...number, default: 100, description: `Scale end; for ratings the number of stars (integer 1–${LIMITS.ratingMax}, default 5)` },
      segments: { type: 'integer', minimum: LIMITS.progressSegmentsMin, maximum: LIMITS.progressSegmentsMax, default: 5, description: 'Segment count (segments variant only)' },
      decimals,
      suffix: { ...affix, description: 'Shown after values, e.g. "%" or " pts"' },
      thresholds: {
        type: 'array', maxItems: LIMITS.progressThresholds,
        items: { type: 'object', required: ['at', 'state'], properties: { at: number, state: { type: 'string', enum: [...PROGRESS_STATES] } } },
        description: 'Strictly ascending; a value at or above `at` takes that state (colour plus a text label)',
      },
      items: {
        type: 'array', minItems: 1, maxItems: LIMITS.progressItems,
        items: { type: 'object', required: ['label', 'value'], properties: { label, value: { ...number, description: 'Between min and max' }, note: { ...inline, maxLength: S } } },
      },
    },
    required: ['items'],
    extra: { examples: [PROGRESS_EXAMPLE] },
  },
};
