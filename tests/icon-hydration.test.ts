import { describe, it, expect, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ArticleDocument } from '../src/lib/blocks/schema';

// Hydrates server HTML in happy-dom. This file installs process globals: never run it with
// `bun test --concurrent`. `import.meta.env` is the live process.env in Bun, so toggling SSR
// switches BlockRenderer between its server and client icon paths.
GlobalRegistrator.register();
const { act, createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { hydrateRoot } = await import('react-dom/client');
const { BlockRenderer, IconPlaceholder } = await import('../src/components/blocks/BlockRenderer');
const { validateDocument } = await import('../src/lib/blocks/validate');

const previousSsr = process.env.SSR;

afterAll(async () => {
  if (previousSsr === undefined) delete process.env.SSR; else process.env.SSR = previousSsr;
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  await GlobalRegistrator.unregister();
});

function doc(): ArticleDocument {
  const res = validateDocument({ version: 1, blocks: [
    { type: 'paragraph', text: 'Before' },
    { type: 'icon', name: 'rocket', size: 'xl', label: 'Ra mắt' },
    { type: 'callout', tone: 'tip', text: 'Tip', icon: 'lightbulb' },
    { type: 'paragraph', text: 'After' },
  ] });
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.doc;
}

describe('icon hydration', () => {
  it('hydrates server-rendered icons without a mismatch and keeps the server SVG while the chunk loads', async () => {
    const document_ = doc();
    process.env.SSR = 'true';
    const html = renderToString(createElement(BlockRenderer, { doc: document_, interactive: false }));
    delete process.env.SSR;
    // The server wraps each icon in a Suspense boundary, so the client has a matching boundary to wait on.
    expect(html.match(/<!--\$-->/g)?.length).toBe(2);
    expect(html).toContain('data-icon="rocket"');
    expect(html).toContain('data-icon="lightbulb"');

    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const serverSvg = host.querySelector('svg[data-icon="rocket"]');
    const errors: unknown[] = [];
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(host, createElement(BlockRenderer, { doc: document_, interactive: false }), {
        onRecoverableError: (error: unknown) => { errors.push(error); },
      });
    });
    // Before or after the lazy chunk resolves, the server markup is never thrown away.
    expect(host.querySelector('svg[data-icon="rocket"]')).not.toBeNull();
    await act(async () => { await import('../src/components/blocks/block-icons'); await new Promise(r => setTimeout(r, 20)); });
    expect(errors).toEqual([]);
    const after = host.querySelector('svg[data-icon="rocket"]');
    expect(after).toBe(serverSvg);
    expect(after?.getAttribute('aria-label')).toBe('Ra mắt');
    expect(host.querySelector('.zb-callout svg[data-icon="lightbulb"]')).not.toBeNull();
    expect(host.textContent).toContain('After');
    await act(async () => root?.unmount());
    host.remove();
  });

  it('client-only renders (Studio preview) end with the real icons', async () => {
    delete process.env.SSR;
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(BlockRenderer, { doc: doc(), interactive: false })));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(host.querySelector('svg[data-icon="rocket"]')).not.toBeNull();
    expect(host.querySelector('.zb-callout svg[data-icon="lightbulb"]')).not.toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });

  it('uses a same-size aria-hidden placeholder as the loading fallback', () => {
    expect(renderToString(createElement(IconPlaceholder, { size: 'xl' })))
      .toBe('<span aria-hidden="true" style="display:inline-block;width:48px;height:48px"></span>');
    expect(renderToString(createElement(IconPlaceholder, { size: 20 }))).toContain('width:20px;height:20px');
  });
});
