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

  it('tags galleries with their image count, capped at 4 ("4 or more")', () => {
    const images = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://cdn.test/${i}.png`, alt: `${i}` }));
    for (const [n, tag] of [[2, '2'], [3, '3'], [4, '4'], [9, '4']] as const) {
      expect(render([{ id: 'g', type: 'gallery', images: images(n) }])).toContain(`<ul class="zb-gallery" data-count="${tag}">`);
    }
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

  it('keeps large galleries on an auto-fill grid whose tile size ignores the image count', () => {
    expect(rule(mediaCss, '.zb-gallery').decls.get('grid-template-columns')).toBe(`repeat(auto-fill,minmax(min(100%,${TILE_MIN}px),1fr))`);
    expect(mediaCss).not.toMatch(/data-count="4"/);
  });

  it('sizes short galleries by their own width (container query), never below the tile minimum', () => {
    expect(rule(mediaCss, '.zb-gallery-wrap').decls.get('container-type')).toBe('inline-size');

    const one = rule(mediaCss, '.zb-gallery[data-count="1"]');
    expect(one.decls.get('grid-template-columns')).toBe('minmax(0,320px)');
    expect(one.decls.get('justify-content')).toBe('center');
    expect(one.containerMinWidth).toBeNull();

    for (const n of [2, 3]) {
      const r = rule(mediaCss, `.zb-gallery[data-count="${n}"]`);
      expect(r.decls.get('justify-content')).toBe('center');
      expect(r.decls.get('grid-template-columns')).toMatch(new RegExp(`^repeat\\(${n},minmax\\(0,\\d+px\\)\\)$`));
      // The switch must only happen once n tiles of at least TILE_MIN fit next to each other.
      expect(r.containerMinWidth).not.toBeNull();
      expect(r.containerMinWidth ?? 0).toBeGreaterThanOrEqual(n * TILE_MIN + (n - 1) * GAP);
    }
    // Viewport media queries would ignore narrow layout cells.
    expect(mediaCss).not.toMatch(/@media[^{]*\{[^}]*data-count/);
  });
});
