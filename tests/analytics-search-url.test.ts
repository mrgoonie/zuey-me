import { describe, expect, test } from 'bun:test';
import { scrubCaptureResult } from '../src/lib/analytics/destinations/posthog';
import { REDACTED, redactString, scrubUrl, scrubValue } from '../src/lib/analytics/pii';

const WORDS = ['jane', 'nguyen', 'học', 'h%E1%BB%8Dc', 'tr%E1%BA%A7m', 'c%E1%BA%A3m'];

function leaksWords(value: unknown): boolean {
  const text = JSON.stringify(value);
  return WORDS.some(word => text.includes(word)) || /[?&#]q=(?!%5Bredacted%5D|\[redacted\])/i.test(text);
}

describe('site search words never reach PostHog URLs', () => {
  test('scrubUrl drops q from zuey.me addresses, plain or encoded', () => {
    expect(scrubUrl('https://zuey.me/articles?lang=vi&q=jane+nguyen')).toBe('https://zuey.me/articles?lang=vi');
    expect(scrubUrl('https://www.zuey.me/articles?q=h%E1%BB%8Dc%20tr%E1%BA%A7m%20c%E1%BA%A3m&category=ai'))
      .toBe('https://www.zuey.me/articles?category=ai');
    expect(scrubUrl('/articles/page/2?q=h%E1%BB%8Dc&lang=en')).toBe('/articles/page/2?lang=en');
    expect(scrubUrl('https://zuey.me/articles?Q=jane&q=nguyen')).toBe('https://zuey.me/articles');
    expect(scrubUrl('https://zuey.me/#q=jane&tab=x')).toBe('https://zuey.me/#tab=x');
  });

  test("other sites' URLs keep their own query", () => {
    expect(scrubUrl('https://www.google.com/search?q=zuey+me&hl=vi')).toBe('https://www.google.com/search?q=zuey+me&hl=vi');
  });

  test('free text redacts the q value, whatever the host', () => {
    expect(redactString('a:href="/articles?lang=vi&q=jane%20nguyen"')).toBe(`a:href="/articles?lang=vi&q=${REDACTED}"`);
    expect(redactString('failed at https://zuey.me/articles?q=h%E1%BB%8Dc')).toBe(`failed at https://zuey.me/articles?q=${REDACTED}`);
  });

  test('every automatic URL property is scrubbed: pageview, referrer, $initial_*, autocapture', () => {
    const search = 'https://zuey.me/articles?lang=vi&q=jane%20nguyen%20h%E1%BB%8Dc';
    const out = scrubCaptureResult({
      properties: {
        $current_url: search,
        $session_entry_url: search,
        $referrer: search,
        $session_entry_referrer: search,
        $initial_current_url: search,
        $elements: [{ tag_name: 'a', attr__href: '/articles?lang=vi&q=jane+nguyen', $el_text: 'Browse all' }],
        $elements_chain: 'a:attr__href="/articles?lang=vi&q=jane+nguyen"nth-child="1"',
      },
      $set: { $referrer: search },
      $set_once: { $initial_referrer: search, $initial_current_url: search, $initial_person_info: { u: search, r: search } },
    });
    expect(out).not.toBeNull();
    expect(leaksWords(out)).toBe(false);
    expect(out?.properties?.$current_url).toBe('https://zuey.me/articles?lang=vi');
    expect(out?.properties?.$elements).toEqual([{ tag_name: 'a', attr__href: '/articles?lang=vi', $el_text: 'Browse all' }]);
  });

  test('the knowledge_search event and exception frames carry the page URL without the search words', () => {
    const search = 'https://zuey.me/articles?q=jane+nguyen';
    const event = scrubCaptureResult({ properties: { surface: 'articles', query_length: 11, results: 3, $current_url: search } });
    expect(event?.properties).toEqual({ surface: 'articles', query_length: 11, results: 3, $current_url: 'https://zuey.me/articles' });
    const frames = scrubValue({ $exception_list: [{ stacktrace: { frames: [{ filename: search, lineno: 1 }] } }] });
    expect(leaksWords(frames)).toBe(false);
  });
});
