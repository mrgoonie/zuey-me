import { Component, lazy, Suspense, useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import '../../styles/blocks.css';
import type { ArticleDocument, Block, LayoutBlock } from '../../lib/blocks/schema';
import type { CodeHighlights } from '../../lib/blocks/code-syntax';
import { childBlockLists, documentLanes, imageSizeAttrs, isChartV2, isDataTable, resolveSpan } from '../../lib/blocks/schema';
import { responsiveImage } from '../../lib/media/image-transform';
import type { ImageTransforms } from '../../lib/media/image-transform';
import { parseInline } from '../../lib/blocks/inline';
import type { InlineNode } from '../../lib/blocks/inline';
import { CodeView } from './CodeBlock';
import { EmbedView } from './EmbedView';
import { ChartBlock } from './ChartBlock';
import { ChartV2 as StaticChartV2 } from './ChartV2Block';
import type { ChartV2Props } from './ChartV2Block';
import { MediaBlockView } from './MediaBlocks';
import { MathView } from './MathBlock';
import { mathMarkup, mathNumbers } from '../../lib/blocks/math';
import type { MathNumber } from '../../lib/blocks/math';
import type { MathRenders } from '../../lib/blocks/math';
import { CardView, SectionView } from './ContainerBlocks';
import { DiagramBlock } from './DiagramBlock';
import { SurveyBlock } from './SurveyBlock';
import { IconGlyph as StaticIconGlyph } from './block-icons';
import type { IconGlyphProps } from './block-icons';
import { ICON_PIXELS, isIconName } from '../../lib/blocks/icons';
import { DataTable as StaticDataTable } from './TableBlock';
import type { DataTableProps } from './TableBlock';
import { InteractiveFrame } from '../ai/InteractiveFrame';

type CssVars = CSSProperties & { [key: `--${string}`]: string | number };

/**
 * The icon map (~40 KB) ships to the browser only for documents that use icons: the client loads it
 * on demand, while the server renders the SVG directly. `import.meta.env.SSR` is a build-time
 * constant, so the static import is dropped from client bundles.
 */
const LazyIconGlyph = lazy(() => import('./block-icons').then(m => ({ default: m.IconGlyph })));

/** Same-size empty box shown while the icon chunk loads (client-only renders such as Studio previews). */
export function IconPlaceholder({ size }: { size: IconGlyphProps['size'] }) {
  const px = typeof size === 'number' ? size : ICON_PIXELS[size];
  return <span aria-hidden="true" style={{ display: 'inline-block', width: px, height: px }} />;
}

/**
 * Keeps a lazy island's failure local: when its chunk cannot load (network error, or a page cached across a deploy
 * whose chunk hashes changed), the block shows its fallback instead of the error unmounting the whole article.
 */
export class LazyBoundary extends Component<{ fallback: ReactNode; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * The Suspense boundary must exist on both sides: the server emits its markers around the SVG, so
 * hydration keeps the server markup in place until the lazy chunk resolves instead of failing.
 */
function IconSlot(props: IconGlyphProps) {
  return (
    <LazyBoundary fallback={<IconPlaceholder size={props.size} />}>
      <Suspense fallback={<IconPlaceholder size={props.size} />}>
        {import.meta.env.SSR ? <StaticIconGlyph {...props} /> : <LazyIconGlyph {...props} />}
      </Suspense>
    </LazyBoundary>
  );
}

/**
 * Data tables (sort, search, filters, CSV) load their script only on pages that have one, like icons: the
 * server renders the full table, and hydration keeps that markup until the chunk resolves.
 */
const LazyDataTable = lazy(() => import('./TableBlock'));

/** Plain table markup: every stored table without options, and the placeholder while a data table loads on the client. */
function PlainTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="zb-scroll">
      <table className="zb-table">
        <thead><tr>{headers.map((h, i) => <th scope="col" key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>{row.map((c, i) => <td key={i}><Inline text={c} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** While the chunk loads, or if it fails, the client shows every row as a plain table (raw values, no controls). */
function DataTableSlot(props: DataTableProps) {
  const fallback = <PlainTable headers={props.block.headers} rows={props.block.rows} />;
  return (
    <LazyBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        {import.meta.env.SSR ? <StaticDataTable {...props} /> : <LazyDataTable {...props} />}
      </Suspense>
    </LazyBoundary>
  );
}

/**
 * Charts with v2 options load their component the same way (Chart.js itself is imported inside its effect). While
 * the chunk loads, or if it fails, the client shows the figures as a plain table, so no value is lost.
 */
const LazyChartV2 = lazy(() => import('./ChartV2Block'));

function ChartV2Slot(props: ChartV2Props) {
  const { block } = props;
  // The stored values, built here rather than with the chart helpers so they (and the formatting code they bring)
  // stay in the chart chunk. Same shell as BlockFrame.
  const scatter = block.kind === 'scatter';
  const headers = [block.x?.title ?? '', ...block.series.flatMap(s => (scatter ? [`${s.name} (x)`, `${s.name} (y)`] : [s.name]))];
  const rows = block.labels.map((l, i) => [
    l, ...block.series.flatMap(s => (scatter ? [String(s.x?.[i] ?? ''), String(s.data[i] ?? '')] : [String(s.data[i] ?? '')])),
  ]);
  const fallback = (
    <figure className="zb-frame zb-chart zb-chart-v2">
      {block.title && <div className="zb-frame-head"><div className="zb-frame-title">{block.title}</div></div>}
      <div className="zb-frame-body zb-scroll">
        <table className="zb-table">
          <thead><tr>{headers.map((h, i) => <th scope="col" key={i}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((row, r) => <tr key={r}>{row.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </figure>
  );
  return (
    <LazyBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        {import.meta.env.SSR ? <StaticChartV2 {...props} /> : <LazyChartV2 {...props} />}
      </Suspense>
    </LazyBoundary>
  );
}

interface RenderContext {
  articleSlug?: string;
  interactive: boolean;
  highlights?: CodeHighlights;
  liveHighlight: boolean;
  autoLoadEmbeds: boolean;
  autoRunInteractives: boolean;
  /** Id of the image or gallery block whose (first) image is the page's likely LCP element; it loads eagerly at high priority. */
  leadImageId?: string;
  /** Resized `srcset` through Cloudflare Image Transformations; absent for HTML fragments (email, feeds), which keep originals. */
  imageTransforms?: ImageTransforms | null;
  /** `sizes` for full-width body images (the prose column, or the wider lanes). */
  imageSizes: string;
  /** Server-typeset KaTeX markup by math block id. */
  math?: MathRenders;
  /** Equation numbering of display formulas by block id. */
  mathNumbers: Map<string, MathNumber>;
  liveMath: boolean;
  locale?: string;
}

/** Only an image this close to the top is likely to be the LCP element. */
const LEAD_IMAGE_TOP_BLOCKS = 3;

/**
 * The block holding the document's first image, by the same rule as `firstImage` (a gallery's first image
 * counts), when it sits in the first few top-level blocks. Images inside a toggle start hidden and are skipped.
 */
export function leadImageBlockId(blocks: Block[]): string | undefined {
  let id: string | undefined;
  const visit = (list: Block[]) => {
    for (const b of list) {
      if (id) return;
      if (b.type === 'image' || (b.type === 'gallery' && b.images.length > 0)) { id = b.id; return; }
      if (b.type !== 'toggle') for (const children of childBlockLists(b)) visit(children);
    }
  };
  visit(blocks.slice(0, LEAD_IMAGE_TOP_BLOCKS));
  return id;
}

function renderNodes(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text': return n.value;
      case 'code': return <code key={i}>{n.value}</code>;
      case 'bold': return <strong key={i}>{renderNodes(n.children)}</strong>;
      case 'italic': return <em key={i}>{renderNodes(n.children)}</em>;
      case 'strike': return <s key={i}>{renderNodes(n.children)}</s>;
      case 'mark': return <mark key={i}>{renderNodes(n.children)}</mark>;
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">{renderNodes(n.children)}</a>;
    }
  });
}

/** Escaping renderer for the inline Markdown subset; line breaks become <br>. */
export function Inline({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return <>{lines.map((line, i) => <span key={i}>{i > 0 && <br />}{renderNodes(parseInline(line))}</span>)}</>;
}

function LayoutView({ block, ctx }: { block: LayoutBlock; ctx: RenderContext }) {
  const style: CssVars = { '--zl-cols-base': block.cols.base, '--zl-cols-md': block.cols.md, '--zl-cols-lg': block.cols.lg };
  return (
    <div className={`zb-layout zb-layout-${block.variant} zb-gap-${block.gap ?? 'md'}`} style={style}>
      {block.children.map((child, i) => {
        const span = resolveSpan(child.span, block.cols);
        const cellStyle: CssVars = {
          '--zl-span-base': span.base, '--zl-span-md': span.md, '--zl-span-lg': span.lg, '--zl-row': child.rowSpan ?? 1,
        };
        return (
          <div className="zb-cell" style={cellStyle} key={i}>
            {child.blocks.map(b => <BlockView key={b.id} block={b} ctx={ctx} />)}
          </div>
        );
      })}
    </div>
  );
}

function BlockView({ block, ctx }: { block: Block; ctx: RenderContext }) {
  switch (block.type) {
    case 'paragraph': return <p><Inline text={block.text} /></p>;
    case 'heading': {
      const Tag = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
      return <Tag className={`zb-h zb-h${block.level}`}><Inline text={block.text} /></Tag>;
    }
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}><Inline text={item} /></li>);
      return block.style === 'number' ? <ol className="zb-list">{items}</ol> : <ul className="zb-list">{items}</ul>;
    }
    case 'checklist':
      return (
        <ul className="zb-checklist">
          {block.items.map((item, i) => (
            <li key={i}>
              <span className={`zb-check${item.checked ? ' zb-checked' : ''}`} aria-hidden="true">{item.checked ? '✓' : ''}</span>
              <span className="zb-sr-only">{item.checked ? 'Đã xong: ' : 'Chưa xong: '}</span>
              <span className={item.checked ? 'zb-done' : undefined}><Inline text={item.text} /></span>
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote className="zb-quote">
          <Inline text={block.text} />
          {block.cite && <footer>— {block.cite}</footer>}
        </blockquote>
      );
    case 'callout': {
      const glyph = block.tone === 'warn' ? '!' : block.tone === 'tip' ? '★' : 'i';
      return (
        <aside className={`zb-callout zb-callout-${block.tone}`} role="note">
          <span className="zb-callout-icon" aria-hidden="true">
            {isIconName(block.icon) ? <IconSlot name={block.icon} size={20} /> : glyph}
          </span>
          <div style={{ minWidth: 0 }}><Inline text={block.text} /></div>
        </aside>
      );
    }
    case 'code': return <CodeView block={block} highlights={ctx.highlights} liveHighlight={ctx.liveHighlight} />;
    case 'divider': return <hr className="zb-divider" />;
    case 'image': {
      // The ratio lets the stylesheet cap a tall portrait's width so its height stays within the viewport.
      const style: CssVars | undefined = block.width && block.height ? { '--zb-img-ratio': `${block.width} / ${block.height}` } : undefined;
      const source = responsiveImage(block.url, block.width, ctx.imageSizes, ctx.imageTransforms);
      return (
        <figure className="zb-figure zb-figure-center">
          {ctx.leadImageId === block.id
            ? <img {...source} alt={block.alt} fetchPriority="high" decoding="async" {...imageSizeAttrs(block)} style={style} />
            : <img {...source} alt={block.alt} loading="lazy" decoding="async" {...imageSizeAttrs(block)} style={style} />}
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
    }
    case 'embed': return <EmbedView key={block.url} block={block} autoLoad={ctx.autoLoadEmbeds} />;
    case 'table':
      return isDataTable(block)
        ? <DataTableSlot block={block} locale={ctx.locale} renderInline={text => <Inline text={text} />} />
        : <PlainTable headers={block.headers} rows={block.rows} />;
    case 'chart':
      return isChartV2(block)
        ? <ChartV2Slot block={block} locale={ctx.locale} renderInline={text => <Inline text={text} />} />
        : <ChartBlock block={block} />;
    case 'diagram': return <DiagramBlock block={block} />;
    case 'survey': return <SurveyBlock block={block} articleSlug={ctx.articleSlug} interactive={ctx.interactive} />;
    case 'layout': return <LayoutView block={block} ctx={ctx} />;
    // Always sandboxed. Published readers start it when it nears the viewport; Studio previews and drafts stay click-to-run.
    case 'interactive': return <InteractiveFrame block={block} runWhenVisible={ctx.autoRunInteractives} />;
    case 'icon':
      return (
        <div className={`zb-icon zb-icon-${block.align ?? 'start'} zb-icon-tone-${block.tone}`}>
          <IconSlot name={block.name} size={block.size} label={block.label} />
        </div>
      );
    case 'math':
      return <MathView block={block} html={mathMarkup(ctx.math, block.id)} failed={ctx.math !== undefined} number={ctx.mathNumbers.get(block.id)} live={ctx.liveMath} />;
    case 'gallery':
    case 'audio':
    case 'video':
    case 'file':
    case 'bookmark':
    case 'toggle':
      return (
        <MediaBlockView
          block={block}
          imageTransforms={ctx.imageTransforms}
          eagerFirstImage={ctx.leadImageId === block.id}
          renderInline={text => <Inline text={text} />}
          renderBlocks={blocks => blocks.map(b => <BlockView key={b.id} block={b} ctx={ctx} />)}
        />
      );
    case 'section':
      return <SectionView block={block} renderBlocks={blocks => blocks.map(b => <BlockView key={b.id} block={b} ctx={ctx} />)} />;
    case 'card':
      return (
        <CardView
          block={block}
          renderInline={text => <Inline text={text} />}
          renderIcon={name => <IconSlot name={name} size={22} />}
          renderBlocks={blocks => blocks.map(b => <BlockView key={b.id} block={b} ctx={ctx} />)}
        />
      );
  }
}

interface BlockRendererProps {
  doc: ArticleDocument;
  /** Published article slug; enables survey voting. */
  articleSlug?: string;
  /** False in editor previews (surveys are shown but cannot be submitted). */
  interactive?: boolean;
  /** Server-computed code token runs by block id (see `highlightBlocks`); missing blocks render plain. */
  highlights?: CodeHighlights;
  /** Highlight code blocks on the client by lazy-loading the highlighter (Studio previews). */
  liveHighlight?: boolean;
  /** Third-party embeds load by themselves when scrolled into view (default). False keeps them click-to-load (every Studio preview). */
  autoLoadEmbeds?: boolean;
  /**
   * Interactive widgets start by themselves when scrolled into view (published article and lesson readers only).
   * Off by default, so Studio previews, drafts and HTML fragments never run widget code without a click.
   */
  autoRunInteractives?: boolean;
  /** Load the first image eagerly at high priority (the article page, where it is usually the LCP element). Off for HTML fragments. */
  eagerLeadImage?: boolean;
  /** Serve resized images (see `imageTransformsFor`); only the article page passes it, so fragments keep original URLs. */
  imageTransforms?: ImageTransforms | null;
  /** Server-typeset KaTeX markup by block id (see `renderMathBlocks`); math without an entry shows its TeX source. */
  math?: MathRenders;
  /** Typeset math on the client by lazy-loading KaTeX (Studio previews). */
  liveMath?: boolean;
  /** Edition locale; data tables format numbers, dates and their labels for it (Vietnamese when absent). */
  locale?: string;
  /** Equation numbers when doc is one part of a longer document (lesson runs); computed from doc otherwise. */
  mathNumbering?: Map<string, MathNumber>;
}

/** Article column width in CSS px: max-w-[860px] or the 1240px lanes, minus the card's horizontal padding. */
function bodyImageSizes(lanes: boolean): string {
  return lanes ? '(min-width: 1280px) 1150px, 100vw' : '(min-width: 880px) 770px, 100vw';
}

/** SSR-safe renderer for a block document. Rich blocks enhance themselves on the client. */
export function BlockRenderer({
  doc, articleSlug, interactive = true, highlights, liveHighlight = false, autoLoadEmbeds = true, autoRunInteractives = false,
  eagerLeadImage = false, imageTransforms, math, liveMath = false, mathNumbering, locale,
}: BlockRendererProps) {
  const ownNumbers = useMemo(() => (mathNumbering ? null : mathNumbers(doc.blocks, math)), [doc, math, mathNumbering]);
  // Width lanes switch on only for documents with a wide or full section, so prose-only documents keep their markup.
  const lanes = documentLanes(doc);
  const ctx: RenderContext = {
    articleSlug, interactive, highlights, liveHighlight, autoLoadEmbeds, autoRunInteractives, imageTransforms,
    leadImageId: eagerLeadImage ? leadImageBlockId(doc.blocks) : undefined,
    imageSizes: bodyImageSizes(lanes.length > 0),
    math, mathNumbers: mathNumbering ?? ownNumbers ?? new Map<string, MathNumber>(), liveMath, locale,
  };
  return (
    <div className="zb-doc" data-lanes={lanes.length > 0 ? lanes.join(' ') : undefined}>
      {doc.blocks.map(b => <BlockView key={b.id} block={b} ctx={ctx} />)}
    </div>
  );
}

export default BlockRenderer;
