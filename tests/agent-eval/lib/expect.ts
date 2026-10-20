import type { Expectation, Matcher, Page } from './types';

export interface Evidence {
  /** Concatenated readable text of everything the agent fetched. */
  text: string;
  /** Every link the agent saw (absolute URLs). */
  hrefs: string[];
}

export function evidenceFromPages(pages: Page[]): Evidence {
  return {
    text: pages.map((p) => p.text).join('\n'),
    hrefs: pages.flatMap((p) => p.links.map((l) => l.href)),
  };
}

const re = (src: string) => new RegExp(src, 'i');

export function matcherHolds(m: Matcher, ev: Evidence): boolean {
  if ('link' in m) return ev.hrefs.some((h) => re(m.link).test(h));
  if ('text' in m) return re(m.text).test(ev.text);
  return !re(m.notText).test(ev.text);
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
