import type { ArticleDocument, Block } from './schema';
import { PROVIDER_LABELS } from './embed';

export interface MarkdownOptions {
  /** Absolute article URL used for survey "vote at" links. */
  articleUrl?: string;
}

/** Escapes a value for a single GFM table cell. */
function cell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function gfmTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

function fence(code: string, lang: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), m => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${code}\n${ticks}`;
}

function quoteLines(text: string): string {
  return text.split(/\r?\n/).map(l => `> ${l}`).join('\n');
}

function blockToMarkdown(block: Block, opts: MarkdownOptions): string {
  switch (block.type) {
    case 'paragraph': return block.text;
    case 'heading': return `${'#'.repeat(block.level + 1)} ${block.text}`;
    case 'list': return block.items.map((item, i) => `${block.style === 'number' ? `${i + 1}.` : '-'} ${item}`).join('\n');
    case 'checklist': return block.items.map(item => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n');
    case 'quote': return quoteLines(block.text) + (block.cite ? `\n>\n> — ${block.cite}` : '');
    case 'callout': return quoteLines(`**${block.tone.toUpperCase()}:** ${block.text}`);
    case 'code': return fence(block.code, block.language);
    case 'divider': return '---';
    case 'image': return `![${block.alt.replace(/[[\]]/g, '')}](${block.url})${block.caption ? `\n\n*${block.caption}*` : ''}`;
    case 'embed': return `${block.caption ? `${block.caption}\n\n` : ''}[${PROVIDER_LABELS[block.provider]}: ${block.url}](${block.url})`;
    case 'table': return gfmTable(block.headers, block.rows);
    case 'chart': {
      const title = block.title ? `**${block.title}** (${block.kind} chart)` : `*${block.kind} chart*`;
      const headers = ['Label', ...block.series.map(s => s.name)];
      const rows = block.labels.map((label, i) => [label, ...block.series.map(s => String(s.data[i]))]);
      return `${title}\n\n${gfmTable(headers, rows)}`;
    }
    case 'diagram': return fence(block.source, 'mermaid') + (block.caption ? `\n\n*${block.caption}*` : '');
    case 'survey': {
      const options = block.options.map(o => `- ${o.label}`).join('\n');
      const where = opts.articleUrl ? `(vote at ${opts.articleUrl})` : '(vote on the article page)';
      return `**Survey:** ${block.question}\n\n${options}\n\n${where}`;
    }
    case 'layout':
      return block.children.flatMap(child => child.blocks.map(b => blockToMarkdown(b, opts))).filter(Boolean).join('\n\n');
  }
}

/** Serializes a document to Markdown in reading order (layouts are flattened child by child). */
export function documentToMarkdown(doc: ArticleDocument, opts: MarkdownOptions = {}): string {
  return doc.blocks.map(b => blockToMarkdown(b, opts)).filter(Boolean).join('\n\n');
}
