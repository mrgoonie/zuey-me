import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import {
  GLASS_LENSES, displacementMap, glassTier, isChromiumEngine, readEngineCapabilities, type GlassCapabilities,
} from '../src/components/os/liquid-glass';
import { ACCENTS, DEFAULT_LOOK, LOOK_KEY, glassEnabled, parseLook } from '../src/components/os/look';
import { FakeAnimation, profile, trackHashChanges, waitFor } from './helpers/zueyos';

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

/** Every rule in os.css (comments dropped), with nested @media / @supports rules flattened. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
const tokens = { dark: block(':root'), light: block(":root[data-zt='light']") };

/**
 * Blurred backdrops behind the chrome, read from the wallpaper rules in os.css: every base colour of each
 * wallpaper, and each glow (rgba or accent mix, in every accent) composited over every base colour.
 * Light theme: the light wallpaper overrides plus the shared rules built on the theme's wall tokens.
 */
function wallpaperBackdrops(theme: 'dark' | 'light'): Rgb[] {
  const walls = [hex(prop(tokens[theme], '--os-wall-1')), hex(prop(tokens[theme], '--os-wall-2'))];
  const values = [...css.matchAll(/^:root(\[data-zt='light'\])?(\[data-wp='\w+'\])? \{ --os-wp: (.+); \}$/gm)]
    .filter(m => m[1] ? theme === 'light' : theme === 'dark' || m[2] === undefined || m[3].includes('var(--os-wall'))
    .map(m => m[3]);
  expect(values.length).toBeGreaterThan(theme === 'dark' ? 6 : 4);
  const out: Rgb[] = [];
  for (const value of values) {
    const bases = [...value.matchAll(/#[0-9a-f]{6}/gi)].map(m => hex(m[0]));
    if (value.includes('var(--os-wall')) bases.push(...walls);
    const glows = [...value.matchAll(/rgba\([^)]+\)/g)].map(m => rgba(m[0]));
    for (const m of value.matchAll(/var\(--accent(-hi)?\) (\d+)%/g)) {
      for (const [accent, , hi] of Object.values(ACCENTS)) glows.push({ rgb: hex(m[1] ? hi : accent), a: Number(m[2]) / 100 });
    }
    for (const base of bases) out.push(base, ...glows.map(g => over(g.rgb, g.a, base)));
  }
  return out;
}
const px = (value: string, re: RegExp): number => {
  const m = re.exec(value);
  if (!m) throw new Error(`no ${re} in ${value}`);
  return Number(m[1]);
};

describe('text contrast on glass', () => {
  const live = ".os-root:is([data-glass='liquid'], [data-glass='frost'])";
  const themes = [
    { name: 'dark', root: tokens.dark, glass: block(live), sheen: '--lg-sheen-dark', walls: wallpaperBackdrops('dark') },
    { name: 'light', root: tokens.light, glass: block(`:root[data-zt='light'] ${live}`), sheen: '--lg-sheen-light', walls: wallpaperBackdrops('light') },
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

  test('window titles keep at least the plain chrome contrast: the highlight and the thin rims stay off the text', () => {
    // Title line box inside the 42px bar: 12px type on the root's 1.5 line height, centred.
    const barHeight = px(prop(block('.osw-bar'), 'height'), /^(\d+)px$/);
    const lineHeight = Number(prop(block('.os-root'), 'line-height'));
    const fontSize = px(prop(block('.osw-title'), 'font'), /(\d+)px/);
    const textTop = (barHeight - fontSize * lineHeight) / 2;
    const textBottom = barHeight - textTop;

    // Both live tiers: the title-bar highlight has faded out before the text starts.
    for (const cap of ['--lg-cap-dark', '--lg-cap-light']) expect(px(prop(block(live), cap), /0\) (\d+)px\)$/)).toBeLessThanOrEqual(textTop);

    // Liquid: near-opaque windows tint their title bar with the full window colour across the text band,
    // exactly the tint the plain frame puts behind the title, and thin it only at the top and bottom rims.
    const titleRule = rules.find(r => r.selector === ".os-root[data-glass='liquid'] .osw:is(.osw--paper, .osw--stage, [data-app='ai']) > .osw-bar");
    const tint = prop(titleRule?.body ?? '', 'background-image');
    expect(px(tint, /var\(--osw-bg\) (\d+)px, var\(--osw-bg\) calc/)).toBeLessThanOrEqual(textTop);
    expect(barHeight - px(tint, /var\(--osw-bg\) calc\(100% - (\d+)px\)/)).toBeGreaterThanOrEqual(textBottom);

    // That tint alone, with the title's own opacity, is AA even over black or white.
    const titleOpacity = Number(prop(block('.osw-title'), 'opacity'));
    const surfaces = [
      { text: hex('#231f1c'), bg: rgba(prop(block('.osw--paper'), '--osw-bg')) },
      { text: hex('#1c1917'), bg: rgba(prop(block(".osw[data-app='ai']"), '--os-glass')) },
      { text: hex('#f5efeb'), bg: rgba(prop(block('.osw--stage'), '--osw-bg')) },
    ];
    for (const s of surfaces) {
      for (const behind of [[0, 0, 0], [255, 255, 255], hex('#f5efeb')] satisfies Rgb[]) {
        const bg = over(s.bg.rgb, s.bg.a, behind);
        expect(contrast(over(s.text, titleOpacity, bg), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('the Appearance switch reads at 3:1 when off and when on', () => {
    const track = block('.os-ap-switch');
    const thumb = block('.os-ap-switch > span');
    expect(prop(track, 'box-shadow')).toBe('inset 0 0 0 2px var(--os-muted)');
    expect(prop(thumb, 'background')).toBe('var(--os-muted)');
    // Off: the muted ring and thumb against the glass panel, whatever is behind the panel.
    for (const theme of ['dark', 'light'] as const) {
      const muted = hex(prop(tokens[theme], '--os-muted'));
      const panel = rgba(prop(tokens[theme], '--os-glass'));
      for (const behind of [[0, 0, 0], [255, 255, 255]] satisfies Rgb[]) {
        expect({ theme, ratio: contrast(muted, over(panel.rgb, panel.a, behind)) >= 3 }).toEqual({ theme, ratio: true });
      }
    }
    // On: the white thumb against the accent track, in every accent.
    expect(prop(block(".os-ap-switch[aria-checked='true'] > span"), 'background')).toBe('#fff');
    for (const [accent] of Object.values(ACCENTS)) expect(contrast([255, 255, 255], hex(accent))).toBeGreaterThanOrEqual(3);
  });
});

describe('glass never breaks window contents or dragging', () => {
  test('no rule gives a window body a containing block for fixed overlays', () => {
    // backdrop-filter, filter, transform and friends on .osw-body would trap `position: fixed` modals
    // (the referral QR code) inside the scrolling body, off-screen.
    const trapping = /(?<![\w-])(?:-webkit-)?(backdrop-filter|filter|transform|will-change|perspective|contain)\s*:/;
    const bodyRules = rules.filter(r => r.selector.split(',').some(s => /\.osw-body(?::[\w-]+(?:\([^)]*\))?)*$/.test(s.trim())));
    expect(bodyRules.some(r => r.selector.includes("[data-glass='liquid']"))).toBe(true);
    for (const r of bodyRules) expect({ selector: r.selector, trapping: trapping.exec(r.body)?.[1] ?? null }).toEqual({ selector: r.selector, trapping: null });
  });

  test('a window being dragged or resized drops its refraction lens and keeps the blur', () => {
    const lensed = rules.filter(r => r.selector.includes('.osw') && /url\(#zos-lg-(?:panel|title)\)/.test(r.body));
    expect(lensed.length).toBe(2);
    for (const r of lensed) {
      const [frame, ...child] = r.selector.split(' > ');
      const selector = [`${frame}:is(.is-dragging, .is-resizing)`, ...child].join(' > ');
      const moving = rules.find(m => m.selector === selector);
      expect(moving?.selector).toBe(selector);
      const still = prop(r.body, 'backdrop-filter');
      expect(prop(moving?.body ?? '', 'backdrop-filter')).toBe(still.replace(/\s*url\([^)]*\)/, ''));
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

setDefaultTimeout(30_000);


/** Mounts the desktop and waits until its root (and anything `ready` checks, named by `condition`) is on screen. */
async function mountOs(ready: (root: HTMLElement) => boolean = () => true, condition = 'desktop'): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(React.createElement(os.ZueyOS, { locale: 'en', profile, links: [], signedIn: false })));
  mounted.push({ root, container });
  await waitFor(`mounted: ${condition}`, () => tierOf(container) != null && ready(container));
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
    trackHashChanges();
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

  test('engine capabilities are read from the live browser', () => {
    setChromium(true);
    expect(readEngineCapabilities(window)).toEqual({ chromium: true, backdropFilter: true });
    setChromium(false);
    expect(readEngineCapabilities(window).chromium).toBe(false);
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
    const switchOf = (r: HTMLElement) => r.querySelector<HTMLButtonElement>('.osw[data-app="appearance"] [role="switch"]');
    const root = await mountOs(r => switchOf(r) !== null, 'Appearance switch');
    const toggle = () => switchOf(root);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    const labelId = toggle()?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(labelId)?.textContent).toBe(s.glass);
    expect(tierOf(root)).toBe('liquid');

    React.act(() => toggle()?.click());
    await waitFor('glass switched off and saved', () => toggle()?.getAttribute('aria-checked') === 'false' && tierOf(root) === 'off' && storedGlass() === false);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(tierOf(root)).toBe('off');
    expect(filtersOf(root)).toEqual([]);
    expect(storedGlass()).toBe(false);

    // A new visit reads the saved look and keeps the glass off.
    unmountAll();
    const again = await mountOs(r => switchOf(r) !== null, 'Appearance switch after reload');
    expect(tierOf(again)).toBe('off');
    const toggleAgain = switchOf(again);
    expect(toggleAgain?.getAttribute('aria-checked')).toBe('false');
    React.act(() => toggleAgain?.click());
    await waitFor('glass switched back on and saved', () => tierOf(again) === 'liquid' && storedGlass() === true);
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
