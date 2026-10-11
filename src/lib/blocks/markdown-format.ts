/** Small Markdown and text helpers shared by block definitions (and `formatBytes` by the renderers). */

/** Escapes a value for a single GFM table cell. */
function cell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function gfmTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

export function fence(code: string, lang: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), m => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${code}\n${ticks}`;
}

export function quoteLines(text: string): string {
  return text.split(/\r?\n/).map(l => `> ${l}`).join('\n');
}

/** Italic caption paragraph, or nothing. */
export function mdCaption(text: string | undefined): string {
  return text ? `\n\n*${text}*` : '';
}

export function linkText(text: string): string {
  return text.replace(/[[\]]/g, '');
}

export function fileName(url: string): string {
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
