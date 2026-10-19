#!/usr/bin/env node
/**
 * Browser smoke for the public pages of an article: every requested locale at a mobile and a desktop
 * viewport. It loads the page, fails on uncaught page errors and console errors, requires the
 * interactive widget frames and Mermaid diagrams to appear, takes a full-page screenshot and compares it
 * byte for byte with the stored baseline.
 *
 *   node scripts/article-widget-smoke.mjs --base https://zuey.me --slug my-article --locales vi,en,zh,ko,ja
 *   node scripts/article-widget-smoke.mjs --base http://localhost:4321 --slug my-article --update
 *
 * Options: --out <dir> (default .smoke/<slug>), --update (accept current screenshots as the baseline),
 * --expect-widgets <n> (interactive frames each page must show, default: at least 0).
 * Needs playwright-core and a Chromium binary (CHROMIUM_PATH, default /opt/pw-browsers/chromium).
 * Exit code 1 when any check fails or a screenshot differs from its baseline.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const base = String(arg('base', 'http://localhost:4321')).replace(/\/$/, '');
const slug = arg('slug');
const locales = String(arg('locales', 'vi')).split(',').map(s => s.trim()).filter(Boolean);
const outDir = String(arg('out', path.join('.smoke', String(slug))));
const update = arg('update', false) === true;
const expectWidgets = Number(arg('expect-widgets', 0));
if (!slug || slug === true) {
  console.error('usage: article-widget-smoke.mjs --base <url> --slug <slug> [--locales vi,en] [--out dir] [--update] [--expect-widgets n]');
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run it once with: bunx --bun -p playwright-core node scripts/article-widget-smoke.mjs ...');
  process.exit(2);
}

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];
const executablePath = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
let failures = 0;
const report = [];

for (const locale of locales) {
  for (const viewport of VIEWPORTS) {
    const label = `${locale}/${viewport.name}`;
    const problems = [];
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    page.on('pageerror', err => problems.push(`page error: ${err.message}`));
    page.on('console', msg => { if (msg.type() === 'error') problems.push(`console error: ${msg.text().slice(0, 200)}`); });
    const response = await page.goto(`${base}/articles/${slug}?lang=${locale}`, { waitUntil: 'networkidle' }).catch(err => {
      problems.push(`navigation failed: ${err.message}`);
      return null;
    });
    if (response && response.status() !== 200) problems.push(`HTTP ${response.status()}`);
    if (response) {
      const widgets = await page.locator('iframe[sandbox*="allow-scripts"]').count();
      if (widgets < expectWidgets) problems.push(`expected ${expectWidgets} interactive frames, found ${widgets}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (overflow) problems.push('page scrolls horizontally');
      const shot = await page.screenshot({ fullPage: true });
      const file = path.join(outDir, `${locale}-${viewport.name}.png`);
      const hash = createHash('sha256').update(shot).digest('hex');
      await mkdir(outDir, { recursive: true });
      const baseline = await readFile(file).then(buf => createHash('sha256').update(buf).digest('hex'), () => null);
      if (update || baseline === null) await writeFile(file, shot);
      else if (baseline !== hash) {
        await writeFile(file.replace(/\.png$/, '.changed.png'), shot);
        problems.push(`screenshot differs from baseline (${path.basename(file).replace(/\.png$/, '.changed.png')} written)`);
      }
      report.push({ label, widgets, screenshot: hash.slice(0, 12), baseline: update || baseline === null ? 'written' : baseline === hash ? 'same' : 'changed' });
    }
    await page.close();
    if (problems.length) { failures += 1; console.error(`FAIL ${label}\n  - ${problems.join('\n  - ')}`); }
    else console.log(`ok   ${label}`);
  }
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
process.exit(failures ? 1 : 0);
