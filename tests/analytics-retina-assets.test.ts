import { describe, expect, test } from 'bun:test';
import { REDACTED, containsPii, redactString, scrubUrl, scrubValue } from '../src/lib/analytics/pii';

describe('retina asset names are not emails', () => {
  test('a scale suffix with an image extension is kept', () => {
    for (const name of ['image@2x.png', 'logo@3x.webp', 'hero@2x.JPG', 'photo@1x.jpeg', 'badge@2x.avif', 'anim@2x.gif']) {
      expect(redactString(name)).toBe(name);
      expect(containsPii(name)).toBe(false);
    }
    expect(scrubUrl('/assets/icon@2x.svg?v=1')).toBe('/assets/icon@2x.svg?v=1');
    expect(scrubUrl('https://zuey.me/_astro/logo@3x.webp')).toBe('https://zuey.me/_astro/logo@3x.webp');
    expect(scrubUrl('/assets/icon%402x.svg')).toBe('/assets/icon%402x.svg');
    expect(scrubValue({ $elements: [{ tag_name: 'img', attr__src: '/img/avatar@2x.png' }] }))
      .toEqual({ $elements: [{ tag_name: 'img', attr__src: '/img/avatar@2x.png' }] });
  });

  test('real emails stay redacted, including domains that start with a digit', () => {
    expect(redactString('a@2x.example.com')).toBe(REDACTED);
    expect(redactString('write to jane@3m.com')).toBe(`write to ${REDACTED}`);
    expect(redactString('image@2x.png.example.com')).toBe(REDACTED);
    expect(redactString('jane@2x.pngs')).toBe(REDACTED);
    expect(containsPii('a@2x.example.com')).toBe(true);
    expect(containsPii('a%402x.example.com')).toBe(true);
    expect(scrubUrl('/u?to=jane%402x.example.com')).toBe(`/u?to=${REDACTED}`);
  });

  test('an asset name next to an email does not hide the email', () => {
    expect(redactString('icon@2x.png sent by jane@example.com')).toBe(`icon@2x.png sent by ${REDACTED}`);
  });
});
