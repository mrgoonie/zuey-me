import type { ArticleDocument, Block } from './schema';
import type { MarkdownContext } from './block-definition';
import { blockDefinition } from './registry';

export { formatBytes } from './markdown-format';

export interface MarkdownOptions {
  /** Absolute article URL used for survey "vote at" links. */
  articleUrl?: string;
}

function blocksToMarkdown(blocks: Block[], ctx: MarkdownContext): string {
  return blocks.map(b => blockDefinition(b.type).markdown(b, ctx)).filter(Boolean).join('\n\n');
}

/** Serializes a document to Markdown in reading order (containers are flattened child by child). */
export function documentToMarkdown(doc: ArticleDocument, opts: MarkdownOptions = {}): string {
  const ctx: MarkdownContext = { articleUrl: opts.articleUrl, blocks: blocks => blocksToMarkdown(blocks, ctx) };
  return blocksToMarkdown(doc.blocks, ctx);
}
