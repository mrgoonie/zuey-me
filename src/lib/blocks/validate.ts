import {
  BLOCK_TYPES, BREAKPOINTS, CALLOUT_TONES, CHART_KINDS, EMBED_PROVIDERS, LAYOUT_GAPS, LAYOUT_VARIANTS, LIMITS,
} from './schema';
import type {
  ArticleDocument, Block, BlockType, ChartSeries, ChecklistItem, EmbedProvider, GalleryImage, KnowledgeMediaBlock,
  LayoutChild, ResponsiveCols, ResponsiveSpan, SurveyOption,
} from './schema';
import { detectProvider } from './embed';

export interface ValidationError { path: string; message: string }
export type ValidationResult = { ok: true; doc: ArticleDocument } | { ok: false; errors: ValidationError[] };

type Obj = Record<string, unknown>;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ERRORS = 50;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && list.some(item => item === v);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function randomId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

class Validator {
  errors: ValidationError[] = [];
  private ids = new Set<string>();
  private count = 0;
  private inToggle = false;

  err(path: string, message: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push({ path, message });
  }

  str(o: Obj, key: string, path: string, max: number, opts: { optional?: boolean; nonEmpty?: boolean } = {}): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) {
      if (!opts.optional) this.err(`${path}.${key}`, 'is required');
      return undefined;
    }
    if (typeof v !== 'string') { this.err(`${path}.${key}`, 'must be a string'); return undefined; }
    if (v.length > max) { this.err(`${path}.${key}`, `must be at most ${max} characters`); return undefined; }
    if (opts.nonEmpty && !v.trim()) { this.err(`${path}.${key}`, 'must not be empty'); return undefined; }
    return v;
  }

  url(o: Obj, key: string, path: string): string | undefined {
    const v = this.str(o, key, path, LIMITS.url, { nonEmpty: true });
    if (v === undefined) return undefined;
    try {
      if (new URL(v).protocol === 'https:') return v;
    } catch { /* reported below */ }
    this.err(`${path}.${key}`, 'must be an absolute https:// URL');
    return undefined;
  }

  strArray(o: Obj, key: string, path: string, maxItems: number, maxLen: number, minItems = 0): string[] | undefined {
    const v = o[key];
    if (!Array.isArray(v)) { this.err(`${path}.${key}`, 'must be an array of strings'); return undefined; }
    if (v.length < minItems || v.length > maxItems) {
      this.err(`${path}.${key}`, `must contain ${minItems}–${maxItems} items`);
      return undefined;
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== 'string') this.err(`${path}.${key}[${i}]`, 'must be a string');
      else if (item.length > maxLen) this.err(`${path}.${key}[${i}]`, `must be at most ${maxLen} characters`);
      else out.push(item);
    });
    return out.length === v.length ? out : undefined;
  }

  id(o: Obj, path: string): string | undefined {
    const v = o.id;
    let id: string;
    if (v === undefined || v === null || v === '') {
      do id = randomId('b_'); while (this.ids.has(id));
    } else if (typeof v !== 'string' || !ID_RE.test(v)) {
      this.err(`${path}.id`, 'must match [A-Za-z0-9_-]{1,64}');
      return undefined;
    } else {
      id = v;
    }
    if (this.ids.has(id)) { this.err(`${path}.id`, `duplicate block id "${id}"`); return undefined; }
    this.ids.add(id);
    return id;
  }

  blocks(v: unknown, path: string, layoutDepth: number): Block[] | undefined {
    if (!Array.isArray(v)) { this.err(path, 'must be an array of blocks'); return undefined; }
    const out: Block[] = [];
    let failed = false;
    v.forEach((item, i) => {
      const block = this.block(item, `${path}[${i}]`, layoutDepth);
      if (block) out.push(block); else failed = true;
    });
    return failed ? undefined : out;
  }

  block(v: unknown, path: string, layoutDepth: number): Block | undefined {
    this.count += 1;
    if (this.count === LIMITS.totalBlocks + 1) this.err(path, `document exceeds ${LIMITS.totalBlocks} blocks`);
    if (this.count > LIMITS.totalBlocks) return undefined;
    if (!isObj(v)) { this.err(path, 'must be an object'); return undefined; }
    const type = v.type;
    if (!isOneOf<BlockType>(BLOCK_TYPES, type)) {
      this.err(`${path}.type`, `unknown block type ${JSON.stringify(type)}; expected one of ${BLOCK_TYPES.join(', ')}`);
      return undefined;
    }
    if (this.inToggle && (type === 'toggle' || type === 'layout')) {
      this.err(`${path}.type`, `a toggle may not contain a ${type}`);
      return undefined;
    }
    const id = this.id(v, path);
    const before = this.errors.length;
    const block = this.typed(type, id ?? '', v, path, layoutDepth);
    return id !== undefined && block && this.errors.length === before ? block : undefined;
  }

  private typed(type: BlockType, id: string, v: Obj, path: string, layoutDepth: number): Block | undefined {
    const T = LIMITS.text;
    const S = LIMITS.shortText;
    switch (type) {
      case 'paragraph': {
        const text = this.str(v, 'text', path, T);
        return text === undefined ? undefined : { id, type, text };
      }
      case 'heading': {
        const text = this.str(v, 'text', path, S, { nonEmpty: true });
        if (!isInt(v.level, 1, 3)) { this.err(`${path}.level`, 'must be 1, 2 or 3'); return undefined; }
        const level = v.level === 1 ? 1 : v.level === 2 ? 2 : 3;
        return text === undefined ? undefined : { id, type, level, text };
      }
      case 'list': {
        const style = v.style === undefined ? 'bullet' : v.style;
        if (style !== 'bullet' && style !== 'number') { this.err(`${path}.style`, "must be 'bullet' or 'number'"); return undefined; }
        const items = this.strArray(v, 'items', path, LIMITS.listItems, T, 1);
        return items ? { id, type, style, items } : undefined;
      }
      case 'checklist': {
        if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > LIMITS.listItems) {
          this.err(`${path}.items`, `must contain 1–${LIMITS.listItems} items`);
          return undefined;
        }
        const items: ChecklistItem[] = [];
        v.items.forEach((item: unknown, i: number) => {
          const p = `${path}.items[${i}]`;
          if (!isObj(item)) { this.err(p, 'must be an object {text, checked}'); return; }
          const text = this.str(item, 'text', p, T);
          if (text !== undefined) items.push({ text, checked: item.checked === true });
        });
        return items.length === v.items.length ? { id, type, items } : undefined;
      }
      case 'quote': {
        const text = this.str(v, 'text', path, T);
        const cite = this.str(v, 'cite', path, S, { optional: true });
        return text === undefined ? undefined : { id, type, text, ...(cite ? { cite } : {}) };
      }
      case 'callout': {
        const tone = v.tone === undefined ? 'info' : v.tone;
        if (!isOneOf(CALLOUT_TONES, tone)) { this.err(`${path}.tone`, `must be one of ${CALLOUT_TONES.join(', ')}`); return undefined; }
        const text = this.str(v, 'text', path, T);
        return text === undefined ? undefined : { id, type, tone, text };
      }
      case 'code': {
        const language = this.str(v, 'language', path, 40, { optional: true }) ?? '';
        if (language && !/^[\w+#.-]+$/.test(language)) { this.err(`${path}.language`, 'contains invalid characters'); return undefined; }
        const code = this.str(v, 'code', path, LIMITS.code);
        return code === undefined ? undefined : { id, type, language, code };
      }
      case 'divider':
        return { id, type };
      case 'image': {
        const url = this.url(v, 'url', path);
        const alt = this.str(v, 'alt', path, S, { optional: true }) ?? '';
        const caption = this.str(v, 'caption', path, S, { optional: true });
        return url ? { id, type, url, alt, ...(caption ? { caption } : {}) } : undefined;
      }
      case 'embed': {
        const url = this.url(v, 'url', path);
        if (!url) return undefined;
        let provider: EmbedProvider = detectProvider(url);
        if (v.provider !== undefined) {
          if (!isOneOf(EMBED_PROVIDERS, v.provider)) { this.err(`${path}.provider`, `must be one of ${EMBED_PROVIDERS.join(', ')}`); return undefined; }
          provider = v.provider;
        }
        const caption = this.str(v, 'caption', path, S, { optional: true });
        return { id, type, url, provider, ...(caption ? { caption } : {}) };
      }
      case 'table': {
        const headers = this.strArray(v, 'headers', path, LIMITS.tableColumns, S, 1);
        if (!headers) return undefined;
        if (!Array.isArray(v.rows) || v.rows.length > LIMITS.tableRows) {
          this.err(`${path}.rows`, `must be an array of at most ${LIMITS.tableRows} rows`);
          return undefined;
        }
        const rows: string[][] = [];
        v.rows.forEach((row: unknown, i: number) => {
          const p = `${path}.rows[${i}]`;
          if (!Array.isArray(row) || row.length !== headers.length || !row.every(c => typeof c === 'string' && c.length <= T)) {
            this.err(p, `must be an array of ${headers.length} strings (one per header)`);
            return;
          }
          rows.push(row.map(String));
        });
        return rows.length === v.rows.length ? { id, type, headers, rows } : undefined;
      }
      case 'chart': {
        if (!isOneOf(CHART_KINDS, v.kind)) { this.err(`${path}.kind`, `must be one of ${CHART_KINDS.join(', ')}`); return undefined; }
        const kind = v.kind;
        const title = this.str(v, 'title', path, S, { optional: true });
        const labels = this.strArray(v, 'labels', path, LIMITS.chartLabels, 120, 1);
        if (!labels) return undefined;
        if (!Array.isArray(v.series) || v.series.length < 1 || v.series.length > LIMITS.chartSeries) {
          this.err(`${path}.series`, `must contain 1–${LIMITS.chartSeries} series`);
          return undefined;
        }
        const series: ChartSeries[] = [];
        v.series.forEach((s: unknown, i: number) => {
          const p = `${path}.series[${i}]`;
          if (!isObj(s)) { this.err(p, 'must be an object {name, data}'); return; }
          const name = this.str(s, 'name', p, 120);
          const data = s.data;
          if (!Array.isArray(data) || !data.every(n => typeof n === 'number' && Number.isFinite(n))) {
            this.err(`${p}.data`, 'must be an array of finite numbers');
            return;
          }
          if (data.length !== labels.length) {
            this.err(`${p}.data`, `length ${data.length} must equal labels length ${labels.length}`);
            return;
          }
          if (name !== undefined) series.push({ name, data: data.map(Number) });
        });
        if (series.length !== v.series.length) return undefined;
        return { id, type, kind, labels, series, ...(title ? { title } : {}) };
      }
      case 'diagram': {
        if (v.syntax !== undefined && v.syntax !== 'mermaid') { this.err(`${path}.syntax`, "must be 'mermaid'"); return undefined; }
        const source = this.str(v, 'source', path, LIMITS.mermaid, { nonEmpty: true });
        const caption = this.str(v, 'caption', path, S, { optional: true });
        return source === undefined ? undefined : { id, type, syntax: 'mermaid', source, ...(caption ? { caption } : {}) };
      }
      case 'survey': {
        const question = this.str(v, 'question', path, S, { nonEmpty: true });
        if (!Array.isArray(v.options) || v.options.length < LIMITS.surveyOptionsMin || v.options.length > LIMITS.surveyOptionsMax) {
          this.err(`${path}.options`, `must contain ${LIMITS.surveyOptionsMin}–${LIMITS.surveyOptionsMax} options`);
          return undefined;
        }
        const options: SurveyOption[] = [];
        const optionIds = new Set<string>();
        v.options.forEach((opt: unknown, i: number) => {
          const p = `${path}.options[${i}]`;
          if (!isObj(opt)) { this.err(p, 'must be an object {id, label}'); return; }
          const label = this.str(opt, 'label', p, 200, { nonEmpty: true });
          let optId = typeof opt.id === 'string' && opt.id ? opt.id : '';
          if (!optId) { let n = i + 1; do optId = `o${n++}`; while (optionIds.has(optId)); }
          if (!ID_RE.test(optId)) { this.err(`${p}.id`, 'must match [A-Za-z0-9_-]{1,64}'); return; }
          if (optionIds.has(optId)) { this.err(`${p}.id`, `duplicate option id "${optId}"`); return; }
          optionIds.add(optId);
          if (label !== undefined) options.push({ id: optId, label });
        });
        if (v.allowMultiple !== undefined && typeof v.allowMultiple !== 'boolean') {
          this.err(`${path}.allowMultiple`, 'must be a boolean');
          return undefined;
        }
        if (question === undefined || options.length !== v.options.length) return undefined;
        return { id, type, question, options, allowMultiple: v.allowMultiple === true };
      }
      case 'layout':
        return this.layout(id, v, path, layoutDepth);
      case 'interactive':
        return this.interactive(id, v, path);
      case 'math': case 'gallery': case 'audio': case 'video': case 'file': case 'bookmark': case 'toggle':
        return this.media(type, id, v, path, layoutDepth);
    }
  }

  private optUrl(o: Obj, key: string, path: string): string | undefined | null {
    if (o[key] === undefined || o[key] === null || o[key] === '') return undefined;
    return this.url(o, key, path) ?? null;
  }

  /** Knowledge media blocks: math, gallery, audio, video, file, bookmark, toggle. */
  private media(type: KnowledgeMediaBlock['type'], id: string, v: Obj, path: string, layoutDepth: number): Block | undefined {
    const S = LIMITS.shortText;
    const caption = this.str(v, 'caption', path, S, { optional: true });
    const withCaption = caption ? { caption } : {};
    switch (type) {
      case 'math': {
        const tex = this.str(v, 'tex', path, LIMITS.math, { nonEmpty: true });
        return tex === undefined ? undefined : { id, type, tex, ...withCaption };
      }
      case 'gallery': {
        if (!Array.isArray(v.images) || v.images.length < 1 || v.images.length > LIMITS.galleryImages) {
          this.err(`${path}.images`, `must contain 1–${LIMITS.galleryImages} images`);
          return undefined;
        }
        const images: GalleryImage[] = [];
        v.images.forEach((img: unknown, i: number) => {
          const p = `${path}.images[${i}]`;
          if (!isObj(img)) { this.err(p, 'must be an object {url, alt, caption?}'); return; }
          const url = this.url(img, 'url', p);
          const alt = this.str(img, 'alt', p, S, { optional: true }) ?? '';
          const imgCaption = this.str(img, 'caption', p, S, { optional: true });
          if (url) images.push({ url, alt, ...(imgCaption ? { caption: imgCaption } : {}) });
        });
        return images.length === v.images.length ? { id, type, images, ...withCaption } : undefined;
      }
      case 'audio': {
        const url = this.url(v, 'url', path);
        const title = this.str(v, 'title', path, S, { optional: true });
        return url ? { id, type, url, ...(title ? { title } : {}), ...withCaption } : undefined;
      }
      case 'video': {
        const url = this.url(v, 'url', path);
        const poster = this.optUrl(v, 'poster', path);
        const title = this.str(v, 'title', path, S, { optional: true });
        if (!url || poster === null) return undefined;
        return { id, type, url, ...(poster ? { poster } : {}), ...(title ? { title } : {}), ...withCaption };
      }
      case 'file': {
        const url = this.url(v, 'url', path);
        const name = this.str(v, 'name', path, S, { nonEmpty: true });
        const size = v.sizeBytes;
        if (size !== undefined && !isInt(size, 0, Number.MAX_SAFE_INTEGER)) { this.err(`${path}.sizeBytes`, 'must be a non-negative integer'); return undefined; }
        if (!url || name === undefined) return undefined;
        return { id, type, url, name, ...(typeof size === 'number' ? { sizeBytes: size } : {}), ...withCaption };
      }
      case 'bookmark': {
        const url = this.url(v, 'url', path);
        const title = this.str(v, 'title', path, S, { optional: true });
        const description = this.str(v, 'description', path, 1_000, { optional: true });
        const siteName = this.str(v, 'siteName', path, 120, { optional: true });
        const image = this.optUrl(v, 'image', path);
        if (!url || image === null) return undefined;
        return {
          id, type, url, ...(title ? { title } : {}), ...(description ? { description } : {}),
          ...(image ? { image } : {}), ...(siteName ? { siteName } : {}),
        };
      }
      case 'toggle': {
        const summary = this.str(v, 'summary', path, S, { nonEmpty: true });
        if (v.open !== undefined && typeof v.open !== 'boolean') { this.err(`${path}.open`, 'must be a boolean'); return undefined; }
        if (!Array.isArray(v.blocks) || v.blocks.length > LIMITS.toggleChildren) {
          this.err(`${path}.blocks`, `must be an array of at most ${LIMITS.toggleChildren} blocks`);
          return undefined;
        }
        this.inToggle = true;
        const blocks = this.blocks(v.blocks, `${path}.blocks`, layoutDepth);
        this.inToggle = false;
        if (summary === undefined || !blocks) return undefined;
        return { id, type, summary, ...(v.open === true ? { open: true } : {}), blocks };
      }
    }
  }

  private interactive(id: string, v: Obj, path: string): Block | undefined {
    const title = this.str(v, 'title', path, LIMITS.shortText, { nonEmpty: true });
    const html = this.str(v, 'html', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const css = this.str(v, 'css', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const js = this.str(v, 'js', path, LIMITS.interactiveField, { optional: true }) ?? '';
    const caption = this.str(v, 'caption', path, LIMITS.shortText, { optional: true });
    if (html.length + css.length + js.length > LIMITS.interactiveTotal) {
      this.err(path, `html + css + js must be at most ${LIMITS.interactiveTotal} characters in total`);
      return undefined;
    }
    if (!html.trim() && !js.trim()) { this.err(`${path}.html`, 'html or js must not be empty'); return undefined; }
    if (v.height !== undefined && !isInt(v.height, LIMITS.interactiveHeightMin, LIMITS.interactiveHeightMax)) {
      this.err(`${path}.height`, `must be an integer ${LIMITS.interactiveHeightMin}–${LIMITS.interactiveHeightMax}`);
      return undefined;
    }
    const height = typeof v.height === 'number' ? v.height : undefined;
    if (title === undefined) return undefined;
    return { id, type: 'interactive', title, html, css, js, ...(height ? { height } : {}), ...(caption ? { caption } : {}) };
  }

  private layout(id: string, v: Obj, path: string, layoutDepth: number): Block | undefined {
    if (layoutDepth >= LIMITS.layoutDepth) {
      this.err(path, `layouts may be nested at most ${LIMITS.layoutDepth} levels deep`);
      return undefined;
    }
    const variant = v.variant === undefined ? 'columns' : v.variant;
    if (!isOneOf(LAYOUT_VARIANTS, variant)) { this.err(`${path}.variant`, `must be one of ${LAYOUT_VARIANTS.join(', ')}`); return undefined; }
    const gap = v.gap;
    if (gap !== undefined && !isOneOf(LAYOUT_GAPS, gap)) { this.err(`${path}.gap`, `must be one of ${LAYOUT_GAPS.join(', ')}`); return undefined; }
    if (!isObj(v.cols)) { this.err(`${path}.cols`, 'must be an object {base, md, lg}'); return undefined; }
    const rawCols = v.cols;
    const cols: ResponsiveCols = { base: 1, md: 1, lg: 1 };
    for (const bp of BREAKPOINTS) {
      const c = rawCols[bp];
      if (!isInt(c, 1, LIMITS.layoutColsMax)) { this.err(`${path}.cols.${bp}`, `must be an integer 1–${LIMITS.layoutColsMax}`); return undefined; }
      cols[bp] = c;
    }
    if (!Array.isArray(v.children) || v.children.length < 1 || v.children.length > LIMITS.layoutChildren) {
      this.err(`${path}.children`, `must contain 1–${LIMITS.layoutChildren} children`);
      return undefined;
    }
    const children: LayoutChild[] = [];
    v.children.forEach((child: unknown, i: number) => {
      const p = `${path}.children[${i}]`;
      if (!isObj(child)) { this.err(p, 'must be an object {span?, rowSpan?, blocks}'); return; }
      const out: LayoutChild = { blocks: [] };
      if (child.span !== undefined) {
        if (typeof child.span === 'number') {
          if (!isInt(child.span, 1, LIMITS.layoutColsMax)) { this.err(`${p}.span`, `must be an integer 1–${LIMITS.layoutColsMax}`); return; }
          if (child.span > cols.lg) { this.err(`${p}.span`, `span ${child.span} exceeds cols.lg ${cols.lg}`); return; }
          out.span = child.span;
        } else if (isObj(child.span)) {
          const span: ResponsiveSpan = {};
          for (const bp of BREAKPOINTS) {
            const s = child.span[bp];
            if (s === undefined) continue;
            if (!isInt(s, 1, LIMITS.layoutColsMax)) { this.err(`${p}.span.${bp}`, `must be an integer 1–${LIMITS.layoutColsMax}`); return; }
            if (s > cols[bp]) { this.err(`${p}.span.${bp}`, `span ${s} exceeds cols.${bp} ${cols[bp]}`); return; }
            span[bp] = s;
          }
          out.span = span;
        } else {
          this.err(`${p}.span`, 'must be a number or {base?, md?, lg?}');
          return;
        }
      }
      if (child.rowSpan !== undefined) {
        if (!isInt(child.rowSpan, 1, LIMITS.layoutRowSpanMax)) { this.err(`${p}.rowSpan`, `must be an integer 1–${LIMITS.layoutRowSpanMax}`); return; }
        out.rowSpan = child.rowSpan;
      }
      const blocks = this.blocks(child.blocks, `${p}.blocks`, layoutDepth + 1);
      if (!blocks) return;
      out.blocks = blocks;
      children.push(out);
    });
    if (children.length !== v.children.length) return undefined;
    return { id, type: 'layout', variant, cols, ...(gap ? { gap } : {}), children };
  }
}

/** Validates an untrusted document, auto-generating missing block/option ids. */
export function validateDocument(input: unknown): ValidationResult {
  const v = new Validator();
  if (!isObj(input)) return { ok: false, errors: [{ path: '$', message: 'document must be an object {version: 1, blocks: []}' }] };
  if (input.version !== undefined && input.version !== 1) v.err('$.version', 'must be 1');
  const blocks = v.blocks(input.blocks, '$.blocks', 0);
  if (v.errors.length || !blocks) return { ok: false, errors: v.errors.length ? v.errors : [{ path: '$.blocks', message: 'invalid' }] };
  return { ok: true, doc: { version: 1, blocks } };
}
