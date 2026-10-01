/**
 * Tiny inline Markdown subset: **bold**, *italic*, `code`, [label](https://url).
 * Parsed into a node tree that renderers turn into elements, so text is always escaped
 * and raw HTML is never interpreted.
 */

export type InlineNode =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; children: InlineNode[] }
  | { kind: 'italic'; children: InlineNode[] }
  | { kind: 'link'; href: string; children: InlineNode[] };

const INLINE_RE = /\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function parseInline(text: string, depth = 0): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const index = m.index ?? 0;
    if (index > last) nodes.push({ kind: 'text', value: text.slice(last, index) });
    const nested = (s: string): InlineNode[] => (depth < 2 ? parseInline(s, depth + 1) : [{ kind: 'text', value: s }]);
    if (m[1] !== undefined) nodes.push({ kind: 'bold', children: nested(m[1]) });
    else if (m[2] !== undefined) nodes.push({ kind: 'italic', children: nested(m[2]) });
    else if (m[3] !== undefined) nodes.push({ kind: 'code', value: m[3] });
    else if (m[4] !== undefined && m[5] !== undefined) nodes.push({ kind: 'link', href: m[5], children: nested(m[4]) });
    last = index + m[0].length;
  }
  if (last < text.length) nodes.push({ kind: 'text', value: text.slice(last) });
  return nodes;
}

/** Plain text with inline markers removed (used for weights, excerpts and CSV labels). */
export function inlineToPlain(text: string): string {
  const walk = (nodes: InlineNode[]): string =>
    nodes.map(n => (n.kind === 'text' || n.kind === 'code' ? n.value : walk(n.children))).join('');
  return walk(parseInline(text));
}
