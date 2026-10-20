import type { Link } from './types';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML page without running JS: scripts, styles and comments are dropped. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function resolve(href: string, base: string): string | null {
  const h = decodeEntities(href.trim());
  if (!h || /^(mailto:|tel:|javascript:|data:)/i.test(h)) return null;
  try { return new URL(h, base).href; } catch { return null; }
}

/** Links an agent can see in a fetched document: HTML anchors, Markdown links and bare URLs. */
export function extractLinks(rawBody: string, pageUrl: string): Link[] {
  const body = rawBody.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, ' ');
  const out: Link[] = [];
  const seen = new Set<string>();
  const add = (href: string | null, text: string) => {
    if (!href) return;
    const key = `${href}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ href, text: text.replace(/\s+/g, ' ').trim() });
  };

  for (const m of body.matchAll(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    add(resolve(m[1] ?? m[2] ?? '', pageUrl), htmlToText(m[3]));
  }
  for (const m of body.matchAll(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    add(resolve(m[2], pageUrl), m[1]);
  }
  // Bare URLs (llms.txt style "Label: https://..."), not already inside a markdown/HTML link.
  const stripped = body.replace(/\]\([^)]*\)/g, ' ').replace(/(?:href|src)\s*=\s*"[^"]*"/gi, ' ');
  for (const m of stripped.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    add(resolve(m[0].replace(/[.,;:]+$/, ''), pageUrl), '');
  }
  return out;
}
