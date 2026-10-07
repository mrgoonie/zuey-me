/**
 * Workers-side PNG renderer for article share cards. Cloudflare forbids compiling WebAssembly from
 * bytes at runtime, so both engines receive precompiled modules imported with `?module`
 * (supported by @astrojs/cloudflare). Only server routes and background jobs import this file.
 */
import satori, { init as initSatori } from 'satori/standalone';
import yogaWasm from 'satori/yoga.wasm?module';
import { Resvg, initWasm as initResvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm?module';
import type { ArticleOgCard } from './article-og-card';
import { OG_HEIGHT, OG_WIDTH } from './article-og-card';
import { articleOgTemplate, articleOgText } from './article-og-template';
import type { FetchLike } from './og-fonts';
import { loadOgFonts } from './og-fonts';

const AVATAR_URL = 'https://cdn.zuey.me/avatar.png';

let ready: Promise<void> | null = null;

/** Instantiates both wasm engines once per isolate; a failed init is retried on the next call. */
function ensureEngines(): Promise<void> {
  ready ??= Promise.all([initSatori(yogaWasm), initResvg(resvgWasm)]).then(() => undefined).catch(err => {
    ready = null;
    throw err;
  });
  return ready;
}

/** Draws one card: card → satori SVG → resvg PNG (1200×630). */
export async function renderArticleOgPng(card: ArticleOgCard, fetcher: FetchLike = fetch): Promise<Uint8Array> {
  const [fonts] = await Promise.all([loadOgFonts(fetcher, card.locale, articleOgText(card)), ensureEngines()]);
  const svg = await satori(articleOgTemplate(card, AVATAR_URL) as Parameters<typeof satori>[0], {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts,
  });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } });
  const image = resvg.render();
  try {
    return image.asPng();
  } finally {
    image.free();
    resvg.free();
  }
}
