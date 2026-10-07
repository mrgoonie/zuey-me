/**
 * Local preview of article share images: renders live published editions with the production template.
 * Usage: bun scripts/preview-article-og.ts <slug> <outDir> [origin]
 */
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { articleOgCard } from '../src/lib/og/article-og-card';
import { articleOgTemplate, articleOgText } from '../src/lib/og/article-og-template';
import { loadOgFonts } from '../src/lib/og/og-fonts';
import { LOCALES } from '../src/lib/i18n/locales';

const [slug, outDir, origin = 'https://zuey.me'] = process.argv.slice(2);
if (!slug || !outDir) throw new Error('Usage: bun scripts/preview-article-og.ts <slug> <outDir> [origin]');
mkdirSync(outDir, { recursive: true });
for (const locale of LOCALES) {
  const res = await fetch(`${origin}/api/v1/articles/${slug}?lang=${locale}`);
  const json = await res.json() as { data?: Parameters<typeof articleOgCard>[0] };
  if (!json.data || json.data.locale !== locale) continue;
  const card = articleOgCard(json.data);
  const started = performance.now();
  const fonts = await loadOgFonts(fetch, locale, articleOgText(card));
  const fetched = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svg = await satori(articleOgTemplate(card, 'https://cdn.zuey.me/avatar.png') as any, { width: 1200, height: 630, fonts });
  const laidOut = performance.now();
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  const done = performance.now();
  writeFileSync(`${outDir}/${slug}-${locale}.png`, png);
  console.log(`${locale}: ${png.length} bytes; fonts ${Math.round(fetched - started)}ms, satori ${Math.round(laidOut - fetched)}ms, resvg ${Math.round(done - laidOut)}ms`);
}
