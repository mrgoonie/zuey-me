import type { Locale } from '../i18n/locales';

/** Font entry in the shape satori expects. */
export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500 | 600 | 700 | 800;
  style: 'normal';
}

/** Site typography (tailwind.config.mjs): Fraunces for headings, Plus Jakarta Sans for UI text. */
export const OG_SERIF = 'Fraunces';
export const OG_SANS = 'Plus Jakarta Sans';
/**
 * zh/ja/ko glyph fonts. Satori resolves one font per family name and falls back to fonts with *other*
 * names, so the CJK fonts need their own names; the template lists them after the Latin family.
 */
export const OG_SERIF_CJK = 'Fraunces CJK';
export const OG_SANS_CJK = 'Plus Jakarta Sans CJK';

/** Satori draws this when `lineClamp` cuts text, so every subset must contain it. */
const ELLIPSIS = '…';
/** Google Fonts subsets are usually fast but occasionally stall for many seconds. */
const FETCH_TIMEOUT_MS = 10_000;

interface FontSpec { family: string; name: string; weight: OgFont['weight'] }

/** Fraunces and Plus Jakarta Sans have no CJK glyphs; these families fill in for zh/ja/ko text. */
const CJK_FALLBACK: Partial<Record<Locale, { serif: string; sans: string }>> = {
  zh: { serif: 'Noto Serif SC', sans: 'Noto Sans SC' },
  ja: { serif: 'Noto Serif JP', sans: 'Noto Sans JP' },
  ko: { serif: 'Noto Serif KR', sans: 'Noto Sans KR' },
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Downloads one static TTF subset containing only `text`'s glyphs. Google Fonts serves TrueType to
 * clients without a browser User-Agent, which is the format satori and resvg can read.
 */
async function loadGoogleFont(fetcher: FetchLike, spec: FontSpec, text: string): Promise<OgFont | null> {
  const family = spec.family.replace(/ /g, '+');
  const cssUrl = `https://fonts.googleapis.com/css2?family=${family}:wght@${spec.weight}&text=${encodeURIComponent(text)}`;
  try {
    const css = await fetcher(cssUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then(r => (r.ok ? r.text() : ''));
    const src = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
    if (!src) return null;
    const res = await fetcher(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return { name: spec.name, data: await res.arrayBuffer(), weight: spec.weight, style: 'normal' };
  } catch {
    return null;
  }
}

/** Unique characters of the given strings (keeps subset requests small and the URL short). */
function glyphSet(...parts: string[]): string {
  return Array.from(new Set(Array.from(parts.join('') + ELLIPSIS))).filter(ch => ch.trim()).join('');
}

/**
 * Fonts for one card: serif text uses Fraunces, sans text uses Plus Jakarta Sans, and zh/ja/ko add a
 * matching Noto family under the CJK names. Throws when a family the card needs is missing, so a
 * broken image (tofu boxes) is never stored.
 */
export async function loadOgFonts(
  fetcher: FetchLike, locale: Locale, text: { serif: string; sans: string; sansBold: string },
): Promise<OgFont[]> {
  const serif = glyphSet(text.serif);
  const sans = glyphSet(text.sans);
  const sansBold = glyphSet(text.sansBold);
  const specs: Array<[FontSpec, string]> = [
    [{ family: OG_SERIF, name: OG_SERIF, weight: 800 }, serif],
    [{ family: OG_SANS, name: OG_SANS, weight: 500 }, sans],
    [{ family: OG_SANS, name: OG_SANS, weight: 700 }, sansBold],
  ];
  const cjk = CJK_FALLBACK[locale];
  if (cjk) {
    specs.push(
      [{ family: cjk.serif, name: OG_SERIF_CJK, weight: 800 }, serif],
      [{ family: cjk.sans, name: OG_SANS_CJK, weight: 500 }, sans],
      [{ family: cjk.sans, name: OG_SANS_CJK, weight: 700 }, sansBold],
    );
  }
  const fonts = await Promise.all(specs.map(([spec, chars]) => loadGoogleFont(fetcher, spec, chars)));
  const missing = specs.filter((_, i) => !fonts[i]).map(([spec]) => `${spec.family} ${spec.weight}`);
  if (missing.length) throw new Error(`Share image fonts could not be downloaded: ${missing.join(', ')}`);
  return fonts as OgFont[];
}
