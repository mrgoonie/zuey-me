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

/** Declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`missing CSS rule: ${selector}`);
  return match[1];
}

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
    expect(html).toContain('<figure class="zb-figure zb-figure-center"><ul class="zb-gallery" data-count="1">');
    expect(html).toContain('<figcaption>Bộ ảnh</figcaption>');
  });

  it('tags galleries with their image count, capped at 4 ("4 or more")', () => {
    const images = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://cdn.test/${i}.png`, alt: `${i}` }));
    for (const [n, tag] of [[2, '2'], [3, '3'], [4, '4'], [9, '4']] as const) {
      expect(render([{ id: 'g', type: 'gallery', images: images(n) }])).toContain(`<ul class="zb-gallery" data-count="${tag}">`);
    }
  });

  it('keeps the natural ratio and never overflows the column', () => {
    const img = rule(blocksCss, '.zb-figure img');
    expect(img).toContain('max-width: 100%');
    expect(img).toContain('height: auto');
    expect(img).toContain('display: block');
    expect(img).not.toMatch(/(^|[^-])width:\s*100%/);
  });

  it('centres the image box and the caption text', () => {
    expect(rule(blocksCss, '.zb-figure-center')).toContain('text-align: center');
    expect(rule(blocksCss, '.zb-figure-center img')).toContain('margin-inline: auto');
  });

  it('keeps large galleries on an auto-fill grid whose tile size ignores the image count', () => {
    expect(rule(mediaCss, '.zb-gallery')).toContain('repeat(auto-fill, minmax(min(100%, 160px), 1fr))');
    expect(mediaCss).not.toContain('.zb-gallery[data-count="4"]');
  });

  it('centres short galleries as a group with one capped track per image', () => {
    expect(rule(mediaCss, '.zb-gallery[data-count="1"]')).toMatch(/grid-template-columns: minmax\(0, 320px\);\s*justify-content: center/);
    expect(rule(mediaCss, '.zb-gallery[data-count="2"]')).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 320px\)\);\s*justify-content: center/);
    // Three tiles only once the viewport is wide enough; narrower screens keep the auto-fill grid.
    expect(mediaCss).toMatch(/@media \(min-width: 640px\) \{\s*\.zb-gallery\[data-count="3"\] \{ grid-template-columns: repeat\(3, minmax\(0, 240px\)\); justify-content: center; \}/);
  });
});
