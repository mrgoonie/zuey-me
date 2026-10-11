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
    expect(html).toContain('<figure class="zb-figure zb-figure-center"><ul class="zb-gallery">');
    expect(html).toContain('<figcaption>Bộ ảnh</figcaption>');
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

  it('keeps short galleries centred without stretching tiles', () => {
    const gallery = rule(mediaCss, '.zb-gallery');
    expect(gallery).toContain('repeat(auto-fit,');
    const tile = rule(mediaCss, '.zb-gallery > li');
    expect(tile).toContain('justify-self: center');
    expect(tile).toMatch(/max-width:\s*\d+px/);
  });
});
