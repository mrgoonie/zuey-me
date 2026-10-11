import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import type { Block } from '../src/lib/blocks/schema';

const blocksCss = readFileSync(new URL('../src/styles/blocks.css', import.meta.url), 'utf8');
const mediaCss = readFileSync(new URL('../src/components/blocks/media-blocks.css', import.meta.url), 'utf8');

function render(blocks: Block[]): string {
  return renderToString(createElement(BlockRenderer, { doc: { version: 1, blocks }, interactive: false }));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();

interface CssRule { decls: Map<string, string>; containerMinWidth: number | null }

/**
 * The rule whose selector is exactly `selector` (top level or inside an `@container (min-width: …)` block),
 * as a property -> value map with whitespace normalised, so formatting changes do not break assertions.
 */
function rule(css: string, selector: string): CssRule {
  const match = new RegExp(`(?:^|[\\n{}])\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`missing CSS rule: ${selector}`);
  const decls = new Map<string, string>();
  for (const decl of match[1].split(';')) {
    const at = decl.indexOf(':');
    if (at > 0) decls.set(decl.slice(0, at).trim(), squash(decl.slice(at + 1)));
  }
  const before = css.slice(0, match.index + 1);
  const openContainer = /@container\s*\(\s*min-width:\s*(\d+(?:\.\d+)?)px\s*\)\s*\{[^{}]*$/.exec(before);
  return { decls, containerMinWidth: openContainer ? Number(openContainer[1]) : null };
}

const TILE_MIN = 160;
const GAP = 9.6; // 0.6rem

const image: Block = { id: 'img1', type: 'image', url: 'https://cdn.test/portrait.png', alt: 'Portrait', caption: 'Ảnh dọc' };

describe('article images are horizontally centred', () => {
  it('renders a single image and its caption inside a centred figure', () => {
    const html = render([image]);
    expect(html).toMatch(/<figure class="zb-figure zb-figure-center"><img src="https:\/\/cdn\.test\/portrait\.png" alt="Portrait"[^>]*\/><figcaption>Ảnh dọc<\/figcaption><\/figure>/);
  });

  it('centres images nested in layout cells the same way', () => {
    const html = render([{
      id: 'l1', type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 },
      children: [{ blocks: [image] }, { blocks: [{ id: 'p1', type: 'paragraph', text: 'Bên cạnh' }] }],
    }]);
    expect(html).toContain('<div class="zb-cell"');
    expect(html).toContain('<figure class="zb-figure zb-figure-center"><img src="https://cdn.test/portrait.png"');
  });

  it('centres gallery tiles and the gallery caption', () => {
    const html = render([{
      id: 'g1', type: 'gallery', caption: 'Bộ ảnh',
      images: [{ url: 'https://cdn.test/a.png', alt: 'A', caption: 'Một' }],
    }]);
    expect(html).toContain('<figure class="zb-figure zb-figure-center zb-gallery-wrap"><ul class="zb-gallery" data-count="1">');
    expect(html).toContain('<figcaption>Bộ ảnh</figcaption>');
  });

  it('keeps the natural ratio and never overflows the column', () => {
    const img = rule(blocksCss, '.zb-figure img').decls;
    expect(img.get('max-width')).toBe('100%');
    expect(img.get('height')).toBe('auto');
    expect(img.get('display')).toBe('block');
    expect(img.has('width')).toBe(false);
  });

  it('centres the image box and the caption text', () => {
    expect(rule(blocksCss, '.zb-figure-center').decls.get('text-align')).toBe('center');
    expect(rule(blocksCss, '.zb-figure-center img').decls.get('margin-inline')).toBe('auto');
  });

  it('wraps gallery tiles and centres every row, including an incomplete last row', () => {
    const gallery = rule(mediaCss, '.zb-gallery').decls;
    expect(gallery.get('display')).toBe('flex');
    expect(gallery.get('flex-wrap')).toBe('wrap');
    expect(gallery.get('justify-content')).toBe('center');
    expect(gallery.get('--zb-gallery-gap')).toBe('0.6rem');
    // Fixed tile basis (no grow): a short last row keeps the tile size and is centred, not stretched.
    const flex = rule(mediaCss, '.zb-gallery > li').decls.get('flex') ?? '';
    expect(flex.startsWith('0 0 ')).toBe(true);
    expect(flex.slice(4).replace(/\s+/g, '')).toBe(
      'min(var(--zb-gallery-tile-max),(100%-(var(--zb-gallery-cols)-1)*var(--zb-gallery-gap))/var(--zb-gallery-cols))',
    );
  });

  it('keeps the gallery from collapsing in parents that size to their content', () => {
    const wrap = rule(mediaCss, '.zb-gallery-wrap').decls;
    expect(wrap.get('container-type')).toBe('inline-size');
    expect(wrap.get('width')).toBe('100%');
    expect(wrap.get('contain-intrinsic-inline-size')).toBe(`${TILE_MIN}px`);
  });

  it('tags galleries with their image count, capped at 6 (the widest row)', () => {
    const images = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://cdn.test/${i}.png`, alt: `${i}` }));
    for (const [n, tag] of [[2, '2'], [3, '3'], [4, '4'], [6, '6'], [9, '6']] as const) {
      expect(render([{ id: 'g', type: 'gallery', images: images(n) }])).toContain(`<ul class="zb-gallery" data-count="${tag}">`);
    }
  });

  describe('column model from the stylesheet', () => {
    const MAX_COUNT = 6;
    const counts = (selector: string): number[] => {
      const listed = [...selector.matchAll(/data-count="(\d)"/g)].map(m => Number(m[1]));
      const all = Array.from({ length: MAX_COUNT }, (_, i) => i + 1);
      return selector.includes(':not(') ? all.filter(n => !listed.includes(n)) : listed;
    };
    // `@container (min-width: Xpx) { <selector> { --zb-gallery-cols: N; } }`
    const colRules = [...mediaCss.matchAll(/@container\s*\(\s*min-width:\s*([\d.]+)px\s*\)\s*\{\s*([^{]+)\{\s*--zb-gallery-cols:\s*(\d)\s*;\s*\}\s*\}/g)]
      .map(m => ({ minWidth: Number(m[1]), counts: counts(m[2]), cols: Number(m[3]) }));
    // Top-level tile caps: `<selector> { --zb-gallery-tile-max: Npx; }`
    const capRules = [...mediaCss.matchAll(/\n(\.zb-gallery[^{\n]*)\{\s*--zb-gallery-tile-max:\s*(\d+)px;\s*\}/g)]
      .map(m => ({ counts: counts(m[1]), cap: Number(m[2]) }));

    /** Columns the stylesheet gives `count` images in a gallery `width` px wide (later rules win, as in CSS). */
    const colsFor = (width: number, count: number) =>
      colRules.filter(r => width >= r.minWidth && r.counts.includes(count)).reduce((cols, r) => r.cols, 1);
    const tileFor = (width: number, count: number) => {
      const cols = colsFor(width, count);
      const cap = capRules.find(r => r.counts.includes(count))?.cap ?? Infinity;
      return Math.min(cap, (width - (cols - 1) * GAP) / cols);
    };

    it('parses every column step and tile cap', () => {
      expect(colRules.map(r => r.cols)).toEqual([2, 3, 4, 5, 6]);
      expect(capRules).toEqual([{ counts: [1, 2], cap: 320 }, { counts: [3], cap: 240 }]);
      // Viewport media queries would ignore narrow layout cells.
      expect(mediaCss).not.toMatch(/@media[^{]*\{[^}]*data-count/);
    });

    it('fits as many tiles of at least 160px as the width allows, never more than the images', () => {
      for (let count = 1; count <= MAX_COUNT; count++) {
        for (let width = 120; width <= 1200; width += 0.5) {
          const cols = colsFor(width, count);
          const fit = Math.max(1, Math.floor((width + GAP) / (TILE_MIN + GAP) + 1e-9));
          expect({ width, count, cols }).toEqual({ width, count, cols: Math.min(count, fit) });
          // Tiles keep the minimum unless the gallery itself is narrower, and a row never overflows.
          const tile = tileFor(width, count);
          expect(tile).toBeGreaterThanOrEqual(Math.min(TILE_MIN, width) - 1e-9);
          expect(cols * tile + (cols - 1) * GAP).toBeLessThanOrEqual(width + 1e-9);
        }
      }
    });

    it('fills incomplete rows symmetrically: the leftover width is split evenly by justify-content', () => {
      // 3 images in a 376px gallery (430px phone): 2 tiles, then 1 centred tile with equal space either side.
      const width = 376;
      const cols = colsFor(width, 3);
      const tile = tileFor(width, 3);
      expect(cols).toBe(2);
      const side = (width - tile) / 2;
      expect(side).toBeCloseTo(96.4, 1);
    });
  });
});
