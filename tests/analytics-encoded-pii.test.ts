import { describe, expect, spyOn, test } from 'bun:test';
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
      'https://zuey.me/search?topic=100%25%20free%2Bcourse',
      'https://zuey.me/vi/b%C3%A0i-vi%E1%BA%BFt?topic=c%C3%A1ch%20h%E1%BB%8Dc',
    ];
    for (const url of urls) expect(scrubUrl(url)).toBe(new URL(url).toString());
  });

  test('malformed escapes never throw and do not hide an email', () => {
    expect(() => scrubUrl('https://ref.example.org/?q=%E0%A4%A%zz%')).not.toThrow();
    expect(scrubUrl('https://ref.example.org/?q=%E0%A4%A%zz%')).toContain('%zz');
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

describe('scrubber accuracy', () => {
  test('emails with a Unicode (IDN) domain are redacted, plain or encoded', () => {
    expect(redactString('write to user@bücher.example today')).toBe(`write to ${REDACTED} today`);
    expect(containsPii('user@bücher.example')).toBe(true);
    const out = scrubUrl('https://ref.example.org/?q=user%40b%C3%BCcher.example&hl=de');
    expect(out).toBe(`https://ref.example.org/?q=${REDACTED}&hl=de`);
    expect(containsPii('user%40b%C3%BCcher.example')).toBe(true);
    expect(redactString('liên hệ ngọc@trường.việt nhé')).toBe(`liên hệ ${REDACTED} nhé`);
  });

  test('deeper encoding is decoded until stable', () => {
    for (const at of ['%25252540', '%2525252540']) {
      const out = scrubUrl(`https://ref.example.org/?q=jane.doe${at}example.com&hl=vi`);
      expect(leaksEmail(out)).toBe(false);
      expect(out).toContain('hl=vi');
      expect(containsPii(`jane.doe${at}example.com`)).toBe(true);
    }
  });

  test('a value still encoded after the decoding limit is redacted', () => {
    const deep = `jane.doe%${'25'.repeat(12)}40example.com`;
    expect(scrubUrl(`https://ref.example.org/?q=${deep}&hl=vi`)).toBe(`https://ref.example.org/?q=${REDACTED}&hl=vi`);
    expect(containsPii(deep)).toBe(true);
    expect(containsPii('100%25 free')).toBe(false);
  });

  test('redaction keeps encoded Vietnamese text and mailto: intact', () => {
    expect(scrubUrl('https://www.google.com/search?q=h%E1%BB%8Dc%20jane.doe%40example.com&hl=vi'))
      .toBe(`https://www.google.com/search?q=h%E1%BB%8Dc%20${REDACTED}&hl=vi`);
    expect(redactString('mailto:jane.doe%40example.com clicked')).toBe(`mailto:${REDACTED} clicked`);
    expect(redactString('học:jane.doe%40example.com')).toBe(`học:${REDACTED}`);
  });

  test('objects nested deeper than the limit are redacted, not passed through', () => {
    let nested: unknown = { email: EMAIL, url: 'https://x.org/?q=jane.doe%40example.com' };
    for (let i = 0; i < 10; i++) nested = { child: nested };
    const out = JSON.stringify(scrubValue({ root: nested }));
    expect(leaksEmail(out)).toBe(false);
    expect(out).toContain(REDACTED);
    expect(scrubValue({ a: { b: { c: 1, d: true, e: null } } })).toEqual({ a: { b: { c: 1, d: true, e: null } } });
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

  test('a 16 KB run of eyJ just under the cap is scrubbed in linear time', () => {
    const run = 'eyJ'.repeat(Math.floor((MAX_SCRUB_LENGTH - 40) / 3));
    const [out, ms] = timed(() => scrubValue({ a: `https://zuey.me/?x=${run}`, b: run, c: `${run}.abcd` }));
    expect(ms).toBeLessThan(20);
    expect(JSON.stringify(out)).toContain(run);
    const [jwt, jwtMs] = timed(() => redactString(`${run}.abcd.efgh`));
    expect(jwtMs).toBeLessThan(10);
    expect(jwt).toBe(REDACTED);
  });

  test('16 KB of non-ASCII text around @ is scanned in linear time', () => {
    const shapes = [`${'ọ.'.repeat(8000)}@`, 'ü@ü.'.repeat(4000), `@${'ọ.'.repeat(126)}`.repeat(64)];
    for (const value of shapes) {
      const [, ms] = timed(() => scrubValue({ v: value }));
      expect(ms).toBeLessThan(20);
    }
    expect(redactString(`${'ọ'.repeat(100)}@bücher.example`)).toBe(`${'ọ'.repeat(36)}${REDACTED}`);
    expect(redactString('see \u{1D4B6}bc@example.com')).toBe(`see ${REDACTED}`);
    expect(redactString('a@b@c.example x@y')).toBe(`a@${REDACTED} x@y`);
  });

  test('JWTs are still redacted when glued to other text or encoded spaces', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdEFGH_ijk-lmn';
    expect(redactString(`Bearer%20${jwt}`)).toBe(`Bearer%20${REDACTED}`);
    expect(redactString(`x${jwt} y`)).toBe(`x${REDACTED} y`);
    expect(redactString(`a.b.${jwt}.tail`)).toBe(`a.b.${REDACTED}.tail`);
    expect(redactString('eyJabc.defg.hijk')).toBe('eyJabc.defg.hijk');
    expect(redactString('eyJabcd.def.hijk')).toBe('eyJabcd.def.hijk');
    expect(containsPii(`?t=${jwt}`)).toBe(true);
    expect(containsPii('eyJ only')).toBe(false);
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

  test('a 16 KB URL with thousands of sensitive parameter names is scrubbed in one pass', () => {
    const pairs = Array.from({ length: 2000 }, (_, i) => (i % 10 === 0 ? `k${i}=y` : `token${i.toString(36)}`)).join('&');
    const query = pairs.slice(0, pairs.lastIndexOf('&', 15_000));
    const hash = 'access_token=x&tab=1';
    const url = `https://zuey.me/articles?${query}#${hash}`;
    expect(url.length).toBeLessThanOrEqual(MAX_SCRUB_LENGTH);
    expect((query.match(/token/g) ?? []).length).toBeGreaterThan(1500);
    // Removing names one at a time re-serialises the whole query per name (quadratic). The work bound: the
    // number of URLSearchParams mutations stays constant however many sensitive names the URL carries.
    const spies = (['delete', 'set', 'append', 'sort'] as const).map(method => spyOn(URLSearchParams.prototype, method));
    let out = '';
    let ms = 0;
    let mutations = 0;
    try {
      const start = performance.now();
      out = scrubUrl(url);
      ms = performance.now() - start;
      mutations = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(mutations).toBeLessThanOrEqual(2);
    expect(ms).toBeLessThan(1000);
    expect(out).not.toContain('token');
    const kept = (query.match(/k\d+=y/g) ?? []).join('&');
    expect(out).toBe(`https://zuey.me/articles?${kept}#tab=1`);
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

  test('autocapture $elements arrays (sent without remote config) are scrubbed', () => {
    const href = 'https://zuey.me/contact?q=jane.doe%40example.com&token=abc&utm_source=x';
    const out = scrubCaptureResult({
      event: '$autocapture',
      properties: {
        $event_type: 'click',
        $elements: [
          {
            tag_name: 'a',
            $el_text: `Mail ${EMAIL}`,
            attr__href: href,
            attr__class: 'btn primary',
            classes: ['btn', 'primary'],
            nth_child: 2,
            nth_of_type: 1,
            attributes: { attr__href: href, attr__title: `Write to ${EMAIL}` },
          },
          { tag_name: 'li', attr__class: 'item', nth_child: 1 },
        ],
      },
    });
    expect(out).not.toBeNull();
    expect(leaksEmail(JSON.stringify(out))).toBe(false);
    const elements = out?.properties?.$elements;
    expect(Array.isArray(elements)).toBe(true);
    const first: unknown = Array.isArray(elements) ? elements[0] : null;
    expect(first).toMatchObject({ tag_name: 'a', $el_text: `Mail ${REDACTED}`, classes: ['btn', 'primary'], nth_child: 2 });
    expect(JSON.stringify(first)).not.toContain('token');
    expect(JSON.stringify(first)).toContain('utm_source=x');
  });

  test('the init options disable the feature-flag request, which bypasses before_send', () => {
    const options = postHogInitOptions({ key: 'phc_testtesttesttesttesttest', host: 'https://us.i.posthog.com', debug: false }, '/');
    expect(options.advanced_disable_flags).toBe(true);
  });
});
