import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import '../../styles/blocks.css';
import type { ArticleDocument, Block, EmbedBlock, LayoutBlock } from '../../lib/blocks/schema';
import { resolveSpan } from '../../lib/blocks/schema';
import { parseInline } from '../../lib/blocks/inline';
import type { InlineNode } from '../../lib/blocks/inline';
import { embedFrame, embedSrc, PROVIDER_LABELS } from '../../lib/blocks/embed';
import { ChartBlock } from './ChartBlock';
import { MediaBlockView } from './MediaBlocks';
import { DiagramBlock } from './DiagramBlock';
import { SurveyBlock } from './SurveyBlock';
import { InteractiveFrame } from '../ai/InteractiveFrame';

type CssVars = CSSProperties & { [key: `--${string}`]: string | number };

interface RenderContext {
  articleSlug?: string;
  interactive: boolean;
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

function frameClass(block: EmbedBlock): string {
  return `zb-ratio-${embedFrame(block.provider, block.url)}`;
}

/** Click-to-load embed: no third-party request happens until the reader opts in. */
function EmbedView({ block }: { block: EmbedBlock }) {
  const [loaded, setLoaded] = useState(false);
  const src = embedSrc(block.url, block.provider);
  const label = PROVIDER_LABELS[block.provider];
  return (
    <figure className="zb-figure zb-embed">
      <div className="zb-embed-head">
        <span className="zb-embed-provider">{label}</span>
        <span style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {src && !loaded && (
            <button type="button" className="zb-btn" onClick={() => setLoaded(true)}>Tải nội dung từ {label}</button>
          )}
          <a href={block.url} target="_blank" rel="noopener noreferrer nofollow">Mở liên kết</a>
        </span>
      </div>
      {src && !loaded && <p className="zb-note" style={{ marginTop: '0.5rem' }}>Nội dung nhúng chỉ tải khi bạn bấm, để {label} không theo dõi bạn trước.</p>}
      {src && loaded && (
        <div className={`zb-embed-frame ${frameClass(block)}`}>
          <iframe
            src={src}
            title={block.caption || `${label} embed`}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        </div>
      )}
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  );
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
      const icon = block.tone === 'warn' ? '!' : block.tone === 'tip' ? '★' : 'i';
      return (
        <aside className={`zb-callout zb-callout-${block.tone}`} role="note">
          <span className="zb-callout-icon" aria-hidden="true">{icon}</span>
          <div style={{ minWidth: 0 }}><Inline text={block.text} /></div>
        </aside>
      );
    }
    case 'code':
      return (
        <pre className="zb-code">
          {block.language && <span className="zb-code-lang">{block.language}</span>}
          <code>{block.code}</code>
        </pre>
      );
    case 'divider': return <hr className="zb-divider" />;
    case 'image':
      return (
        <figure className="zb-figure">
          <img src={block.url} alt={block.alt} loading="lazy" decoding="async" />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
    case 'embed': return <EmbedView block={block} />;
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
}

/** SSR-safe renderer for a block document. Rich blocks enhance themselves on the client. */
export function BlockRenderer({ doc, articleSlug, interactive = true }: BlockRendererProps) {
  const ctx: RenderContext = { articleSlug, interactive };
  return (
    <div className="zb-doc">
      {doc.blocks.map(b => <BlockView key={b.id} block={b} ctx={ctx} />)}
    </div>
  );
}

export default BlockRenderer;
