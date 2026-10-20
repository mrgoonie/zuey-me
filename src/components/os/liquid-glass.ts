import { useEffect, useState } from 'react';

/**
 * Liquid Glass material for the Zuey OS chrome (menubar, dock, window chrome, Appearance window).
 *
 * The tier is written to `.os-root[data-glass]` once the island has hydrated, so the first paint is
 * the plain chrome and the glass never competes with LCP:
 * - `liquid`: Chromium on a desktop-sized, fine-pointer screen. Real refraction through an SVG
 *   `feDisplacementMap` referenced from `backdrop-filter: url(#…)` (only Chromium applies SVG
 *   filters to the backdrop), plus the specular highlight.
 * - `frost`: every other browser and every phone or touch device: `backdrop-filter` blur with
 *   saturation plus the highlight. No SVG filter is rendered or referenced.
 * - `off`: the visitor switched it off in Appearance, or the system asks for reduced motion or
 *   reduced transparency: the chrome stays exactly as it is without glass.
 */
export type GlassTier = 'liquid' | 'frost' | 'off';

export interface GlassCapabilities {
  /** The Blink engine (Chrome, Edge, Opera, Brave, Arc…), the only one that refracts the backdrop. */
  chromium: boolean;
  /** Unprefixed `backdrop-filter` support. */
  backdropFilter: boolean;
  /** A phone-sized viewport or a coarse (touch) pointer: kept on the cheap tier. */
  compact: boolean;
  reducedMotion: boolean;
  reducedTransparency: boolean;
}

export const GLASS_QUERIES = {
  reducedMotion: '(prefers-reduced-motion: reduce)',
  reducedTransparency: '(prefers-reduced-transparency: reduce)',
  compact: '(max-width: 767px), (pointer: coarse)',
} as const;

/** Picks the tier. Accessibility preferences and the visitor's switch always win over capability. */
export function glassTier(enabled: boolean, caps: GlassCapabilities): GlassTier {
  if (!enabled || caps.reducedMotion || caps.reducedTransparency) return 'off';
  if (caps.chromium && caps.backdropFilter && !caps.compact) return 'liquid';
  return 'frost';
}

/**
 * Engine check through User-Agent Client Hints: `navigator.userAgentData` exists only in Chromium
 * builds, and its brand list names "Chromium" for every Blink browser. Firefox and Safari (and
 * Chrome on iOS, which is WebKit) have no `userAgentData`, so they never get the SVG filter.
 */
export function isChromiumEngine(nav: object): boolean {
  const data: unknown = Reflect.get(nav, 'userAgentData');
  if (typeof data !== 'object' || data === null || !('brands' in data) || !Array.isArray(data.brands)) return false;
  return data.brands.some((b: unknown) => typeof b === 'object' && b !== null && 'brand' in b && b.brand === 'Chromium');
}

function supportsBackdrop(win: Window): boolean {
  const css: unknown = Reflect.get(win, 'CSS');
  if (typeof css !== 'object' || css === null || !('supports' in css) || typeof css.supports !== 'function') return false;
  try {
    return css.supports('backdrop-filter', 'blur(1px)') === true;
  } catch {
    return false;
  }
}

function matches(win: Window, query: string): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia(query).matches;
}

/** Reads the capabilities from the live browser. Client-only. */
export function readGlassCapabilities(win: Window = window): GlassCapabilities {
  return {
    chromium: isChromiumEngine(win.navigator),
    backdropFilter: supportsBackdrop(win),
    compact: matches(win, GLASS_QUERIES.compact),
    reducedMotion: matches(win, GLASS_QUERIES.reducedMotion),
    reducedTransparency: matches(win, GLASS_QUERIES.reducedTransparency),
  };
}

/**
 * Live glass tier. Starts `off` (also during SSR and hydration) and follows the switch and the
 * media queries afterwards, so turning on reduced motion or transparency removes the effect at once.
 */
export function useGlassTier(enabled: boolean): GlassTier {
  const [tier, setTier] = useState<GlassTier>('off');
  useEffect(() => {
    const update = () => setTier(glassTier(enabled, readGlassCapabilities(window)));
    update();
    if (typeof window.matchMedia !== 'function') return;
    const lists = Object.values(GLASS_QUERIES).map(q => window.matchMedia(q));
    for (const mq of lists) mq.addEventListener('change', update);
    return () => { for (const mq of lists) mq.removeEventListener('change', update); };
  }, [enabled]);
  return tier;
}

/** One refraction lens: the edge band (fraction of width and height) and the bend in px. */
export interface GlassLens {
  id: string;
  bandX: number;
  bandY: number;
  scale: number;
}

/**
 * Lenses per chrome shape. Each displacement map is stretched over the element, so the bands are
 * fractions chosen for its usual size: about 20 px of curved rim on every side.
 */
export const GLASS_LENSES = {
  bar: { id: 'zos-lg-bar', bandX: 0.015, bandY: 0.32, scale: 22 },
  dock: { id: 'zos-lg-dock', bandX: 0.05, bandY: 0.3, scale: 28 },
  title: { id: 'zos-lg-title', bandX: 0.03, bandY: 0.34, scale: 22 },
  panel: { id: 'zos-lg-panel', bandX: 0.045, bandY: 0.04, scale: 36 },
} as const satisfies Record<string, GlassLens>;

/**
 * Displacement map for one axis as an SVG data URL: neutral grey-level 128 in the middle, rising to
 * 255 at the leading edge and falling to 0 at the trailing edge, so the edges sample the backdrop
 * from further inside, like the rim of a convex lens. Red drives x, green drives y.
 */
export function displacementMap(axis: 'x' | 'y', band: number): string {
  const b = Math.min(0.5, Math.max(0, band)) * 100;
  const color = (v: number) => (axis === 'x' ? `rgb(${v},0,0)` : `rgb(0,${v},0)`);
  const stops: [number, number][] = [[0, 255], [b * 0.3, 190], [b, 128], [100 - b, 128], [100 - b * 0.3, 66], [100, 0]];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none">`
    + `<linearGradient id="g" x2="${axis === 'x' ? 1 : 0}" y2="${axis === 'y' ? 1 : 0}">`
    + stops.map(([o, v]) => `<stop offset="${o.toFixed(2)}%" stop-color="${color(v)}"/>`).join('')
    + `</linearGradient><rect width="100" height="100" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
