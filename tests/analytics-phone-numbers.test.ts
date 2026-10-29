import { describe, expect, spyOn, test } from 'bun:test';
import { MAX_SCRUB_LENGTH, REDACTED, containsPii, looksLikePhone, redactString, scrubUrl, scrubValue } from '../src/lib/analytics/pii';
import { scrubCaptureResult } from '../src/lib/analytics/destinations/posthog';
import { SMOKE_CEILING_MS, elapsedMs, regexRuns } from './helpers/work-bound';

describe('phone numbers are redacted', () => {
  test('Vietnamese mobile and landline numbers, with or without separators', () => {
    for (const phone of [
      '0901234567', '0381234567', '0561234567', '0771234567', '0861234567',
      '0901 234 567', '090 123 4567', '0901.234.567', '0901-234-567', '0901 234-567',
      '02838221234', '028 3822 1234', '(028) 3822 1234', '(028)38221234', '0243.822.1234',
    ]) {
      expect(redactString(`Gọi ${phone} nhé`)).toBe(`Gọi ${REDACTED} nhé`);
      expect(containsPii(phone)).toBe(true);
    }
  });

  test('+84 and other E.164 numbers', () => {
    for (const phone of [
      '+84901234567', '+84 90 123 4567', '+84 901 234 567', '+84-901-234-567', '+84.901.234.567',
      '+14155552671', '+1 415 555 2671', '+1 (415) 555-2671', '+442071838750', '+44 20 7183 8750', '+6591234567',
    ]) {
      expect(redactString(`tel ${phone}.`)).toBe(`tel ${REDACTED}.`);
      expect(containsPii(phone)).toBe(true);
    }
  });

  test('North American numbers written in three groups', () => {
    for (const phone of ['(415) 555-2671', '(415) 555 2671', '415-555-2671', '415.555.2671', '415 - 555 - 2671']) {
      expect(redactString(`call ${phone} now`)).toBe(`call ${REDACTED} now`);
    }
  });

  test('every number in a list is found, and the text around them is kept', () => {
    expect(redactString('0901234567 0912345678')).toBe(`${REDACTED} ${REDACTED}`);
    expect(redactString('0901 234 567 028 3822 1234')).toBe(`${REDACTED} ${REDACTED}`);
    expect(redactString('Liên hệ: 0901234567, (028) 3822 1234 hoặc +84 90 123 4567!'))
      .toBe(`Liên hệ: ${REDACTED}, ${REDACTED} hoặc ${REDACTED}!`);
    expect(redactString('Error: invalid phone "0901234567" at step 2')).toBe(`Error: invalid phone "${REDACTED}" at step 2`);
    expect(redactString('2026-10-23 0901234567')).toBe(`2026-10-23 ${REDACTED}`);
  });

  test('phone numbers in URLs, query strings and autocapture attributes', () => {
    expect(scrubUrl('https://zuey.me/booking-help?phone=0901234567&lang=vi')).toBe(`https://zuey.me/booking-help?phone=${REDACTED}&lang=vi`);
    expect(scrubUrl('https://example.com/u/0901234567')).toBe(`https://example.com/u/${REDACTED}`);
    expect(redactString('tel:+84901234567')).toBe(`tel:${REDACTED}`);
    expect(scrubValue({ $elements: [{ tag_name: 'a', attr__href: 'tel:0901-234-567', $el_text: 'Hotline 0901 234 567' }] }))
      .toEqual({ $elements: [{ tag_name: 'a', attr__href: `tel:${REDACTED}`, $el_text: `Hotline ${REDACTED}` }] });
    expect(redactString('a:href="tel:0901234567"nth-child="1"')).toBe(`a:href="tel:${REDACTED}"nth-child="1"`);
  });

  test('percent-encoded and plus-as-space forms', () => {
    expect(scrubUrl('https://example.com/c?to=%2B84901234567')).toBe(`https://example.com/c?to=${REDACTED}`);
    expect(scrubUrl('https://example.com/c?to=%2B84%20901%20234%20567&x=1')).toBe(`https://example.com/c?to=${REDACTED}&x=1`);
    expect(scrubUrl('https://example.com/c?to=call%200901234567')).toBe(`https://example.com/c?to=call%20${REDACTED}`);
    expect(scrubUrl('https://example.com/c?to=%252B84901234567')).toBe(`https://example.com/c?to=${REDACTED}`);
    expect(scrubUrl('https://example.com/c?msg=call+0901234567')).toBe(`https://example.com/c?msg=call+${REDACTED}`);
    expect(looksLikePhone('%2B84%20901%20234%20567')).toBe(true);
    expect(containsPii('call%200901234567')).toBe(true);
  });

  test('exception messages lose phone numbers before they are shortened', () => {
    const out = scrubCaptureResult({
      event: '$exception',
      properties: { $current_url: 'https://zuey.me/', $exception_list: [{ type: 'Error', value: 'Bad input 0901 234 567' }] },
    });
    expect(out?.properties?.$exception_list).toEqual([{ type: 'Error', value: `Bad input ${REDACTED}` }]);
  });
});

describe('less common phone formats are redacted', () => {
  test('84 country code without +, as wa.me links write it', () => {
    expect(redactString('84901234567')).toBe(REDACTED);
    expect(redactString('Zalo 842838221234 nhé')).toBe(`Zalo ${REDACTED} nhé`);
    expect(scrubUrl('https://wa.me/84901234567')).toBe(`https://wa.me/${REDACTED}`);
    expect(scrubUrl('https://api.whatsapp.com/send?phone=84901234567&text=hi')).toBe(`https://api.whatsapp.com/send?phone=${REDACTED}&text=hi`);
  });

  test('a (0) trunk prefix after the country code', () => {
    expect(redactString('Gọi +84 (0) 90 123 4567 nhé')).toBe(`Gọi ${REDACTED} nhé`);
    expect(redactString('+44 (0)20 7183 8750')).toBe(REDACTED);
  });

  test('no-break spaces and spaced dashes between groups', () => {
    for (const phone of ['0901\u00a0234\u00a0567', '+84\u202f90\u202f123\u202f4567', '0901 - 234 - 567', '028 - 3822 - 1234', '0901 .234. 567']) {
      expect(redactString(`Gọi ${phone} nhé`)).toBe(`Gọi ${REDACTED} nhé`);
      expect(containsPii(phone)).toBe(true);
    }
  });

  test('in a raw URL query a + glued to a word is a space: the number after it is still found, the + is kept', () => {
    expect(scrubUrl('https://www.google.com/search?q=zuey+0901234567')).toBe(`https://www.google.com/search?q=zuey+${REDACTED}`);
    expect(scrubUrl('https://www.google.com/search?q=zuey+84901234567')).toBe(`https://www.google.com/search?q=zuey+${REDACTED}`);
    expect(scrubUrl('https://www.google.com/search?q=zuey+123456789')).toBe('https://www.google.com/search?q=zuey+123456789');
    expect(scrubUrl('https://zuey.me/?ref=a#x=zuey+123456789')).toBe('https://zuey.me/?ref=a#x=zuey+123456789');
    expect(redactString('tel:+84901234567 and to=+84901234567')).toBe(`tel:${REDACTED} and to=${REDACTED}`);
  });
});

describe('a plus outside a raw URL query is a real plus', () => {
  test('free text: a + glued to a word still prefixes a phone number', () => {
    expect(redactString('call+442071838750')).toBe(`call${REDACTED}`);
    expect(redactString('SĐT+84 90 123 4567 nhé')).toBe(`SĐT${REDACTED} nhé`);
    expect(redactString('zuey+123456789')).toBe(`zuey${REDACTED}`);
    expect(containsPii('call+442071838750')).toBe(true);
    expect(scrubValue({ $el_text: 'SĐT+84 90 123 4567' })).toEqual({ $el_text: `SĐT${REDACTED}` });
  });

  test('URL paths and decoded %2B keep the plus as a country-code prefix', () => {
    expect(scrubUrl('https://zuey.me/?msg=Call%2B442071838750')).toBe(`https://zuey.me/?msg=Call${REDACTED}`);
    expect(scrubUrl('https://example.com/u/call+442071838750')).toBe(`https://example.com/u/call${REDACTED}`);
  });

  test('a decoded plus is redacted with its number or escaped again, a raw + stays a space', () => {
    expect(scrubUrl('https://example.com/?a=x%2B84901234567')).toBe(`https://example.com/?a=x${REDACTED}`);
    expect(scrubUrl('https://example.com/?a=hi+x%2B84901234567')).toBe(`https://example.com/?a=hi+x${REDACTED}`);
    expect(scrubUrl('https://example.com/?a=C%2B%2B+call%200901234567')).toBe(`https://example.com/?a=C%2B%2B+call%20${REDACTED}`);
    expect(scrubUrl('https://example.com/?a=zuey+0901%20234%20567')).toBe(`https://example.com/?a=zuey+${REDACTED}`);
  });
});

describe('numbers that are not phone numbers are kept', () => {
  const kept = [
    // Order codes, booking codes, ids and hashes
    'ZMC12345678', 'ZMC-0901234567', 'order_0901234567', 'cor_0901234567abc', 'guest_0901234567',
    '0192f3a1-7c2e-7abc-9def-0123456789ab', '01234567-0123-4567-8901-234567890123', 'usr_01HZX0901234567',
    'a3f90901234567be', 'sha256:0901234567deadbeef', 'commit 9f0901234 merged', 'deadbeef0901234567',
    // Timestamps, dates and times
    '1729660000', '1729660000000', '1729660000.123', '20261023093000', '2026-10-23', '2026-10-23T09:30:00+07:00',
    '2026-10-23 09:30:00', '2026-10-23 12:30:45.123', '23/10/2026', '23.10.2026', '23-10-2026 14:05', 'Thu Oct 23 2026 09:30:00 GMT+0700',
    '+07:00', '+0700', 'UTC+7',
    // Revisions, versions, builds and IP addresses
    'rev 1234', 'revision 12345678', 'r0901234567', '#1234', 'PR #252', 'v2.10.3', '1.0.0-beta.12', '4.2.1',
    'build 20261023.1', 'v0901.234.567', '192.168.100.200', '10.0.0.1', '2001:db8::1', 'node 22.11.0',
    // Prices and counts
    '1.290.000 ₫', '1.290.000đ', '99.000đ', '12.900.000 VND', '1 290 000 VND', '129 000 000', '$1,234.56', '0 đ',
    '+1500000', '+12345678', '-0901234567x', '100%', '3.14159265358979',
    // File names and paths
    '/img/0901234567.png', 'photo_0901234567.jpg', 'IMG-0901234567-WA0001.jpg', '/courses/ai-101/lessons/0123456789',
    // Short or odd digit runs
    '0123456789', '0 1 2 3 4 5 6 7 8 9', '0 3 5 7 9 1 2 3 4 5', '123-456-7890', '1234567890', '415-555-26710',
    '012345678901234567', '0901234567890', '849012345678', '8490123456',
    // Plain-space triples shaped like North American numbers: sizes, dimensions, SVG path data
    '256 384 1024', '300 250 1920', '415 555 2671', '<path d="M 256 384 1024 768 L 300 250 1920 1080"/>',
    // `84` without `+` only counts as one group (`wa.me/84…`); spaced, it reads like an amount
    '84 901 234 567',
    // A plus glued to a word, with too few digits after it for a phone number
    'size+1500000',
  ];

  test('redactString keeps each value unchanged', () => {
    for (const value of kept) expect(redactString(value)).toBe(value);
  });

  test('containsPii does not flag them', () => {
    for (const value of kept) expect(containsPii(value)).toBe(false);
  });

  test('URLs with timestamps, versions and ids keep their numbers', () => {
    for (const url of [
      'https://zuey.me/articles?page=2&t=1729660000000',
      'https://zuey.me/_astro/client.0901234567.js?v=20261023',
      'https://cdn.example.com/lib@4.2.1/dist/app.min.js',
      'https://zuey.me/courses/orders/:code',
    ]) {
      expect(scrubUrl(url)).toBe(url);
    }
  });
});

describe('phone scan stays linear', () => {
  const shapes: Array<[string, string]> = [
    ['digits and spaces', '1 '],
    ['two-digit groups', '12 '],
    ['dotted groups', '12.'],
    ['VN prefix groups', '090 '],
    ['parenthesised', '(0) '],
    ['plus runs', '+1 '],
    ['glued joiners', 'a-0901234567-'],
    ['long digit run', '9'],
    ['mixed separators', '0901-234.567 '],
    ['encoded', '%2B84%20'],
  ];

  const adversarial = shapes.map(([name, unit]): [string, string] => [name, unit.repeat(Math.ceil(MAX_SCRUB_LENGTH / unit.length)).slice(0, MAX_SCRUB_LENGTH)]);
  const scan = (value: string) => () => {
    redactString(value);
    containsPii(value);
  };

  test('16 KB adversarial strings cost a bounded number of regex runs per character', () => {
    // The work bound: about 7 runs per character for the worst shape. A window of digit groups that is not
    // capped at 15 digits, or a scan that restarts per group, costs hundreds per character on these inputs.
    for (const [name, value] of adversarial) {
      const bound = 16 * value.length;
      const runs = regexRuns(scan(value), bound);
      expect({ name, runs, withinBound: runs <= bound }).toEqual({ name, runs, withinBound: true });
    }
  });

  test('16 KB adversarial strings are scanned well inside the smoke ceiling', () => {
    // Ten scans of each shape: a few to 60 ms when linear, seconds for a regex that backtracks over a run.
    for (const [name, value] of adversarial) {
      const ms = elapsedMs(scan(value), 10);
      expect({ name, ms, fast: ms < SMOKE_CEILING_MS }).toEqual({ name, ms, fast: true });
    }
  });

  test('a crafted URL copied into 12 properties of one event is scrubbed once', () => {
    const crafted = `https://zuey.me/?x=${'%2B84%20'.repeat(2000).slice(0, MAX_SCRUB_LENGTH - 40)}%2B84901234567`;
    const keys = [
      '$current_url', '$referrer', '$session_entry_url', '$session_entry_referrer', '$initial_current_url', '$initial_referrer',
      'href', 'page', 'link', 'source', 'target', 'origin',
    ];
    const event = (copies: number) => ({
      event: '$pageview',
      properties: Object.fromEntries(keys.slice(0, copies).map(key => [key, crafted])),
      $set: { $current_url: crafted },
      $set_once: { $initial_current_url: crafted },
    });
    // Work bound: the whole event costs the percent-decoding passes of scrubbing the crafted URL once.
    const decodes = spyOn(globalThis, 'decodeURIComponent');
    try {
      scrubUrl(crafted);
      const once = decodes.mock.calls.length;
      expect(once).toBeGreaterThan(0);
      decodes.mockClear();
      const started = performance.now();
      const out = scrubCaptureResult(event(keys.length));
      const elapsed = performance.now() - started;
      expect(decodes.mock.calls.length).toBe(once);
      expect(elapsed).toBeLessThan(1000);
      const props = out?.properties ?? {};
      const values = new Set(keys.map(key => props[key]));
      expect(values.size).toBe(1);
      expect(String(props.$current_url)).not.toContain('901234567');
      expect(String(out?.$set?.$current_url)).toBe(String(props.$current_url));
    } finally {
      decodes.mockRestore();
    }
  });
});
