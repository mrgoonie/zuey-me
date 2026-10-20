import { extractLinks, htmlToText } from './extract';
import { DEFAULT_ENTRIES, type Page } from './types';

export type PageFetcher = (url: string) => Promise<{ ok: boolean; contentType: string; body: string }>;

const ASSET = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|mp4|webm|pdf|zip)(\?|$)/i;
const MAX_PAGES = 15;

function toPage(url: string, contentType: string, body: string): Page {
  const isHtml = /html/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(body);
  return { url, text: isHtml ? htmlToText(body) : body, links: extractLinks(body, url) };
}

/**
 * Simulates an agent without JS: fetch the entry points, then follow same-origin links whose URL or
 * anchor text matches `follow`, up to `maxHops` hops. No deep URL is ever hard-coded.
 */
export async function crawl(
  base: string,
  fetchPage: PageFetcher,
  opts: { entries?: string[]; follow: string; maxHops: number },
): Promise<Page[]> {
  const origin = new URL(base).origin;
  const followRe = new RegExp(opts.follow, 'i');
  const pages: Page[] = [];
  const visited = new Set<string>();
  const key = (u: string) => u.split('#')[0];
  let frontier = (opts.entries ?? DEFAULT_ENTRIES).map((e) => new URL(e, origin).href);

  for (let hop = 0; hop <= opts.maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const url of frontier) {
      if (visited.has(key(url)) || pages.length >= MAX_PAGES) continue;
      visited.add(key(url));
      let res: Awaited<ReturnType<PageFetcher>>;
      try { res = await fetchPage(url); } catch { continue; }
      if (!res.ok) continue;
      const page = toPage(url, res.contentType, res.body);
      pages.push(page);
      for (const l of page.links) {
        if (new URL(l.href).origin !== origin || ASSET.test(l.href)) continue;
        if (followRe.test(l.href) || (l.text && followRe.test(l.text))) next.push(l.href);
      }
    }
    frontier = next;
  }
  return pages;
}
