import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Studio image size probe, in happy-dom with a stand-in Image that "loads" any URL at a size parsed from it.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
type ProbeModule = typeof import('../src/components/studio/image-size-probe');

let React: ReactModule;
let client: ClientModule;
let probe: ProbeModule;

/** Loads `https://…/<w>x<h>.png` at that natural size; any other URL never loads. */
class FakeImage {
  static requested: string[] = [];
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  set src(url: string) {
    FakeImage.requested.push(url);
    const m = /(\d+)x(\d+)\.png$/.exec(url);
    if (!m) return;
    this.naturalWidth = Number(m[1]);
    this.naturalHeight = Number(m[2]);
    queueMicrotask(() => this.onload?.());
  }
}

const roots: Array<{ unmount: () => void }> = [];
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, Image: FakeImage });
  React = await import('react');
  client = await import('react-dom/client');
  probe = await import('../src/components/studio/image-size-probe');
});

afterEach(() => {
  for (const r of roots.splice(0)) React.act(() => r.unmount());
  FakeImage.requested = [];
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function mountProbe(url: string, known: boolean, onSize: (s: { width: number; height: number }) => void) {
  const root = client.createRoot(document.createElement('div'));
  const render = (u: string, k: boolean) => React.act(() => root.render(React.createElement(probe.ImageSizeProbe, { url: u, known: k, onSize })));
  render(url, known);
  roots.push({ unmount: () => root.unmount() });
  return render;
}

describe('Studio image size probe', () => {
  it('leaves an opened article alone: the URL it starts with is not measured', async () => {
    const sizes: unknown[] = [];
    mountProbe('https://cdn.test/400x700.png', false, s => sizes.push(s));
    await wait(500);
    expect(FakeImage.requested).toEqual([]);
    expect(sizes).toEqual([]);
  });

  it('measures a newly entered URL once typing pauses', async () => {
    const sizes: unknown[] = [];
    const render = mountProbe('https://', false, s => sizes.push(s));
    render('https://cdn.test/40', false);
    render('https://cdn.test/400x700.png', false);
    await wait(500);
    expect(FakeImage.requested).toEqual(['https://cdn.test/400x700.png']);
    expect(sizes).toEqual([{ width: 400, height: 700 }]);
  });

  it('does not measure when the size is already known or the URL is not https', async () => {
    const sizes: unknown[] = [];
    const render = mountProbe('https://', false, s => sizes.push(s));
    render('https://cdn.test/400x700.png', true);
    render('http://cdn.test/400x700.png', false);
    await wait(500);
    expect(FakeImage.requested).toEqual([]);
    expect(sizes).toEqual([]);
  });

  it('clears a recorded size so a changed URL is measured again', () => {
    expect(probe.withoutImageSize({ url: 'https://a', alt: '', width: 1, height: 2 })).toEqual({ url: 'https://a', alt: '' });
    expect(probe.hasImageSize({ width: 1, height: 2 })).toBe(true);
    expect(probe.hasImageSize({})).toBe(false);
  });
});
