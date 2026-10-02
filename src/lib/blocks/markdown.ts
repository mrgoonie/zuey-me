import type { ArticleDocument, Block } from './schema';
import { isPdfUrl } from './schema';
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
    case 'interactive': {
      // Source code never leaves the sandboxed renderer through Markdown: text fallback plus a link to run it.
      const where = opts.articleUrl ? `[Open the interactive version](${opts.articleUrl})` : '(open the article page to run it)';
      return `**Interactive:** ${block.title}${block.caption ? `\n\n*${block.caption}*` : ''}\n\n${where}`;
    }
    case 'math': return `$$\n${block.tex}\n$$${caption(block.caption)}`;
    case 'gallery':
      return block.images.map(img => `![${linkText(img.alt)}](${img.url})${img.caption ? ` — ${img.caption}` : ''}`).join('\n\n') + caption(block.caption);
    case 'audio': return `[Audio: ${linkText(block.title || fileName(block.url))}](${block.url})${caption(block.caption)}`;
    case 'video': return `[Video: ${linkText(block.title || fileName(block.url))}](${block.url})${caption(block.caption)}`;
    case 'file': {
      const size = block.sizeBytes !== undefined ? `, ${formatBytes(block.sizeBytes)}` : '';
      const kind = isPdfUrl(block.url) ? 'PDF' : 'File';
      return `[${kind}: ${linkText(block.name)}${size}](${block.url})${caption(block.caption)}`;
    }
    case 'bookmark': {
      const title = linkText(block.title || block.url);
      const meta = [block.siteName, block.description].filter(Boolean).join(' — ');
      return `[${title}](${block.url})${meta ? `\n\n> ${meta.replace(/\r?\n/g, ' ')}` : ''}`;
    }
    case 'toggle': {
      const inner = block.blocks.map(b => blockToMarkdown(b, opts)).filter(Boolean).join('\n\n');
      return `**${block.summary}**${inner ? `\n\n${inner}` : ''}`;
    }
  }
}

function caption(text: string | undefined): string {
  return text ? `\n\n*${text}*` : '';
}

function linkText(text: string): string {
  return text.replace(/[[\]]/g, '');
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
  } catch {
    return url;
  }
}

/** Human-readable size (1 KB = 1024 bytes). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Serializes a document to Markdown in reading order (layouts are flattened child by child). */
export function documentToMarkdown(doc: ArticleDocument, opts: MarkdownOptions = {}): string {
  return doc.blocks.map(b => blockToMarkdown(b, opts)).filter(Boolean).join('\n\n');
}
