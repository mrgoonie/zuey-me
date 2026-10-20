import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { Profile } from '../src/db/types';
import {
  GLASS_LENSES, displacementMap, glassTier, isChromiumEngine, readGlassCapabilities, type GlassCapabilities,
} from '../src/components/os/liquid-glass';
import { DEFAULT_LOOK, LOOK_KEY, glassEnabled, parseLook } from '../src/components/os/look';

// Liquid Glass tiers for the Zuey OS chrome: capability tiering, the Appearance switch (persisted
// with the look), the reduced-motion / reduced-transparency off switches, and text contrast on the
// glass tints. The DOM part installs happy-dom as process globals: never run with `bun test --concurrent`.

const DESKTOP_CHROMIUM: GlassCapabilities = { chromium: true, backdropFilter: true, compact: false, reducedMotion: false, reducedTransparency: false };

describe('glass tier', () => {
  test('Chromium on a desktop gets refraction', () => {
    expect(glassTier(true, DESKTOP_CHROMIUM)).toBe('liquid');
  });

  test('other engines, phones, touch screens and no backdrop-filter get the blur fallback', () => {
    expect(glassTier(true, { ...DESKTOP_CHROMIUM, chromium: false })).toBe('frost');
    expect(glassTier(true, { ...DESKTOP_CHROMIUM, compact: true })).toBe('frost');
    expect(glassTier(true, { ...DESKTOP_CHROMIUM, backdropFilter: false })).toBe('frost');
  });

  test('reduced motion, reduced transparency or the switch turn the effect off on every engine', () => {
    for (const chromium of [true, false]) {
      expect(glassTier(true, { ...DESKTOP_CHROMIUM, chromium, reducedMotion: true })).toBe('off');
      expect(glassTier(true, { ...DESKTOP_CHROMIUM, chromium, reducedTransparency: true })).toBe('off');
      expect(glassTier(false, { ...DESKTOP_CHROMIUM, chromium })).toBe('off');
    }
  });

  test('the engine check trusts only the Chromium client-hint brand', () => {
    expect(isChromiumEngine({ userAgentData: { brands: [{ brand: 'Not=A?Brand', version: '99' }, { brand: 'Chromium', version: '141' }] } })).toBe(true);
    // Firefox, Safari and Chrome on iOS (WebKit) have no userAgentData; a spoofed UA string is not enough.
    expect(isChromiumEngine({ userAgent: 'Mozilla/5.0 Chrome/141.0 Safari/537.36' })).toBe(false);
    expect(isChromiumEngine({ userAgentData: { brands: [{ brand: 'Firefox' }] } })).toBe(false);
    expect(isChromiumEngine({ userAgentData: { brands: 'Chromium' } })).toBe(false);
    expect(isChromiumEngine({ userAgentData: null })).toBe(false);
  });

  test('displacement maps are neutral in the middle and bend at both edges', () => {
    const svg = decodeURIComponent(displacementMap('x', 0.1).replace('data:image/svg+xml,', ''));
    expect(svg).toContain('stop-color="rgb(255,0,0)"');
    expect(svg).toContain('offset="10.00%" stop-color="rgb(128,0,0)"');
    expect(svg).toContain('offset="90.00%" stop-color="rgb(128,0,0)"');
    expect(svg).toContain('offset="100.00%" stop-color="rgb(0,0,0)"');
    expect(decodeURIComponent(displacementMap('y', 0.3))).toContain('x2="0" y2="1"');
    expect(Object.values(GLASS_LENSES).map(l => l.id)).toEqual(['zos-lg-bar', 'zos-lg-dock', 'zos-lg-title', 'zos-lg-panel']);
  });
});

describe('glass setting in the look', () => {
  test('older looks without the field keep parsing unchanged and mean on', () => {
    expect(parseLook({ mode: 'light' })).toEqual({ ...DEFAULT_LOOK, mode: 'light' });
    expect(glassEnabled(parseLook({ mode: 'light' }))).toBe(true);
    expect(glassEnabled(parseLook({ glass: 'no' }))).toBe(true);
  });

  test('the switch is stored as a boolean', () => {
    expect(parseLook({ glass: false }).glass).toBe(false);
    expect(glassEnabled(parseLook({ glass: false }))).toBe(false);
    expect(glassEnabled(parseLook({ glass: true }))).toBe(true);
  });
});

/* ---------- text contrast on the glass tints (WCAG AA, 4.5:1) ---------- */

type Rgb = [number, number, number];
const css = await readFile(new URL('../src/components/os/os.css', import.meta.url), 'utf8');

/** Body of the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`missing rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}
function prop(body: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
  if (!m) throw new Error(`missing ${name}`);
  return m[1].trim();
}
function rgba(value: string): { rgb: Rgb; a: number } {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(value);
  if (!m) throw new Error(`not rgba: ${value}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: Number(m[4]) };
}
function hex(value: string): Rgb {
  const m = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(value);
  if (!m) throw new Error(`not hex: ${value}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
const over = (top: Rgb, a: number, bottom: Rgb): Rgb => [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)) as Rgb;
const clamp = (v: number) => Math.max(0, Math.min(255, v));
/** CSS saturate(s), applied to the backdrop before the tint. */
function saturate([r, g, b]: Rgb, s: number): Rgb {
  return [
    clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
  ];
}
function luminance(c: Rgb): number {
  const [r, g, b] = c.map(v => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The brightest blurred backdrop behind the chrome per theme: wallpaper bases with their glows
// composited on top (os.css, "wallpaper"), and the gradient wallpaper glowing in every accent.
const ACCENT_COLORS: Rgb[] = ['#c4532a', '#c2416b', '#6b4fd6', '#2f7fa8', '#3e8a5c', '#b8862b'].map(hex);
const DARK_WALLS: Rgb[] = [
  hex('#2a1d16'), over([240, 140, 90], 0.55, hex('#6b3140')), over([120, 170, 110], 0.3, hex('#17271d')),
  over([80, 160, 210], 0.35, hex('#0f2233')), over([80, 220, 170], 0.32, hex('#0b1020')), over([140, 110, 240], 0.34, hex('#0b1020')),
  ...ACCENT_COLORS.map(a => over(a, 0.28, hex('#2a1d16'))),
];
const LIGHT_WALLS: Rgb[] = [
  hex('#eadccf'), over([240, 150, 110], 0.5, hex('#f0b7a4')), hex('#cfe0c4'), hex('#bfd9ea'),
  ...ACCENT_COLORS.map(a => over(a, 0.28, hex('#f6ebe1'))),
];

describe('text contrast on glass', () => {
  const live = ".os-root:is([data-glass='liquid'], [data-glass='frost'])";
  const themes = [
    { name: 'dark', root: block(':root'), glass: block(live), sheen: '--lg-sheen-dark', walls: DARK_WALLS },
    { name: 'light', root: block(":root[data-zt='light']"), glass: block(`:root[data-zt='light'] ${live}`), sheen: '--lg-sheen-light', walls: LIGHT_WALLS },
  ];
  const sheenPeak = (name: string) => rgba(prop(block(live), name)).a;
  const menubarSaturation = Number(/saturate\(([\d.]+)\)/.exec(prop(block(`${live} .os-menubar`), 'backdrop-filter'))?.[1]);

  test('menu bar text stays AA over every wallpaper, accent and theme', () => {
    expect(menubarSaturation).toBeGreaterThan(1);
    for (const t of themes) {
      const tint = rgba(prop(t.glass, '--os-bar-bg'));
      const plain = rgba(prop(t.root, '--os-bar-bg'));
      // The glass tint is never thinner than the plain one.
      expect(tint.a).toBeGreaterThanOrEqual(plain.a);
      for (const wall of t.walls) {
        const bg = over([255, 255, 255], sheenPeak(t.sheen), over(tint.rgb, tint.a, saturate(wall, menubarSaturation)));
        for (const text of ['--os-fg', '--os-muted']) {
          expect({ theme: t.name, text, ratio: contrast(hex(prop(t.root, text)), bg) >= 4.5 }).toEqual({ theme: t.name, text, ratio: true });
        }
      }
    }
  });

  test('window titles stay AA on the refracting title bars, even over black or white', () => {
    // Only near-opaque windows get the thinned, refracting title bar; translucent glass windows keep their full tint.
    const rule = /\.os-root\[data-glass='liquid'\] (\.osw:is\([^)]*\)) > \.osw-bar \{ background-color: color-mix\(in srgb, var\(--osw-bg\) (\d+)%/.exec(css);
    expect(rule?.[1]).toBe(".osw:is(.osw--paper, .osw--stage, [data-app='ai'])");
    const mix = Number(rule?.[2]) / 100;
    expect(mix).toBeGreaterThan(0);
    const light = { text: hex('#231f1c'), sheen: sheenPeak('--lg-sheen-light') };
    const surfaces = [
      { ...light, bg: rgba(prop(block('.osw--paper'), '--osw-bg')) },
      { ...light, bg: rgba(prop(block(".osw[data-app='ai']"), '--os-glass')) },
      { text: hex('#f5efeb'), sheen: sheenPeak('--lg-sheen-dark'), bg: rgba(prop(block('.osw--stage'), '--osw-bg')) },
    ];
    const titleOpacity = Number(prop(block('.osw-title'), 'opacity'));
    for (const s of surfaces) {
      expect(s.bg.a).toBeGreaterThanOrEqual(0.95);
      for (const behind of [[0, 0, 0], [255, 255, 255], hex('#f5efeb')] satisfies Rgb[]) {
        const bar = over(s.bg.rgb, s.bg.a * mix, behind);
        for (const bg of [bar, over([255, 255, 255], s.sheen, bar)]) {
          expect(contrast(over(s.text, titleOpacity, bg), bg)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

/* ---------- the live tier in Zuey OS ---------- */

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
let React: ReactModule;
let client: ClientModule;
let os: typeof import('../src/components/os/ZueyOS');
let i18n: typeof import('../src/components/os/os-i18n');
const originalFetch = globalThis.fetch;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const profile: Profile = { id: 'p', name: 'Duy', handle: 'duy', email: 'duy@example.com', avatar_url: '/avatar.png', intro_en: 'Hi', intro_vi: 'Chào', theme: 'default' };

/** Media state the fake matchMedia answers from; `flip` notifies every live list, like a settings change. */
const media = { reducedMotion: false, reducedTransparency: false };
const lists = new Set<FakeMediaQueryList>();
// Captured before happy-dom replaces the globals: the fake lists extend the runtime EventTarget.
const RuntimeEvent = Event;
class FakeMediaQueryList extends EventTarget {
  constructor(readonly media: string) {
    super();
    lists.add(this);
  }
  get matches(): boolean {
    if (this.media.includes('prefers-reduced-motion: reduce')) return media.reducedMotion;
    if (this.media.includes('prefers-reduced-transparency: reduce')) return media.reducedTransparency;
    return false;
  }
  addListener(): void {}
  removeListener(): void {}
}
function flip(patch: Partial<typeof media>) {
  Object.assign(media, patch);
  React.act(() => { for (const l of lists) l.dispatchEvent(new RuntimeEvent('change')); });
}

function setChromium(on: boolean) {
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: on ? { brands: [{ brand: 'Chromium', version: '141' }] } : undefined });
}

/** Minimal Web Animation: finishes on the next task. */
class FakeAnimation extends EventTarget {
  onfinish: (() => void) | null = null;
  finished = Promise.resolve();
  constructor() {
    super();
    setTimeout(() => this.onfinish?.(), 0);
  }
  cancel(): void {}
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

async function mountOs(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(React.createElement(os.ZueyOS, { locale: 'en', profile, links: [], signedIn: false })));
  mounted.push({ root, container });
  await settle();
  return container;
}
function unmountAll() {
  for (const m of mounted.splice(0)) {
    React.act(() => m.root.unmount());
    m.container.remove();
  }
}
const tierOf = (root: HTMLElement) => root.querySelector('.os-root')?.getAttribute('data-glass');
const filtersOf = (root: HTMLElement) => Array.from(root.querySelectorAll('svg.os-lg-defs filter')).map(f => f.id);
const storedGlass = (): unknown => {
  const raw: unknown = JSON.parse(localStorage.getItem(LOOK_KEY) ?? '{}');
  return typeof raw === 'object' && raw !== null && 'glass' in raw ? raw.glass : undefined;
};

describe('Liquid Glass in Zuey OS', () => {
  beforeAll(async () => {
    GlobalRegistrator.register({ url: 'https://zuey.me/', width: 1440, height: 900 });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (q: string) => new FakeMediaQueryList(q) });
    Object.defineProperty(window.CSS, 'supports', { configurable: true, value: (p: string, v?: string) => p === 'backdrop-filter' && typeof v === 'string' });
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => new FakeAnimation() });
    React = await import('react');
    client = await import('react-dom/client');
    os = await import('../src/components/os/ZueyOS');
    i18n = await import('../src/components/os/os-i18n');
  });

  afterEach(() => {
    unmountAll();
    globalThis.fetch = originalFetch;
    Object.assign(media, { reducedMotion: false, reducedTransparency: false });
    lists.clear();
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  function offlineFetch() {
    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(JSON.stringify({ success: false, error: { code: 'unavailable', message: 'x' } }), { status: 503, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  }

  test('capabilities are read from the live browser', () => {
    setChromium(true);
    expect(readGlassCapabilities(window)).toEqual(DESKTOP_CHROMIUM);
    setChromium(false);
    expect(readGlassCapabilities(window).chromium).toBe(false);
  });

  test('Chromium renders the refraction filters; other engines get the fallback without them', async () => {
    offlineFetch();
    setChromium(true);
    const root = await mountOs();
    expect(tierOf(root)).toBe('liquid');
    expect(filtersOf(root)).toEqual(Object.values(GLASS_LENSES).map(l => l.id));
    unmountAll();

    setChromium(false);
    const other = await mountOs();
    expect(tierOf(other)).toBe('frost');
    expect(filtersOf(other)).toEqual([]);
  });

  test('reduced motion and reduced transparency remove the effect while they are on', async () => {
    offlineFetch();
    setChromium(true);
    const root = await mountOs();
    expect(tierOf(root)).toBe('liquid');
    flip({ reducedMotion: true });
    expect(tierOf(root)).toBe('off');
    expect(filtersOf(root)).toEqual([]);
    flip({ reducedMotion: false });
    expect(tierOf(root)).toBe('liquid');
    flip({ reducedTransparency: true });
    expect(tierOf(root)).toBe('off');
    expect(filtersOf(root)).toEqual([]);

    // Also on the fallback tier.
    unmountAll();
    setChromium(false);
    const other = await mountOs();
    expect(tierOf(other)).toBe('off');
    flip({ reducedTransparency: false });
    expect(tierOf(other)).toBe('frost');
  });

  test('the Appearance switch turns the glass off, is saved with the look and survives a reload', async () => {
    offlineFetch();
    setChromium(true);
    const s = i18n.osStrings('en').look;
    window.history.replaceState(null, '', '/#appearance');
    const root = await mountOs();
    const toggle = () => root.querySelector<HTMLButtonElement>('.osw[data-app="appearance"] [role="switch"]');
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    const labelId = toggle()?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(labelId)?.textContent).toBe(s.glass);
    expect(tierOf(root)).toBe('liquid');

    React.act(() => toggle()?.click());
    await settle(2);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(tierOf(root)).toBe('off');
    expect(filtersOf(root)).toEqual([]);
    expect(storedGlass()).toBe(false);

    // A new visit reads the saved look and keeps the glass off.
    unmountAll();
    const again = await mountOs();
    expect(tierOf(again)).toBe('off');
    const toggleAgain = again.querySelector<HTMLButtonElement>('.osw[data-app="appearance"] [role="switch"]');
    expect(toggleAgain?.getAttribute('aria-checked')).toBe('false');
    React.act(() => toggleAgain?.click());
    await settle(2);
    expect(tierOf(again)).toBe('liquid');
    expect(storedGlass()).toBe(true);
  });

  test('every locale labels the switch', () => {
    for (const locale of ['en', 'vi', 'zh', 'ko', 'ja'] as const) {
      const s = i18n.osStrings(locale).look;
      expect(s.glass.length).toBeGreaterThan(0);
      expect(s.glassHint.length).toBeGreaterThan(0);
    }
  });
});
