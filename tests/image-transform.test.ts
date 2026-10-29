import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  fixedSizeImage, imageTransformsFor, isTransformableImage, responsiveImage, transformImageUrl,
} from '../src/lib/media/image-transform';
import { BlockRenderer, leadImageBlockId } from '../src/components/blocks/BlockRenderer';
import { validateDocument } from '../src/lib/blocks/validate';
import type { ArticleDocument } from '../src/lib/blocks/schema';

const MEDIA = 'https://media.zuey.me/articles/2026/10/cover.webp';
const ON = { base: '' };

describe('image transforms: when they apply', () => {
  test('on for the production host only, unless the flag says otherwise', () => {
    expect(imageTransformsFor('zuey.me')).toEqual({ base: '' });
    expect(imageTransformsFor('www.zuey.me')).toEqual({ base: '' });
    for (const host of ['localhost', '127.0.0.1', 'zuey-me.pages.dev', 'abc.zuey-me.pages.dev']) expect(imageTransformsFor(host)).toBeNull();
    expect(imageTransformsFor('zuey.me', 'off')).toBeNull();
    expect(imageTransformsFor('localhost', 'https://zuey.me/')).toEqual({ base: 'https://zuey.me' });
    expect(imageTransformsFor('localhost', 'yes')).toBeNull();
  });

  test('only zone images: media.zuey.me, cdn.zuey.me, zuey.me and site paths; never other hosts or SVG', () => {
    for (const url of [MEDIA, 'https://cdn.zuey.me/avatar.png', 'https://zuey.me/og.png', '/favicon.png']) expect(isTransformableImage(url)).toBe(true);
    for (const url of [
      'https://images.unsplash.com/photo.jpg', 'http://media.zuey.me/a.webp', '//evil.example/a.png',
      'https://media.zuey.me.evil.example/a.png', 'https://media.zuey.me/logo.svg', '/cdn-cgi/image/width=80/a.png', 'not a url',
    ]) expect(isTransformableImage(url)).toBe(false);
  });
});

describe('image transforms: URLs', () => {
  test('builds /cdn-cgi/image options with quality and format=auto', () => {
    expect(transformImageUrl(MEDIA, { width: 640 }, ON)).toBe(`/cdn-cgi/image/width=640,quality=80,format=auto/${MEDIA}`);
    expect(transformImageUrl('/favicon.png', { width: 64, quality: 60 }, { base: 'https://zuey.me' }))
      .toBe('https://zuey.me/cdn-cgi/image/width=64,quality=60,format=auto/favicon.png');
    expect(transformImageUrl(MEDIA, { width: 80, height: 92, fit: 'cover' }, ON))
      .toBe(`/cdn-cgi/image/width=80,height=92,fit=cover,quality=80,format=auto/${MEDIA}`);
    expect(transformImageUrl('https://cdn.zuey.me/avatar.png', { width: 256, height: 256, fit: 'cover', onerror: 'redirect' }, ON))
      .toBe('/cdn-cgi/image/width=256,height=256,fit=cover,quality=80,format=auto,onerror=redirect/https://cdn.zuey.me/avatar.png');
  });

  test('other hosts and disabled transforms pass through unchanged', () => {
    const other = 'https://images.unsplash.com/photo.jpg';
    expect(transformImageUrl(other, { width: 640 }, ON)).toBe(other);
    expect(transformImageUrl(MEDIA, { width: 640 }, null)).toBe(MEDIA);
    expect(responsiveImage(other, 2000, '100vw', ON)).toEqual({ src: other });
    expect(responsiveImage(MEDIA, 2000, '100vw', null)).toEqual({ src: MEDIA });
    expect(fixedSizeImage(MEDIA, 80, 92, undefined)).toEqual({ src: MEDIA });
  });

  test('srcset widths stop at the image width and never upscale', () => {
    const wide = responsiveImage(MEDIA, 1672, '100vw', ON);
    expect(wide.srcSet?.split(', ').map(c => c.split(' ')[1])).toEqual(['480w', '768w', '1080w', '1440w']);
    expect(wide.src).toBe(transformImageUrl(MEDIA, { width: 1080 }, ON));
    expect(wide.sizes).toBe('100vw');
    const small = responsiveImage(MEDIA, 600, '100vw', ON);
    expect(small.srcSet?.split(', ').map(c => c.split(' ')[1])).toEqual(['480w', '600w']);
    const unknown = responsiveImage(MEDIA, undefined, '100vw', ON);
    expect(unknown.srcSet?.split(', ')).toHaveLength(4);
  });

  test('thumbnails are cropped to the box at 1x and 2x', () => {
    const thumb = fixedSizeImage(MEDIA, 80, 92, ON);
    expect(thumb.src).toBe(transformImageUrl(MEDIA, { width: 80, height: 92, fit: 'cover' }, ON));
    expect(thumb.srcSet).toBe(`${thumb.src} 1x, ${transformImageUrl(MEDIA, { width: 160, height: 184, fit: 'cover' }, ON)} 2x`);
  });
});

const img = (id: string) => ({ id, type: 'image', url: `https://media.zuey.me/${id}.webp`, alt: id, width: 1600, height: 900 });
const para = (id: string) => ({ id, type: 'paragraph', text: id });
function doc(blocks: unknown[]): ArticleDocument {
  const checked = validateDocument({ version: 1, blocks });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.doc;
}

describe('article lead image', () => {
  test('the first image, or a gallery\'s first image, within the first three top-level blocks', () => {
    expect(leadImageBlockId(doc([para('p1'), img('i1'), img('i2')]).blocks)).toBe('i1');
    const gallery = { id: 'g1', type: 'gallery', images: [{ url: MEDIA, alt: 'a' }, { url: MEDIA, alt: 'b' }] };
    expect(leadImageBlockId(doc([gallery, img('i1')]).blocks)).toBe('g1');
    expect(leadImageBlockId(doc([para('p1'), para('p2'), para('p3'), img('i1')]).blocks)).toBeUndefined();
  });

  test('images inside a toggle are never the lead image; sections count', () => {
    const toggle = { id: 't1', type: 'toggle', summary: 'more', blocks: [img('hidden')] };
    expect(leadImageBlockId(doc([toggle, para('p1')]).blocks)).toBeUndefined();
    const section = { id: 's1', type: 'section', width: 'prose', blocks: [img('inside')] };
    expect(leadImageBlockId(doc([section]).blocks)).toBe('inside');
  });

  test('the article page renders a resized, high-priority lead image; fragments keep originals', () => {
    const d = doc([img('i1'), img('i2')]);
    const page = renderToStaticMarkup(createElement(BlockRenderer, { doc: d, eagerLeadImage: true, imageTransforms: ON }));
    expect(page).toContain('srcSet="/cdn-cgi/image/width=480,quality=80,format=auto/https://media.zuey.me/i1.webp 480w');
    expect(page).toMatch(/<img src="\/cdn-cgi\/image\/[^"]+i1\.webp"[^>]*fetchPriority="high"/i);
    expect(page).toMatch(/<img src="\/cdn-cgi\/image\/[^"]+i2\.webp"[^>]*loading="lazy"/);
    const fragment = renderToStaticMarkup(createElement(BlockRenderer, { doc: d }));
    expect(fragment).not.toContain('cdn-cgi');
    expect(fragment).not.toContain('srcSet');
    expect(fragment).not.toContain('fetchPriority');
  });
});
