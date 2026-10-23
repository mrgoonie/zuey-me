import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandIcon } from '../src/components/BrandIcons';
import { LinkCard } from '../src/components/LinkCard';
import type { LinkItem } from '../src/db/types';

const render = (name: string) => renderToStaticMarkup(createElement(BrandIcon, { name, className: 'w-7 h-7' }));

/** Text content with tags removed, so a badge that only draws an SVG has none. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, '').trim();

describe('BrandIcon product marks', () => {
  const products = ['cloud', 'vault', 'render', 'multix', 'anymd', 'motion'];

  it.each(products)('%s renders an inline SVG mark instead of initials', (name) => {
    const html = render(name);
    expect(html).toContain('<svg');
    expect(html).toContain(`data-icon="${name}"`);
    expect(html).toContain('w-7 h-7');
    expect(textOf(html)).toBe('');
    expect(html).not.toMatch(/<img|\ssrc=|\shref=/);
  });

  it('gives each product a distinct glyph', () => {
    const glyphs = products.map(name => render(name).match(/class="lucide lucide-([a-z0-9-]+)/)?.[1]);
    expect(glyphs.every(Boolean)).toBe(true);
    expect(new Set(glyphs).size).toBe(products.length);
  });

  it('matches icon names case-insensitively and ignores surrounding spaces', () => {
    expect(render(' Motion ')).toContain('data-icon="motion"');
  });
});

describe('BrandIcon fallback for names it has no brand mark for', () => {
  it('renders a curated Lucide icon by name or alias', () => {
    expect(render('database')).toContain('data-icon="database"');
    expect(render('rocket')).toContain('lucide-rocket');
    expect(render('launch')).toContain('data-icon="rocket"');
  });

  it('renders a neutral link mark, never initials, for an unknown or empty name', () => {
    for (const name of ['brand-new-product', '']) {
      const html = render(name);
      expect(html).toContain('<svg');
      expect(html).toContain('data-icon="link"');
      expect(textOf(html)).toBe('');
    }
  });

  it('keeps existing brand marks unchanged', () => {
    expect(render('agentkit')).toContain('AK');
    expect(render('substack')).toContain('#FF6719');
  });
});

describe('LinkCard icon', () => {
  const item: LinkItem = {
    id: 'l1',
    section: 'products',
    title_en: 'Zeta Product',
    title_vi: 'Zeta Product',
    url: 'https://example.com',
    order_index: 0,
    is_active: true,
  };
  const iconSlot = (html: string) => html.match(/<div class="flex-shrink-0 w-11 h-11[^"]*">([\s\S]*?)<\/div><div class="flex-1/)?.[1] ?? '';

  it('draws a graphic mark when the link has no icon value', () => {
    const slot = iconSlot(renderToStaticMarkup(createElement(LinkCard, { item, lang: 'en' })));
    expect(slot).toContain('<svg');
    expect(textOf(slot)).toBe('');
  });

  it('draws the product mark for a product icon value', () => {
    const slot = iconSlot(renderToStaticMarkup(createElement(LinkCard, { item: { ...item, icon: 'anymd' }, lang: 'en' })));
    expect(slot).toContain('data-icon="anymd"');
  });
});
