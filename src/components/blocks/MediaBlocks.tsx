import { useState } from 'react';
import type { ReactNode } from 'react';
import './media-blocks.css';
import type { Block, FileBlock, KnowledgeMediaBlock } from '../../lib/blocks/schema';
import { isPdfUrl } from '../../lib/blocks/schema';
import { formatBytes } from '../../lib/blocks/markdown';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** PDFs load inline only after the reader asks (no third-party request before that). */
function FileView({ block }: { block: FileBlock }) {
  const [open, setOpen] = useState(false);
  const pdf = isPdfUrl(block.url);
  const meta = [pdf ? 'PDF' : null, block.sizeBytes !== undefined ? formatBytes(block.sizeBytes) : null, hostOf(block.url)].filter(Boolean).join(' · ');
  return (
    <figure className="zb-media">
      <div className="zb-file">
        <span className="zb-file-icon" aria-hidden="true">{pdf ? 'PDF' : 'FILE'}</span>
        <div className="zb-file-main">
          <div className="zb-file-name">{block.name}</div>
          <div className="zb-file-meta">{meta}</div>
        </div>
        <div className="zb-file-actions">
          {pdf && (
            <button type="button" className="zb-btn" aria-expanded={open} onClick={() => setOpen(v => !v)}>
              {open ? 'Ẩn bản xem' : 'Xem PDF'}
            </button>
          )}
          <a href={block.url} target="_blank" rel="noopener noreferrer nofollow" download={pdf ? undefined : block.name}>Tải về</a>
        </div>
      </div>
      {pdf && open && <iframe className="zb-pdf-frame" src={block.url} title={block.name} loading="lazy" referrerPolicy="no-referrer" />}
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  );
}

interface MediaBlockProps {
  block: KnowledgeMediaBlock;
  /** Renders nested blocks (toggle content) with the parent renderer. */
  renderBlocks: (blocks: Block[]) => ReactNode;
  /** Inline Markdown renderer from the parent (keeps marks consistent). */
  renderInline: (text: string) => ReactNode;
}

/** Rendering for the knowledge media block family; every block has a no-JS-safe link fallback. */
export function MediaBlockView({ block, renderBlocks, renderInline }: MediaBlockProps) {
  switch (block.type) {
    case 'math':
      return (
        <figure className="zb-math">
          <span className="zb-math-tag" aria-hidden="true">TeX</span>
          {/* No math typesetter is bundled: show the TeX source, exposed to assistive tech as math. */}
          <code role="math" aria-label={block.tex}>{block.tex}</code>
          {block.caption && <figcaption className="zb-caption">{block.caption}</figcaption>}
        </figure>
      );
    case 'gallery':
      return (
        <figure className="zb-figure">
          <ul className="zb-gallery">
            {block.images.map((img, i) => (
              <li key={i}>
                <figure>
                  <a href={img.url} target="_blank" rel="noopener noreferrer nofollow">
                    <img src={img.url} alt={img.alt} loading="lazy" decoding="async" />
                  </a>
                  {img.caption && <figcaption>{img.caption}</figcaption>}
                </figure>
              </li>
            ))}
          </ul>
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
    case 'audio':
      return (
        <figure className="zb-media">
          {block.title && <div className="zb-media-title">{block.title}</div>}
          <audio controls preload="none" src={block.url}>
            <a href={block.url}>{block.title || block.url}</a>
          </audio>
          {block.caption && <figcaption className="zb-caption">{block.caption}</figcaption>}
        </figure>
      );
    case 'video':
      return (
        <figure className="zb-media">
          {block.title && <div className="zb-media-title">{block.title}</div>}
          <video controls preload="none" playsInline poster={block.poster} src={block.url} aria-label={block.title || block.caption || 'Video'}>
            <a href={block.url}>{block.title || block.url}</a>
          </video>
          {block.caption && <figcaption className="zb-caption">{block.caption}</figcaption>}
        </figure>
      );
    case 'file':
      return <FileView block={block} />;
    case 'bookmark':
      return (
        <a className="zb-bookmark" href={block.url} target="_blank" rel="noopener noreferrer nofollow">
          <span className="zb-bookmark-body">
            <span className="zb-bookmark-title" style={{ display: 'block' }}>{block.title || block.url}</span>
            {block.description && <span className="zb-bookmark-desc">{block.description}</span>}
            <span className="zb-bookmark-site" style={{ display: 'block' }}>{block.siteName || hostOf(block.url)}</span>
          </span>
          {block.image && <img className="zb-bookmark-img" src={block.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />}
        </a>
      );
    case 'toggle':
      return (
        <details className="zb-toggle" open={block.open}>
          <summary>{renderInline(block.summary)}</summary>
          <div className="zb-toggle-body">{renderBlocks(block.blocks)}</div>
        </details>
      );
  }
}
