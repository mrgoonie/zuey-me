import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { validateDocument } from '../src/lib/blocks/validate';
import { PROSE_ARTICLE } from './fixtures/v1-article-documents';
import { parseReadsList } from '../src/components/reads/reads-api-client';
import { parseLab200Catalog } from '../src/components/lab200/lab200-api-client';
import { lab200OpenApi } from '../src/lib/lab200/openapi';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { AMBIENT_VIDEO_SCRIPT, FONT_LOADER_SCRIPT, FONTS_URL } from '../src/lib/page/deferred-asset-scripts';
import { RemotePanel } from '../src/components/os/remote-panel-data';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

// The homepage once shipped ~460 KB of HTML: every hidden Zuey OS window rendered its full list
// (reads, videos, 200lab) both as SSR markup and as serialized island props. These checks keep
// those data sets out of the page; the windows fetch them when first opened.
describe('page weight budget', () => {
  test('index.astro does not load the reads, videos or 200lab data sets', async () => {
    const src = await read('../src/pages/index.astro');
    for (const banned of ['listReads', 'listVideos', 'getLab200Catalog', 'ReadsBrowser', 'ZueytubeBrowser', 'Lab200Catalog']) {
      expect(src).not.toContain(banned);
    }
    for (const win of ['ReadsWindow', 'ZueytubeWindow', 'Lab200Window']) {
      expect(src).toMatch(new RegExp(`<${win} client:visible locale=\\{locale\\} />`));
    }
  });

  test('the homepage 200lab fonts load non-blocking', async () => {
    const index = await read('../src/pages/index.astro');
    for (const link of index.match(/<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/g) ?? []) expect(link).toContain('media="print"');
  });

  test('the layout loads web fonts through the deferred loader and never autoplays the video', async () => {
    const layout = await read('../src/layouts/Layout.astro');
    expect(layout).toContain('set:html={FONT_LOADER_SCRIPT}');
    expect(layout).not.toMatch(/<link rel="stylesheet" href=\{FONTS_URL\} \/>\s*(?!<\/noscript>)/);
    expect(layout).not.toMatch(/<video[^>]*\sautoplay/);
    expect(layout).not.toContain('cdn.zuey.me/avatar.png');
  });

  test('every Plus Jakarta Sans and Fraunces stack names its metric-matched fallback', async () => {
    const files = ['../src/styles/global.css', '../src/styles/blocks.css', '../src/components/os/os.css', '../src/components/home/home.css'];
    const stacks = (await Promise.all(files.map(read))).flatMap(css => css.match(/(?:font-family|--os-(?:sans|serif)):[^;]+;/g) ?? []);
    const sans = stacks.filter(d => /Plus Jakarta Sans['"],/.test(d));
    const serif = stacks.filter(d => /Fraunces['"]?,/.test(d) && !/Fraunces Fallback['"];/.test(d));
    expect(sans.length).toBeGreaterThan(3);
    expect(serif.length).toBeGreaterThan(3);
    for (const d of sans) expect(d).toMatch(/Plus Jakarta Sans Fallback['"], ['"]Plus Jakarta Sans Fallback Roboto['"]/);
    for (const d of serif) expect(d).toContain('Fraunces Fallback');
    const css = await read('../src/styles/global.css');
    // Each fallback has a regular face and a real bold face: a synthesized bold is narrower than the web font's
    // bold, so bold titles and badges would rewrap (and shift the page) when the web font arrives.
    for (const face of ['Plus Jakarta Sans Fallback', 'Plus Jakarta Sans Fallback Roboto', 'Fraunces Fallback']) {
      const faces = css.match(new RegExp(`@font-face \\{ font-family: '${face}'; [^}]+\\}`, 'g')) ?? [];
      expect(faces.some(f => /src: local\('[A-Za-z]+'\); font-weight: 100 /.test(f))).toBe(true);
      expect(faces.some(f => /src: local\('[A-Za-z]+ Bold'\)[^;]*; font-weight: 550 /.test(f))).toBe(true);
      for (const f of faces) expect(f).toMatch(/size-adjust: [\d.]+%; ascent-override: [\d.]+%; descent-override: [\d.]+%; line-gap-override: 0%/);
      // Overrides are scaled by size-adjust, so every face must give the same ascent and descent once scaled.
      const scaled = faces.map(f => {
        const [size, ascent, descent] = ['size-adjust', 'ascent-override', 'descent-override'].map(k => Number(f.match(new RegExp(`${k}: ([\\d.]+)%`))?.[1]));
        return { ascent: (size * ascent) / 1e4, descent: (size * descent) / 1e4 };
      });
      for (const m of scaled) {
        expect(m.ascent).toBeCloseTo(scaled[0].ascent, 2);
        expect(m.descent).toBeCloseTo(scaled[0].descent, 2);
      }
    }
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

  test('parseLab200Catalog accepts only 200lab asset images', () => {
    const item = (slug: string, cover: unknown) => ({
      slug, url: `https://200lab.io/courses/${slug}`, jsonUrl: `https://200lab.io/courses/${slug}.json`, title: slug.toUpperCase(),
      cover, pricing: { state: 'available', prices: [] },
    });
    const snap = parseLab200Catalog({
      courses: [
        item('x', { url: 'https://assets.200lab.io/x', variants: [] }),
        item('y', { url: 'http://insecure.example/y', variants: [] }),
        { title: 'no slug' },
      ],
      synced_at: null,
      learning_paths: [],
    });
    expect(snap?.courses.items.map(c => [c.slug, c.cover?.url ?? null])).toEqual([['x', 'https://assets.200lab.io/x'], ['y', null]]);
    expect(snap?.courses.syncedAt).toBeNull();
    expect(parseLab200Catalog(null)).toBeNull();
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

interface BootEnv {
  width?: number;
  reducedMotion?: boolean;
  saveData?: boolean;
  readyState?: 'loading' | 'complete';
}

/** Runs an inline boot script against a stub browser and reports what it requested. */
function runBoot(script: string, env: BootEnv = {}) {
  const listeners: Record<string, () => void> = {};
  const appended: { rel: string; href: string }[] = [];
  const video = { preload: 'none', played: false, play() { this.played = true; return Promise.resolve(); } };
  const stub = {
    navigator: { connection: env.saveData ? { saveData: true } : undefined },
    matchMedia: (q: string) => ({
      matches: q.includes('min-width: 768px') ? (env.width ?? 1280) >= 768 : q.includes('reduce') ? Boolean(env.reducedMotion) : false,
    }),
    document: {
      readyState: env.readyState ?? 'loading',
      querySelector: (sel: string) => (sel === 'video[data-ambient]' ? video : null),
      createElement: () => ({ rel: '', href: '' }),
      head: { appendChild: (el: { rel: string; href: string }) => appended.push(el) },
    },
    addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
    setTimeout: (fn: () => void) => fn(),
  };
  const window = { ...stub };
  new Function('window', ...Object.keys(stub), script)(window, ...Object.values(stub));
  return { listeners, appended, video, load: () => listeners.load?.() };
}

describe('deferred asset scripts', () => {
  test('web fonts are requested only after the load event', () => {
    const run = runBoot(FONT_LOADER_SCRIPT);
    expect(run.appended).toHaveLength(0);
    run.load();
    expect(run.appended).toEqual([{ rel: 'stylesheet', href: FONTS_URL }]);
    expect(runBoot(FONT_LOADER_SCRIPT, { readyState: 'complete' }).appended).toHaveLength(1);
  });

  test('the ambient video starts after load on wide screens only', () => {
    const desktop = runBoot(AMBIENT_VIDEO_SCRIPT);
    expect(desktop.video.played).toBe(false);
    desktop.load();
    expect(desktop.video).toMatchObject({ played: true, preload: 'auto' });
    for (const env of [{ width: 412 }, { reducedMotion: true }, { saveData: true }] satisfies BootEnv[]) {
      const run = runBoot(AMBIENT_VIDEO_SCRIPT, env);
      run.load();
      expect(run.video.played).toBe(false);
      expect(run.listeners.load).toBeUndefined();
    }
  });
});

describe('remote panel', () => {
  const strings = { loading: 'Loading', failed: 'Failed', retry: 'Try again', openPage: 'Open' };
  const render = (state: Parameters<typeof RemotePanel<string>>[0]['state']) =>
    renderToString(createElement(RemotePanel<string>, { state, onRetry: () => {}, href: '/reads', strings, children: (d: string) => createElement('p', null, d) }));

  test('one focusable container wraps loading, error and content, so retry can keep focus in the panel', () => {
    for (const html of [render({ status: 'loading' }), render({ status: 'error', message: 'x' }), render({ status: 'ready', data: 'list' })]) {
      expect(html).toMatch(/^<div tabindex="-1" class="min-w-0 focus:outline-none"/);
    }
    expect(render({ status: 'error', message: 'x' })).toContain('href="/reads"');
    expect(render({ status: 'ready', data: 'list' })).toContain('<p>list</p>');
  });
});
