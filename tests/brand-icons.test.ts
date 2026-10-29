import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
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
  describe('on the server', () => {
    // import.meta.env.SSR is the live process.env in Bun: render the server path like the home page does.
    const previousSsr = process.env.SSR;
    beforeAll(() => { process.env.SSR = 'true'; });
    afterAll(() => { if (previousSsr === undefined) delete process.env.SSR; else process.env.SSR = previousSsr; });

    it('renders a curated Lucide icon by name or alias inside a Suspense boundary', () => {
      expect(render('database')).toContain('data-icon="database"');
      expect(render('rocket')).toContain('lucide-rocket');
      expect(render('launch')).toContain('data-icon="rocket"');
      expect(render('brand-new-product')).toContain('data-icon="link"');
      // renderToString keeps the Suspense markers the client boundary hydrates against.
      expect(renderToString(createElement(BrandIcon, { name: 'database' }))).toMatch(/^<!--\$--><div[^>]*data-icon="database"/);
    });
  });

  it('shows the neutral link mark in the browser until the curated icon map chunk loads', () => {
    const html = render('database');
    expect(html).toContain('data-icon="link"');
    expect(html).not.toContain('data-icon="database"');
    expect(textOf(html)).toBe('');
  });

  it('keeps the curated icon map and name list out of the static client import graph', async () => {
    const src = await readFile(new URL('../src/components/BrandIcons.tsx', import.meta.url), 'utf8');
    // Value imports from the icon modules exist only for the server, used solely behind the build-time SSR constant.
    const staticImports = src.match(/^import (?!type )[^;]*from '(?:\.\/blocks\/block-icons|\.\.\/lib\/blocks\/icons)';$/gm) ?? [];
    expect(staticImports).toEqual([
      "import { ICON_COMPONENTS as SERVER_ICON_COMPONENTS, resolveIconName as serverResolveIconName } from './blocks/block-icons';",
    ]);
    const uses = src.split('\n').filter(line => /SERVER_ICON_COMPONENTS|serverResolveIconName/.test(line) && !line.startsWith('import '));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toContain('<CuratedOrLink icons={SERVER_ICON_COMPONENTS} resolve={serverResolveIconName}');
    expect(src).toMatch(/\{import\.meta\.env\.SSR\s*\n\s*\? <CuratedOrLink icons=\{SERVER_ICON_COMPONENTS\}/);
    expect(src).toContain("lazy(() => import('./blocks/block-icons')");
    // A second dynamic import of lib/blocks/icons let the bundler fold the name list into a shell chunk.
    expect(src).not.toContain("import('../lib/blocks/icons')");
    // block-icons imports the name list; its top-level calls must stay pure-annotated or the client keeps a bare import.
    const names = await readFile(new URL('../src/lib/blocks/icons.ts', import.meta.url), 'utf8');
    const topLevelCalls = names.split('\n').filter(line => /^(export )?const \w+[^=]*= .*(new \w+\(|\w+\.\w+\()/.test(line));
    expect(topLevelCalls.length).toBeGreaterThan(0);
    for (const line of topLevelCalls) expect(line).toContain('/* @__PURE__ */');
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
