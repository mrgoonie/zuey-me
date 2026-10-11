import { Fragment, lazy, Suspense, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import '../../styles/blocks.css';
import type { ArticleDocument, Block, CodeBlock, LayoutBlock } from '../../lib/blocks/schema';
import { codeRuns, codeSegments, normalizeCode, resolveHighlightLanguage } from '../../lib/blocks/code-syntax';
import type { CodeHighlights, CodeSegment, TokenRuns } from '../../lib/blocks/code-syntax';
import { resolveSpan } from '../../lib/blocks/schema';
import { parseInline } from '../../lib/blocks/inline';
import type { InlineNode } from '../../lib/blocks/inline';
import { EmbedView } from './EmbedView';
import { ChartBlock } from './ChartBlock';
import { MediaBlockView } from './MediaBlocks';
import { DiagramBlock } from './DiagramBlock';
import { SurveyBlock } from './SurveyBlock';
import { IconGlyph as StaticIconGlyph } from './block-icons';
import type { IconGlyphProps } from './block-icons';
import { ICON_PIXELS, isIconName } from '../../lib/blocks/icons';
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
 * The Suspense boundary must exist on both sides: the server emits its markers around the SVG, so
 * hydration keeps the server markup in place until the lazy chunk resolves instead of failing.
 */
function IconSlot(props: IconGlyphProps) {
  return (
    <Suspense fallback={<IconPlaceholder size={props.size} />}>
      {import.meta.env.SSR ? <StaticIconGlyph {...props} /> : <LazyIconGlyph {...props} />}
    </Suspense>
  );
}

interface RenderContext {
  articleSlug?: string;
  interactive: boolean;
  highlights?: CodeHighlights;
  liveHighlight: boolean;
  autoLoadEmbeds: boolean;
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

/** Studio previews re-highlight after typing pauses for this long. */
const LIVE_HIGHLIGHT_DELAY_MS = 150;

function renderSegments(segments: CodeSegment[]): ReactNode[] {
  return segments.map(({ text, kind }, i) => (kind
    ? <span key={i} className={`zb-tk-${kind}`}>{text}</span>
    : <Fragment key={i}>{text}</Fragment>));
}

/**
 * Code block. Token runs come pre-computed from the server (`highlights`, so no-JS readers get colours and
 * hydration matches) or, in Studio previews, from the highlighter loaded lazily on the client. Runs only carry
 * lengths and kinds; the text is always sliced from the block's own code, and runs that do not cover it exactly
 * are ignored. Line endings are normalised to LF so the server HTML parses back to the same text.
 */
function CodeView({ block, ctx }: { block: CodeBlock; ctx: RenderContext }) {
  const text = normalizeCode(block.code);
  const provided = codeRuns(ctx.highlights, block.id, text.length);
  const source = `${block.language}\u0000${text}`;
  const [live, setLive] = useState<{ source: string; runs: TokenRuns | null } | null>(null);
  const wantsLive = ctx.liveHighlight && !provided && resolveHighlightLanguage(block.language) !== null;

  useEffect(() => {
    if (!wantsLive) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      import('../../lib/blocks/code-highlight')
        .then(m => { if (!cancelled) setLive({ source, runs: m.highlightCode(block.code, block.language) }); })
        // The highlighter chunk failed to load (offline, deploy skew): the preview keeps plain code.
        .catch(() => { if (!cancelled) setLive({ source, runs: null }); });
    }, LIVE_HIGHLIGHT_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [wantsLive, source, block.code, block.language]);

  const runs = provided ?? (live?.source === source ? live.runs : null);
  const segments = runs ? codeSegments(text, runs) : null;
  return (
    <pre className="zb-code">
      {block.language && <span className="zb-code-lang">{block.language}</span>}
      <code>{segments ? renderSegments(segments) : text}</code>
    </pre>
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
    case 'code': return <CodeView block={block} ctx={ctx} />;
    case 'divider': return <hr className="zb-divider" />;
    case 'image':
      return (
        <figure className="zb-figure">
          <img src={block.url} alt={block.alt} loading="lazy" decoding="async" />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
    case 'embed': return <EmbedView block={block} autoLoad={ctx.autoLoadEmbeds} />;
    case 'table':
      return (
        <div className="zb-scroll">
          <table className="zb-table">
            <thead><tr>{block.headers.map((h, i) => <th scope="col" key={i}>{h}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((c, i) => <td key={i}><Inline text={c} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'chart': return <ChartBlock block={block} />;
    case 'diagram': return <DiagramBlock block={block} />;
    case 'survey': return <SurveyBlock block={block} articleSlug={ctx.articleSlug} interactive={ctx.interactive} />;
    case 'layout': return <LayoutView block={block} ctx={ctx} />;
    // Sandboxed, click-to-run in articles; previews never execute code automatically.
    case 'interactive': return <InteractiveFrame block={block} />;
    case 'icon':
      return (
        <div className={`zb-icon zb-icon-${block.align ?? 'start'} zb-icon-tone-${block.tone}`}>
          <IconSlot name={block.name} size={block.size} label={block.label} />
        </div>
      );
    case 'math':
    case 'gallery':
    case 'audio':
    case 'video':
    case 'file':
    case 'bookmark':
    case 'toggle':
      return (
        <MediaBlockView
          block={block}
          renderInline={text => <Inline text={text} />}
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
  /** Third-party embeds load by themselves when scrolled into view (default). False keeps them click-to-load. */
  autoLoadEmbeds?: boolean;
}

/** SSR-safe renderer for a block document. Rich blocks enhance themselves on the client. */
export function BlockRenderer({ doc, articleSlug, interactive = true, highlights, liveHighlight = false, autoLoadEmbeds = true }: BlockRendererProps) {
  const ctx: RenderContext = { articleSlug, interactive, highlights, liveHighlight, autoLoadEmbeds };
  return (
    <div className="zb-doc">
      {doc.blocks.map(b => <BlockView key={b.id} block={b} ctx={ctx} />)}
    </div>
  );
}

export default BlockRenderer;
