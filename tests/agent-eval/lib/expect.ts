import type { Expectation, Matcher, Page } from './types';

export interface Evidence {
  /** Concatenated readable text of everything the agent fetched. */
  text: string;
  /** Every link the agent saw (absolute URLs). */
  hrefs: string[];
  /** Origin substituted for `{base}` in patterns. */
  base?: string;
}

export const normalizeSpace = (s: string) => s.replace(/\s+/g, ' ').trim();
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function evidenceFromPages(pages: Page[], base?: string): Evidence {
  return {
    base,
    text: normalizeSpace(pages.map((p) => p.text).join('\n')),
    hrefs: pages.flatMap((p) => p.links.map((l) => l.href)),
  };
}

const re = (src: string, ev: Evidence) => new RegExp(src.replaceAll('{base}', escapeRegex(ev.base ?? '')), 'i');

export function matcherHolds(m: Matcher, ev: Evidence): boolean {
  if ('link' in m) return ev.hrefs.some((h) => re(m.link, ev).test(h));
  if ('text' in m) return re(m.text, ev).test(ev.text);
  return !re(m.notText, ev).test(ev.text);
}

const describe = (m: Matcher) =>
  'link' in m ? `link /${m.link}/` : 'text' in m ? `text /${m.text}/` : `no text /${m.notText}/`;

export function checkExpectation(exp: Expectation, ev: Evidence): { passed: boolean; reason: string } {
  const failed = exp.matchers.filter((m) => !matcherHolds(m, ev));
  const need = exp.min ?? exp.matchers.length;
  const ok = exp.matchers.length - failed.length;
  if (ok >= need) return { passed: true, reason: 'ok' };
  return { passed: false, reason: `missing ${failed.map(describe).join('; ')}` };
}
