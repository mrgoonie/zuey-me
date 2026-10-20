import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { validateDocument } from '../src/lib/blocks/validate';
import { PROSE_ARTICLE } from './fixtures/v1-article-documents';
import { parseReadsList } from '../src/components/reads/reads-api-client';
import { parseLab200Snapshot } from '../src/components/lab200/lab200-api-client';
import { lab200OpenApi } from '../src/lib/lab200/openapi';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

// The homepage once shipped ~460 KB of HTML: every hidden Zuey OS window rendered its full list
// (reads, videos, 200lab) both as SSR markup and as serialized island props. These checks keep
// those data sets out of the page; the windows fetch them when first opened.
describe('page weight budget', () => {
  test('index.astro does not load the reads, videos or 200lab data sets', async () => {
    const src = await read('../src/pages/index.astro');
    for (const banned of ['listReads', 'listVideos', 'getLab200Snapshot', 'ReadsBrowser', 'ZueytubeBrowser', 'Lab200Courses']) {
      expect(src).not.toContain(banned);
    }
    for (const win of ['ReadsWindow', 'ZueytubeWindow', 'Lab200Window']) {
      expect(src).toMatch(new RegExp(`<${win} client:visible locale=\\{locale\\} />`));
    }
  });

  test('fonts and the ambient video stay off the critical path', async () => {
    const layout = await read('../src/layouts/Layout.astro');
    expect(layout).toContain('<script is:inline set:html={FONT_LOADER_SCRIPT} />');
    expect(layout).toContain("addEventListener('load',f,{once:true})");
    expect(layout).not.toMatch(/<link rel="stylesheet" href=\{FONTS_URL\} \/>\s*(?!<\/noscript>)/);
    expect(layout).toContain('preload="none"');
    expect(layout).not.toMatch(/<video[^>]*\sautoplay/);
    expect(layout).toContain("matchMedia('(min-width: 768px)')");
    expect(layout).not.toContain('cdn.zuey.me/avatar.png');
    const index = await read('../src/pages/index.astro');
    for (const link of index.match(/<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/g) ?? []) expect(link).toContain('media="print"');
  });

  test('web-font fallbacks are metric-matched so the swap does not shift layout', async () => {
    const css = await read('../src/styles/global.css');
    expect(css).toContain("font-family: 'Plus Jakarta Sans', 'Plus Jakarta Sans Fallback'");
    expect(css).toContain("font-family: 'Fraunces', 'Fraunces Fallback'");
    expect(css).toMatch(/font-family: 'Plus Jakarta Sans Fallback';[\s\S]*?size-adjust/);
  });

  test('the 200lab endpoint is documented', () => {
    expect(OPENAPI_FRAGMENTS).toContain(lab200OpenApi);
    expect(lab200OpenApi.paths['/api/v1/lab200']).toBeDefined();
  });
});

describe('window data parsers', () => {
  test('parseReadsList keeps valid items and drops unsafe ones', () => {
    const view = parseReadsList({
      items: [
        { id: 'a', url: 'https://example.com/a', title: 'A', created_at: '2026-10-01' },
        { id: 'b', url: 'javascript:alert(1)' },
        'junk',
      ],
      sources: [{ source_kind: 'rss', count: 3 }, { count: 1 }],
      last_synced_at: '2026-10-19T00:00:00Z',
    });
    expect(view?.items.map(i => i.id)).toEqual(['a']);
    expect(view?.items[0].visible).toBe(true);
    expect(view?.sources).toEqual([{ source_kind: 'rss', count: 3 }]);
    expect(view?.lastSyncedAt).toBe('2026-10-19T00:00:00Z');
    expect(parseReadsList({ items: 'nope' })).toBeNull();
  });

  test('parseLab200Snapshot accepts only https images', () => {
    const snap = parseLab200Snapshot({
      courses: [
        { slug: 'x', title: 'X', summary: 's', lessons: 5, status: 'open', free: true, image: 'https://assets.200lab.io/x' },
        { slug: 'y', title: 'Y', image: 'http://insecure.example/y' },
        { title: 'no slug' },
      ],
      synced_at: null,
    });
    expect(snap?.courses.map(c => [c.slug, c.image])).toEqual([['x', 'https://assets.200lab.io/x'], ['y', null]]);
    expect(snap?.syncedAt).toBeNull();
    expect(parseLab200Snapshot(null)).toBeNull();
  });
});

describe('article lead image', () => {
  const imgs = (html: string) => html.match(/<img [^>]*>/g) ?? [];
  const checked = validateDocument(PROSE_ARTICLE);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const doc = checked.doc;

  test('the article page loads the first image eagerly at high priority', () => {
    const [lead] = imgs(renderToString(createElement(BlockRenderer, { doc, eagerLeadImage: true })));
    expect(lead).toContain('fetchPriority="high"');
    expect(lead).not.toContain('loading="lazy"');
  });

  test('HTML fragments keep every image lazy', () => {
    const html = renderToString(createElement(BlockRenderer, { doc }));
    expect(imgs(html).length).toBeGreaterThan(0);
    for (const img of imgs(html)) expect(img).toContain('loading="lazy"');
    expect(html).not.toContain('rel="preload"');
  });
});
