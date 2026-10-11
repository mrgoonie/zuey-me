/** Container blocks: layout, toggle, section and card. Nested lists follow the rules in ../nesting.ts. */
import type { BlockDefinition } from '../block-definition';
import { childContext } from '../nesting';
import {
  ANCHOR_RE, BREAKPOINTS, CARD_ACCENTS, CARD_ALIGNS, CARD_VARIANTS, LAYOUT_GAPS, LAYOUT_VARIANTS, LIMITS,
  SECTION_PADDINGS, SECTION_SURFACES, SECTION_WIDTHS,
} from '../schema';
import type { CardBlock, CardImage, LayoutBlock, LayoutChild, ResponsiveCols, ResponsiveSpan, SectionBlock, ToggleBlock } from '../schema';
import { iconName, colsInt, httpsUrl, imageSize, imageSizeTogether, inline, ref, short } from './schema-fragments';
import { isInt, isObj, isOneOf, plain, plainLength } from './shared';

const S = LIMITS.shortText;

/** Example section and card (also returned by the block_schema MCP tool). */
export const SECTION_EXAMPLE = {
  type: 'section', width: 'wide', surface: 'soft', anchor: 'tong-quan',
  blocks: [
    { type: 'heading', level: 2, text: 'Tổng quan' },
    {
      type: 'layout', variant: 'grid', cols: { base: 1, md: 2, lg: 3 },
      children: [
        { blocks: [{ type: 'card', icon: 'rocket', title: 'Nhanh', blocks: [{ type: 'paragraph', text: 'Triển khai trong vài phút.' }] }] },
        { blocks: [{ type: 'card', icon: 'shield-check', title: 'An toàn', accent: 'emerald', blocks: [{ type: 'paragraph', text: 'Mặc định bảo mật.' }] }] },
        { blocks: [{ type: 'card', icon: 'sparkles', title: 'Đẹp', variant: 'soft', footer: '[Xem thêm](https://zuey.me)', blocks: [] }] },
      ],
    },
  ],
} as const;
export const CARD_EXAMPLE = {
  type: 'card', title: 'Gói Knowledges', icon: 'book-open', variant: 'elevated', accent: 'amber', align: 'start',
  image: { url: 'https://media.zuey.me/example.png', alt: 'Ảnh minh hoạ', width: 1200, height: 630 },
  blocks: [{ type: 'list', style: 'bullet', items: ['Đọc toàn bộ bài viết', 'Hỏi Zuey AI'] }],
  footer: '[Đăng ký](https://zuey.me/pricing)',
} as const;

export const layout: BlockDefinition<LayoutBlock> = {
  type: 'layout',
  validate(v, raw, { id, path, ctx }) {
    if (ctx.layoutDepth >= LIMITS.layoutDepth) {
      v.err(path, `layouts may be nested at most ${LIMITS.layoutDepth} levels deep`);
      return undefined;
    }
    const variant = raw.variant === undefined ? 'columns' : raw.variant;
    if (!isOneOf(LAYOUT_VARIANTS, variant)) { v.err(`${path}.variant`, `must be one of ${LAYOUT_VARIANTS.join(', ')}`); return undefined; }
    const gap = raw.gap;
    if (gap !== undefined && !isOneOf(LAYOUT_GAPS, gap)) { v.err(`${path}.gap`, `must be one of ${LAYOUT_GAPS.join(', ')}`); return undefined; }
    if (!isObj(raw.cols)) { v.err(`${path}.cols`, 'must be an object {base, md, lg}'); return undefined; }
    const rawCols = raw.cols;
    const cols: ResponsiveCols = { base: 1, md: 1, lg: 1 };
    for (const bp of BREAKPOINTS) {
      const c = rawCols[bp];
      if (!isInt(c, 1, LIMITS.layoutColsMax)) { v.err(`${path}.cols.${bp}`, `must be an integer 1–${LIMITS.layoutColsMax}`); return undefined; }
      cols[bp] = c;
    }
    if (!Array.isArray(raw.children) || raw.children.length < 1 || raw.children.length > LIMITS.layoutChildren) {
      v.err(`${path}.children`, `must contain 1–${LIMITS.layoutChildren} children`);
      return undefined;
    }
    const inner = childContext(ctx, 'layout');
    const children: LayoutChild[] = [];
    raw.children.forEach((child: unknown, i: number) => {
      const p = `${path}.children[${i}]`;
      if (!isObj(child)) { v.err(p, 'must be an object {span?, rowSpan?, blocks}'); return; }
      const out: LayoutChild = { blocks: [] };
      if (child.span !== undefined) {
        if (typeof child.span === 'number') {
          if (!isInt(child.span, 1, LIMITS.layoutColsMax)) { v.err(`${p}.span`, `must be an integer 1–${LIMITS.layoutColsMax}`); return; }
          if (child.span > cols.lg) { v.err(`${p}.span`, `span ${child.span} exceeds cols.lg ${cols.lg}`); return; }
          out.span = child.span;
        } else if (isObj(child.span)) {
          const span: ResponsiveSpan = {};
          for (const bp of BREAKPOINTS) {
            const s = child.span[bp];
            if (s === undefined) continue;
            if (!isInt(s, 1, LIMITS.layoutColsMax)) { v.err(`${p}.span.${bp}`, `must be an integer 1–${LIMITS.layoutColsMax}`); return; }
            if (s > cols[bp]) { v.err(`${p}.span.${bp}`, `span ${s} exceeds cols.${bp} ${cols[bp]}`); return; }
            span[bp] = s;
          }
          out.span = span;
        } else {
          v.err(`${p}.span`, 'must be a number or {base?, md?, lg?}');
          return;
        }
      }
      if (child.rowSpan !== undefined) {
        if (!isInt(child.rowSpan, 1, LIMITS.layoutRowSpanMax)) { v.err(`${p}.rowSpan`, `must be an integer 1–${LIMITS.layoutRowSpanMax}`); return; }
        out.rowSpan = child.rowSpan;
      }
      const blocks = v.blocks(child.blocks, `${p}.blocks`, inner);
      if (!blocks) return;
      out.blocks = blocks;
      children.push(out);
    });
    if (children.length !== raw.children.length) return undefined;
    return { id, type: 'layout', variant, cols, ...(gap ? { gap } : {}), children };
  },
  // Reading order: child by child.
  markdown: (b, ctx) => b.children.map(child => ctx.blocks(child.blocks)).filter(Boolean).join('\n\n'),
  searchText: () => [],
  aiText: () => '',
  weight: (b, nested) => b.children.reduce((n, c) => n + nested(c.blocks), 0),
  schema: {
    properties: {
      variant: { type: 'string', enum: [...LAYOUT_VARIANTS] },
      cols: { type: 'object', required: ['base', 'md', 'lg'], properties: { base: colsInt, md: colsInt, lg: colsInt }, description: 'Columns at <768px, ≥768px, ≥1024px' },
      gap: { type: 'string', enum: [...LAYOUT_GAPS] },
      children: { type: 'array', minItems: 1, maxItems: LIMITS.layoutChildren, items: ref('LayoutChild') },
    },
    required: ['cols', 'children'],
  },
};

export const toggle: BlockDefinition<ToggleBlock> = {
  type: 'toggle',
  validate(v, raw, { id, path, ctx }) {
    // Stored toggles were read with the media fields, so an invalid caption still rejects the block.
    v.str(raw, 'caption', path, S, { optional: true });
    const summary = v.str(raw, 'summary', path, S, { nonEmpty: true });
    if (raw.open !== undefined && typeof raw.open !== 'boolean') { v.err(`${path}.open`, 'must be a boolean'); return undefined; }
    if (!Array.isArray(raw.blocks) || raw.blocks.length > LIMITS.toggleChildren) {
      v.err(`${path}.blocks`, `must be an array of at most ${LIMITS.toggleChildren} blocks`);
      return undefined;
    }
    const blocks = v.blocks(raw.blocks, `${path}.blocks`, childContext(ctx, 'toggle'));
    if (summary === undefined || !blocks) return undefined;
    return { id, type: 'toggle', summary, ...(raw.open === true ? { open: true } : {}), blocks };
  },
  markdown(b, ctx) {
    const inner = ctx.blocks(b.blocks);
    return `**${b.summary}**${inner ? `\n\n${inner}` : ''}`;
  },
  searchText: b => [plain(b.summary)],
  aiText: b => plain(b.summary),
  weight: (b, nested) => plainLength(b.summary) + nested(b.blocks),
  schema: {
    properties: {
      summary: short,
      open: { type: 'boolean', default: false },
      blocks: { type: 'array', maxItems: LIMITS.toggleChildren, items: ref('Block'), description: 'May not contain toggle or layout blocks' },
    },
    required: ['summary', 'blocks'],
  },
};

/** Element ids the article page itself uses; a section anchor may not take them over. */
export const RESERVED_ANCHORS: readonly string[] = ['locked-title', 'related-videos', 'main', 'content', 'top'];

export const section: BlockDefinition<SectionBlock> = {
  type: 'section',
  validate(v, raw, { id, path, ctx }) {
    const width = raw.width === undefined ? 'prose' : raw.width;
    if (!isOneOf(SECTION_WIDTHS, width)) { v.err(`${path}.width`, `must be one of ${SECTION_WIDTHS.join(', ')}`); return undefined; }
    const surface = raw.surface === undefined ? 'none' : raw.surface;
    if (!isOneOf(SECTION_SURFACES, surface)) { v.err(`${path}.surface`, `must be one of ${SECTION_SURFACES.join(', ')}`); return undefined; }
    const padding = raw.padding;
    if (padding !== undefined && !isOneOf(SECTION_PADDINGS, padding)) { v.err(`${path}.padding`, `must be one of ${SECTION_PADDINGS.join(', ')}`); return undefined; }
    let anchor = v.str(raw, 'anchor', path, LIMITS.anchor, { optional: true }) || undefined;
    const anchorError = anchor === undefined ? null
      : !ANCHOR_RE.test(anchor) ? 'must be a lowercase slug (a-z, 0-9 and single hyphens)'
        : RESERVED_ANCHORS.includes(anchor) ? `"${anchor}" is used by the article page; pick another anchor` : null;
    if (anchorError) {
      // A stored section keeps its content and only loses the unusable anchor.
      if (!v.lenient) { v.err(`${path}.anchor`, anchorError); return undefined; }
      anchor = undefined;
      v.degraded();
    }
    if (!Array.isArray(raw.blocks) || raw.blocks.length > LIMITS.sectionChildren) {
      v.err(`${path}.blocks`, `must be an array of at most ${LIMITS.sectionChildren} blocks`);
      return undefined;
    }
    const blocks = v.blocks(raw.blocks, `${path}.blocks`, childContext(ctx, 'section'));
    if (!blocks) return undefined;
    if (anchor !== undefined && !v.claimAnchor(anchor, `${path}.anchor`)) {
      if (!v.lenient) return undefined;
      anchor = undefined;
      v.degraded();
    }
    return { id, type: 'section', width, surface, ...(padding ? { padding } : {}), ...(anchor ? { anchor } : {}), blocks };
  },
  markdown: (b, ctx) => ctx.blocks(b.blocks),
  searchText: () => [],
  aiText: () => '',
  weight: (b, nested) => nested(b.blocks),
  schema: {
    properties: {
      width: { type: 'string', enum: [...SECTION_WIDTHS], default: 'prose', description: 'Reading lane on the article page: prose (text column), wide or full (content width). Narrow screens always use the full width.' },
      surface: { type: 'string', enum: [...SECTION_SURFACES], default: 'none', description: 'Background treatment behind the section' },
      padding: { type: 'string', enum: [...SECTION_PADDINGS], description: 'Inner padding; defaults to md on a surface and none without one' },
      anchor: { type: 'string', pattern: ANCHOR_RE.source, maxLength: LIMITS.anchor, description: `Element id for in-page links (#anchor); unique among sections and not one of ${RESERVED_ANCHORS.join(', ')}` },
      blocks: { type: 'array', maxItems: LIMITS.sectionChildren, items: ref('Block'), description: 'Any block except section' },
    },
    required: ['blocks'],
    extra: { examples: [SECTION_EXAMPLE] },
  },
};

export const card: BlockDefinition<CardBlock> = {
  type: 'card',
  validate(v, raw, { id, path, ctx }) {
    const title = v.str(raw, 'title', path, S, { optional: true }) || undefined;
    const icon = v.iconName(raw, 'icon', path, true);
    if (icon === null) return undefined;
    let image: CardImage | undefined;
    if (raw.image !== undefined && raw.image !== null) {
      const p = `${path}.image`;
      if (!isObj(raw.image)) { v.err(p, 'must be an object {url, alt?, width?, height?}'); return undefined; }
      const url = v.url(raw.image, 'url', p);
      const alt = v.str(raw.image, 'alt', p, S, { optional: true }) ?? '';
      const size = v.imageSize(raw.image, p);
      if (!url || !size) return undefined;
      image = { url, alt, ...size };
    }
    const footer = v.str(raw, 'footer', path, S, { optional: true }) || undefined;
    const variant = raw.variant === undefined ? 'outline' : raw.variant;
    if (!isOneOf(CARD_VARIANTS, variant)) { v.err(`${path}.variant`, `must be one of ${CARD_VARIANTS.join(', ')}`); return undefined; }
    const accent = raw.accent;
    if (accent !== undefined && !isOneOf(CARD_ACCENTS, accent)) { v.err(`${path}.accent`, `must be one of ${CARD_ACCENTS.join(', ')}`); return undefined; }
    const align = raw.align;
    if (align !== undefined && !isOneOf(CARD_ALIGNS, align)) { v.err(`${path}.align`, `must be one of ${CARD_ALIGNS.join(', ')}`); return undefined; }
    const rawBlocks = raw.blocks === undefined ? [] : raw.blocks;
    if (!Array.isArray(rawBlocks) || rawBlocks.length > LIMITS.cardChildren) {
      v.err(`${path}.blocks`, `must be an array of at most ${LIMITS.cardChildren} blocks`);
      return undefined;
    }
    const blocks = v.blocks(rawBlocks, `${path}.blocks`, childContext(ctx, 'card'));
    if (!blocks) return undefined;
    if (!title && !image && blocks.length === 0) { v.err(path, 'a card needs a title, an image or at least one block'); return undefined; }
    return {
      id, type: 'card', ...(title ? { title } : {}), ...(icon ? { icon } : {}), ...(image ? { image } : {}), blocks,
      ...(footer ? { footer } : {}), variant, ...(accent ? { accent } : {}), ...(align ? { align } : {}),
    };
  },
  markdown(b, ctx) {
    return [
      b.image ? `![${b.image.alt.replace(/[[\]]/g, '')}](${b.image.url})` : '',
      b.title ? `### ${b.title}` : '',
      ctx.blocks(b.blocks),
      b.footer ?? '',
    ].filter(Boolean).join('\n\n');
  },
  searchText: b => [plain(b.title), b.image?.alt ?? '', plain(b.footer)],
  aiText: b => [plain(b.title), b.image?.alt ?? '', plain(b.footer)].filter(Boolean).join(' '),
  weight: (b, nested) => plainLength(b.title) + plainLength(b.footer) + (b.image ? 40 + plainLength(b.image.alt) : 0) + nested(b.blocks),
  schema: {
    properties: {
      title: { ...short, description: 'Card heading (inline text)' },
      icon: { ...iconName, description: 'Optional allowlisted icon shown before the title' },
      image: {
        type: 'object', required: ['url'], properties: { url: httpsUrl, alt: short, ...imageSize }, dependentRequired: imageSizeTogether,
        description: 'Media shown at the top of the card',
      },
      blocks: { type: 'array', maxItems: LIMITS.cardChildren, items: ref('Block'), description: 'Card body: any block except section and card' },
      footer: { ...inline, maxLength: S, description: 'Inline text under the body, e.g. a link to act on' },
      variant: { type: 'string', enum: [...CARD_VARIANTS], default: 'outline' },
      accent: { type: 'string', enum: [...CARD_ACCENTS], description: 'Accent colour for the icon and top edge; omit for the site accent' },
      align: { type: 'string', enum: [...CARD_ALIGNS], default: 'start' },
    },
    extra: {
      description: 'Needs a title, an image or at least one block.',
      anyOf: [{ required: ['title'] }, { required: ['image'] }, { required: ['blocks'], properties: { blocks: { minItems: 1 } } }],
      examples: [CARD_EXAMPLE],
    },
  },
};
