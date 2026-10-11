import { describe, expect, test } from 'bun:test';
import { postHogInitOptions, scrubCaptureResult } from '../src/lib/analytics/destinations/posthog';
import { MAX_SCRUB_LENGTH, REDACTED, containsPii, redactString, scrubUrl, scrubValue } from '../src/lib/analytics/pii';

const EMAIL = 'jane.doe@example.com';
const LOCAL = 'jane.doe';

/** True when no form of the test email (literal or any percent-encoding) survives in the output. */
function leaksEmail(value: string): boolean {
  let decoded = value;
  for (let i = 0; i < 4; i++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  return decoded.includes(EMAIL) || decoded.includes(LOCAL) || value.toLowerCase().includes('example.com');
}

describe('percent-encoded emails', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['%40', 'https://www.google.com/search?q=zuey+jane.doe%40example.com'],
    ['lower-case hex', 'https://www.google.com/search?q=jane.doe%40example.com&hl=vi'],
    ['double-encoded %2540', 'https://ref.example.org/out?u=https%3A%2F%2Fzuey.me%2F%3Fq%3Djane.doe%2540example.com'],
    ['mixed-case hex', 'https://ref.example.org/?q=jane%2edoe%2540example%2Ecom'],
    ['+ separator', 'https://www.bing.com/search?q=contact+jane.doe%40example.com+now'],
    ['%20 separator', 'https://duckduckgo.com/?q=contact%20jane.doe%40example.com%20now'],
    ['encoded dot', 'https://ref.example.org/?q=jane%2Edoe%40example%2Ecom'],
    ['in the path', 'https://ref.example.org/u/jane.doe%40example.com/profile'],
    ['in the fragment', 'https://ref.example.org/page#jane.doe%40example.com'],
  ];

  for (const [name, url] of cases) {
    test(`scrubUrl redacts an email encoded with ${name}`, () => {
      const out = scrubUrl(url);
      expect(leaksEmail(out)).toBe(false);
      expect(out).toContain(REDACTED);
    });
  }

  test('a root-relative $pathname with an encoded email is redacted', () => {
    expect(leaksEmail(scrubUrl('/u/jane.doe%2540example.com'))).toBe(false);
  });

  test('free text with an encoded email is redacted', () => {
    const out = redactString('mailto:jane.doe%40example.com clicked');
    expect(leaksEmail(out)).toBe(false);
    expect(out).toContain('clicked');
  });

  test('an email re-encoded by URLSearchParams after a sensitive param is removed is still redacted', () => {
    const out = scrubUrl('https://zuey.me/pricing?token=abc&q=jane.doe@example.com');
    expect(out).not.toContain('token');
    expect(leaksEmail(out)).toBe(false);
  });

  test('non-PII parameters and words around the email are kept', () => {
    const out = scrubUrl('https://duckduckgo.com/?q=contact%20jane.doe%40example.com%20now&ia=web&kl=vn-vi');
    expect(out).toContain('ia=web');
    expect(out).toContain('kl=vn-vi');
    expect(out).toContain('contact');
    expect(out).toContain('now');
    expect(leaksEmail(out)).toBe(false);
  });

  test('URLs without emails are unchanged', () => {
    const urls = [
      'https://zuey.me/articles/hello?utm_source=x&utm_medium=y',
      'https://www.google.com/search?q=zuey+me+review&hl=vi',
      'https://zuey.me/search?q=100%25%20free%2Bcourse',
      'https://zuey.me/vi/b%C3%A0i-vi%E1%BA%BFt?q=c%C3%A1ch%20h%E1%BB%8Dc',
    ];
    for (const url of urls) expect(scrubUrl(url)).toBe(new URL(url).toString());
  });

  test('malformed escapes never throw and do not hide an email', () => {
    expect(() => scrubUrl('https://zuey.me/?q=%E0%A4%A%zz%')).not.toThrow();
    expect(scrubUrl('https://zuey.me/?q=%E0%A4%A%zz%')).toContain('%zz');
    const out = scrubUrl('https://ref.example.org/?q=%E0%%ZZjane.doe%40example.com%');
    expect(leaksEmail(out)).toBe(false);
    expect(() => redactString('%%%40%4')).not.toThrow();
  });

  test('containsPii detects encoded emails', () => {
    expect(containsPii('jane.doe%40example.com')).toBe(true);
    expect(containsPii('jane.doe%2540example.com')).toBe(true);
    expect(containsPii('100%25 free')).toBe(false);
  });

  test('scrubValue redacts nested encoded emails', () => {
    const out = scrubValue({ $initial_person_info: { r: 'https://www.google.com/search?q=jane.doe%40example.com', u: 'https://zuey.me/' } });
    expect(leaksEmail(JSON.stringify(out))).toBe(false);
  });
});

describe('long inputs', () => {
  const MB = 1024 * 1024;

  function timed<T>(run: () => T): [T, number] {
    const start = performance.now();
    const out = run();
    return [out, performance.now() - start];
  }

  test('a 1 MB URL is scrubbed in under 50 ms and the email inside it is redacted', () => {
    const url = `https://www.google.com/search?q=jane.doe%40example.com&x=${'a%40aaaa'.repeat(MB / 8)}`;
    const [out, ms] = timed(() => scrubValue({ $referrer: url }));
    expect(ms).toBeLessThan(50);
    const text = JSON.stringify(out);
    expect(leaksEmail(text)).toBe(false);
    expect(text).toContain(REDACTED);
    expect(text.length).toBeLessThanOrEqual(MAX_SCRUB_LENGTH + 100);
  });

  test('1 MB of free text with a literal email is scrubbed in under 50 ms', () => {
    const value = `contact ${EMAIL} ${'a'.repeat(MB)}`;
    const [out, ms] = timed(() => redactString(value));
    expect(ms).toBeLessThan(50);
    expect(leaksEmail(out)).toBe(false);
    expect(out.startsWith(`contact ${REDACTED} `)).toBe(true);
  });

  test('a cut never leaves part of an email, encoded email or token behind', () => {
    const pad = 'x'.repeat(MAX_SCRUB_LENGTH - 10);
    for (const tail of [EMAIL, 'jane.doe%40example.com', 'zm_abcdefghijklmnopqrstuvwxyz']) {
      const out = redactString(`${pad} ${tail}`);
      expect(out.endsWith(` ${REDACTED}`)).toBe(true);
      expect(out).not.toContain('jane');
      expect(out).not.toContain('zm_');
    }
  });

  test('values up to the cap are kept whole', () => {
    const value = 'a'.repeat(MAX_SCRUB_LENGTH);
    expect(redactString(value)).toBe(value);
  });

  test('containsPii treats a value too long to inspect as PII', () => {
    expect(containsPii('a'.repeat(MAX_SCRUB_LENGTH + 1))).toBe(true);
  });
});

describe('PostHog before_send with encoded emails', () => {
  const referrer = 'https://www.google.com/search?q=zuey+jane.doe%40example.com';
  const current = 'https://zuey.me/?ref=jane.doe%2540example.com&utm_source=newsletter';

  test('scrubCaptureResult scrubs every referrer and URL property PostHog sets itself', () => {
    const out = scrubCaptureResult({
      event: '$pageview',
      properties: {
        $current_url: current,
        $pathname: '/',
        $referrer: referrer,
        $referring_domain: 'www.google.com',
        $session_entry_referrer: referrer,
        $session_entry_url: current,
        $session_entry_referring_domain: 'www.google.com',
        $initial_person_info: { r: referrer, u: current },
        utm_source: 'newsletter',
      },
      $set: { $current_url: current, $referrer: referrer },
      $set_once: { $initial_referrer: referrer, $initial_current_url: current, $initial_referring_domain: 'www.google.com' },
    });
    expect(out).not.toBeNull();
    const props: Record<string, unknown> = out?.properties ?? {};
    for (const key of ['$referrer', '$session_entry_referrer', '$current_url', '$session_entry_url']) {
      const value = props[key];
      expect(typeof value).toBe('string');
      expect(leaksEmail(String(value))).toBe(false);
      expect(String(value)).toContain(REDACTED);
    }
    expect(String(props.$current_url)).toContain('utm_source=newsletter');
    expect(props.$referring_domain).toBe('www.google.com');
    expect(leaksEmail(JSON.stringify(out))).toBe(false);
  });

  test('the init options wire scrubCaptureResult as before_send', () => {
    const options = postHogInitOptions({ key: 'phc_testtesttesttesttesttest', host: 'https://us.i.posthog.com', debug: false }, '/');
    const beforeSend = options.before_send;
    expect(beforeSend).toBe(scrubCaptureResult);
  });
});
