import { describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { APP_IDS, APPS } from '../src/components/os/apps';
import { appDirectory } from '../src/components/os/app-directory';
import { renderStaticIndexHtml, zueyOsAgentGuideMarkdown } from '../src/components/os/agent-surfaces';
import { osStrings } from '../src/components/os/os-i18n';
import { WEBMCP_TOOL_SUMMARIES, createZueyOsTools, registerZueyOsTools, type WebMcpTool } from '../src/components/os/webmcp-tools';
import { GET as llmsTxt } from '../src/pages/llms.txt';
import { GET as indexMd } from '../src/pages/index.md';
import { LOCALES } from '../src/lib/i18n/locales';

const PROFILE = { name: 'Duy Nguyen', handle: '/zuey/', intro_en: 'Builder <in public> & CTO', intro_vi: 'Người xây dựng' };
const ctx = (url: string) => ({ request: new Request(url), locals: { runtime: { env: {} } } }) as unknown as APIContext;
const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

describe('Zuey OS no-JS index on /', () => {
  it('index.astro renders the static index next to the island', async () => {
    const page = await read('../src/pages/index.astro');
    expect(page).toContain("import ZueyOSStaticIndex from '../components/os/ZueyOSStaticIndex.astro';");
    expect(page).toContain('<ZueyOSStaticIndex locale={locale} profile={profile} />');
    const component = await read('../src/components/os/ZueyOSStaticIndex.astro');
    expect(component).toContain('renderStaticIndexHtml(locale, profile)');
    expect(component).toContain('<Fragment set:html={html} />');
  });

  for (const locale of LOCALES) {
    it(`lists every app with its name, summary and standalone href (${locale})`, () => {
      const html = renderStaticIndexHtml(locale, PROFILE);
      const apps = appDirectory(locale);
      expect(apps.map(a => a.id).sort()).toEqual([...APP_IDS].sort());
      for (const app of apps) {
        expect(app.name).toBe(osStrings(locale).apps[app.id]);
        expect(app.summary.length).toBeGreaterThan(10);
        expect(html).toContain(`<a href="${APPS[app.id].href}" tabindex="-1">${escapeHtml(app.name)}</a>: ${escapeHtml(app.summary)}</li>`);
      }
    });
  }

  it('loads the WebMCP tools only through a feature-detected dynamic import', async () => {
    const component = await read('../src/components/os/ZueyOSStaticIndex.astro');
    const script = component.slice(component.indexOf('<script>'));
    expect(script).toContain("if ('modelContext' in document || 'modelContext' in navigator)");
    expect(script).toContain("import('./webmcp-tools')");
    expect(script.indexOf("'modelContext' in document")).toBeLessThan(script.indexOf("import('./webmcp-tools')"));
    expect(component).not.toMatch(/^\s*import\s[^(]*webmcp-tools/m);
    expect(script).toContain('requestIdleCallback');
  });

  it('localizes the agent links', () => {
    expect(renderStaticIndexHtml('vi', PROFILE)).toContain('<a href="/docs" tabindex="-1">Tài liệu API</a>');
    expect(renderStaticIndexHtml('en', PROFILE)).toContain('<a href="/docs" tabindex="-1">API docs</a>');
  });

  it('is semantic, visually hidden and escapes profile text', () => {
    const html = renderStaticIndexHtml('en', PROFILE);
    expect(html).toStartWith('<section id="zueyos-index" class="sr-only" data-locale="en"');
    expect(html).toContain('<h2 id="zueyos-index-title">Duy Nguyen (/zuey/)</h2>');
    expect(html).toContain('<p>Builder &lt;in public&gt; &amp; CTO</p>');
    expect(html).toMatch(/<nav aria-label="Zuey OS apps"><h3>Apps<\/h3>.*<ul>.*<\/ul><\/nav>/);
    expect(renderStaticIndexHtml('vi', PROFILE)).toContain('<p>Người xây dựng</p>');
  });
});

describe('Zuey OS WebMCP tools', () => {
  type Registered = { tool: WebMcpTool; signal?: AbortSignal };
  const fakeContext = () => {
    const registered: Registered[] = [];
    return {
      registered,
      modelContext: {
        registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }) {
          if (registered.some(r => r.tool.name === tool.name)) return Promise.reject(new DOMException('dup', 'InvalidStateError'));
          registered.push({ tool, signal: options?.signal });
          return Promise.resolve();
        },
      },
    };
  };
  const tool = (tools: WebMcpTool[], name: string) => {
    const found = tools.find(t => t.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };

  it('registers the expected read/navigate tools on document.modelContext', () => {
    const fake = fakeContext();
    const unregister = registerZueyOsTools({ locale: 'en' }, { doc: { modelContext: fake.modelContext } });
    expect(unregister).toBeFunction();
    expect(fake.registered.map(r => r.tool.name)).toEqual(['zueyos_list_apps', 'zueyos_open_app', 'zueyos_search_articles', 'zueyos_get_profile']);
    expect(fake.registered.map(r => r.tool.name)).toEqual(WEBMCP_TOOL_SUMMARIES.map(t => t.name));
    for (const { tool: t } of fake.registered) {
      expect(t.name).toMatch(/^[A-Za-z0-9_.-]{1,30}$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description.length).toBeLessThanOrEqual(500);
      expect(() => JSON.stringify(t.inputSchema)).not.toThrow();
      expect(t.annotations.consequentialHint).toBeFalsy();
    }
    unregister?.();
    expect(fake.registered.every(r => r.signal?.aborted)).toBe(true);
  });

  it('falls back to the deprecated navigator.modelContext and to provideContext', () => {
    const fake = fakeContext();
    expect(registerZueyOsTools({ locale: 'en' }, { doc: {}, nav: { modelContext: fake.modelContext } })).toBeFunction();
    expect(fake.registered).toHaveLength(4);

    const provided: WebMcpTool[][] = [];
    const clear = registerZueyOsTools({ locale: 'en' }, { doc: { modelContext: { provideContext: (c: { tools: WebMcpTool[] }) => { provided.push(c.tools); } } } });
    expect(provided[0]).toHaveLength(4);
    clear?.();
    expect(provided[1]).toEqual([]);
  });

  it('is a silent no-op without WebMCP and survives refused registrations', () => {
    expect(registerZueyOsTools({ locale: 'en' }, { doc: {}, nav: {} })).toBeNull();
    expect(registerZueyOsTools({ locale: 'en' }, { doc: { modelContext: null }, nav: { modelContext: { other: 1 } } })).toBeNull();
    expect(registerZueyOsTools({ locale: 'en' }, {})).toBeNull();
    const throwing = { registerTool: () => { throw new DOMException('not origin-isolated', 'SecurityError'); } };
    expect(() => registerZueyOsTools({ locale: 'en' }, { doc: { modelContext: throwing } })).not.toThrow();
    const fake = fakeContext();
    registerZueyOsTools({ locale: 'en' }, { doc: { modelContext: fake.modelContext } });
    expect(() => registerZueyOsTools({ locale: 'en' }, { doc: { modelContext: fake.modelContext } })).not.toThrow();
  });

  it('zueyos_list_apps returns every app with absolute routes and deep links', async () => {
    const out = await tool(createZueyOsTools({ locale: 'vi' }), 'zueyos_list_apps').execute({});
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(APP_IDS.length);
    expect(out).toContainEqual(expect.objectContaining({ id: 'pricing', name: 'Gói thành viên', route: 'https://zuey.me/pricing', deep_link: 'https://zuey.me/#pricing' }));
  });

  it('zueyos_open_app validates the id and opens it through ZueyOS', async () => {
    const opened: string[] = [];
    const open = tool(createZueyOsTools({ locale: 'en', openApp: id => opened.push(id) }), 'zueyos_open_app');
    expect(await open.execute({ app_id: 'pricing' })).toEqual({
      opened: 'pricing', name: 'Membership', deep_link: 'https://zuey.me/#pricing', route: 'https://zuey.me/pricing',
    });
    expect(await open.execute({ app_id: 'nope' })).toStartWith('error: unknown app_id "nope"');
    expect(await open.execute(null)).toStartWith('error: unknown app_id null');
    expect(opened).toEqual(['pricing']);
  });

  it('zueyos_search_articles calls the public search endpoint and never throws', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (path: string) => {
      calls.push(path);
      return Response.json({ success: true, data: { results: [{ title: 'AI agents', url: 'https://zuey.me/articles/ai', markdown_url: 'https://zuey.me/articles/ai.md', access: 'free', snippet: '**agents**', score: 1 }] } });
    });
    const search = tool(createZueyOsTools({ locale: 'en', fetchImpl }), 'zueyos_search_articles');
    expect(await search.execute({ query: 'agents' })).toEqual({
      query: 'agents',
      locale: 'en',
      results: [{ title: 'AI agents', url: 'https://zuey.me/articles/ai', markdown_url: 'https://zuey.me/articles/ai.md', access: 'free', snippet: '**agents**' }],
      browse: 'https://zuey.me/articles',
    });
    await search.execute({ query: 'tác tử', limit: 2, locale: 'vi' });
    expect(calls).toEqual(['/api/v1/search?q=agents&limit=5&locale=en', `/api/v1/search?${new URLSearchParams({ q: 'tác tử', limit: '2', locale: 'vi' })}`]);
    expect(await search.execute({ query: '' })).toStartWith('error:');
    expect(await search.execute({ query: 'x', limit: 99 })).toStartWith('error: limit');
    expect(await search.execute({ query: 'x', locale: 'fr' })).toStartWith('error: locale');
    expect(calls).toHaveLength(2);

    const failing = tool(createZueyOsTools({ locale: 'en', fetchImpl: (async () => { throw new TypeError('offline'); }) }), 'zueyos_search_articles');
    expect(await failing.execute({ query: 'agents' })).toBe('error: search failed (offline)');
    const apiError = tool(createZueyOsTools({ locale: 'en', fetchImpl: (async () => Response.json({ success: false, error: { code: 'invalid_field', message: 'q is required' } }, { status: 400 })) }), 'zueyos_search_articles');
    expect(await apiError.execute({ query: 'agents' })).toBe('error: q is required');
  });

  it('zueyos_get_profile returns public profile fields only', async () => {
    const fetchImpl = (async () => Response.json({ success: true, data: { id: 'x', name: 'Duy', handle: '/zuey/', intro_en: 'Hi', intro_vi: 'Chào', custom_css: 'body{}', email: 'a@b.c', avatar_url: 'https://cdn/x.png' } }));
    const out = await tool(createZueyOsTools({ locale: 'vi', fetchImpl }), 'zueyos_get_profile').execute({});
    expect(out).toMatchObject({ name: 'Duy', handle: '/zuey/', intro: 'Chào', email: 'a@b.c' });
    expect(out).not.toHaveProperty('custom_css');
  });
});

describe('llms.txt and index.md describe Zuey OS', () => {
  it('list every app, its standalone route, the #app deep-link pattern and agent endpoints', async () => {
    const [llms, md] = await Promise.all([
      Promise.resolve(llmsTxt(ctx('https://zuey.me/llms.txt'))).then(r => r.text()),
      Promise.resolve(indexMd(ctx('https://zuey.me/index.md'))).then(r => r.text()),
    ]);
    for (const text of [llms, md, zueyOsAgentGuideMarkdown()]) {
      expect(text).toContain('## Zuey OS (homepage)');
      expect(text).toContain('https://zuey.me/#<app-id>');
      for (const app of appDirectory('en')) {
        expect(text).toContain(`[${app.name}](https://zuey.me${app.route})`);
        expect(text).toContain(app.summary);
        expect(text).toContain(`https://zuey.me/#${app.id}`);
      }
      for (const t of WEBMCP_TOOL_SUMMARIES) expect(text).toContain(`\`${t.name}\``);
      expect(text).toContain('document.modelContext');
      expect(text).toContain('https://zuey.me/mcp');
      expect(text).toContain('https://zuey.me/api/mcp');
    }
  });
});
