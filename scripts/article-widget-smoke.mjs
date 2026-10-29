#!/usr/bin/env node
/**
 * Browser smoke for the public pages of an article: every requested locale at a mobile and a desktop
 * viewport. It loads the page, scrolls through it so every widget reaches the viewport, fails on uncaught
 * page errors and console errors, and requires the interactive widgets to start by themselves (widget
 * frames only, `.zif iframe`; social embeds are counted separately). Widgets past the per-page cap of
 * auto-started frames must show the click-to-run note instead. The screenshot is taken in a second page with
 * `prefers-reduced-motion: reduce`, where widgets stay click-to-run, so live widget output never makes the
 * baseline flaky; it is compared byte for byte with the stored baseline.
 *
 *   node scripts/article-widget-smoke.mjs --base https://zuey.me --slug my-article --locales vi,en,zh,ko,ja
 *   node scripts/article-widget-smoke.mjs --base http://localhost:4321 --slug my-article --update
 *
 * Options: --out <dir> (default .smoke/<slug>), --update (accept current screenshots as the baseline),
 * --expect-widgets <n> (interactive widgets each page must contain, default: at least 0).
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

/** Opens every toggle, scrolls to the bottom in viewport steps, then waits until every widget is running or capped. */
async function startEveryWidget(page) {
  await page.evaluate(async () => {
    const pause = ms => new Promise(r => setTimeout(r, ms));
    // Widgets in a closed toggle wait for the reader to open it.
    for (const details of document.querySelectorAll('details:not([open])')) details.open = true;
    for (let y = 0; y <= document.documentElement.scrollHeight; y += Math.round(window.innerHeight * 0.8)) {
      window.scrollTo(0, y);
      await pause(250);
    }
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('figure.zif')].every(f => Boolean(f.dataset.state)),
    null,
    { timeout: 15000 },
  ).catch(() => {});
  return page.evaluate(() => {
    const figures = [...document.querySelectorAll('figure.zif')];
    return {
      widgets: figures.length,
      running: document.querySelectorAll('figure.zif iframe').length,
      capped: figures.filter(f => f.dataset.state === 'capped').length,
      idle: figures.filter(f => !f.dataset.state).map(f => f.querySelector('.zif-title')?.textContent ?? ''),
      unresponsive: figures.filter(f => f.dataset.state === 'unresponsive').map(f => f.querySelector('.zif-title')?.textContent ?? ''),
      navigated: figures.filter(f => f.dataset.state === 'navigated').map(f => f.querySelector('.zif-title')?.textContent ?? ''),
      embeds: document.querySelectorAll('.zb-embed iframe').length,
    };
  });
}

for (const locale of locales) {
  for (const viewport of VIEWPORTS) {
    const label = `${locale}/${viewport.name}`;
    const problems = [];
    const url = `${base}/articles/${slug}?lang=${locale}`;
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    page.on('pageerror', err => problems.push(`page error: ${err.message}`));
    page.on('console', msg => { if (msg.type() === 'error') problems.push(`console error: ${msg.text().slice(0, 200)}`); });
    const response = await page.goto(url, { waitUntil: 'networkidle' }).catch(err => {
      problems.push(`navigation failed: ${err.message}`);
      return null;
    });
    if (response && response.status() !== 200) problems.push(`HTTP ${response.status()}`);
    if (response) {
      const counts = await startEveryWidget(page);
      const { widgets, running, capped, idle, unresponsive, navigated, embeds } = counts;
      if (widgets < expectWidgets) problems.push(`expected ${expectWidgets} interactive widgets, found ${widgets}`);
      if (idle.length) problems.push(`widgets that did not start after scrolling: ${idle.join(', ')}`);
      if (unresponsive.length) problems.push(`widgets halted by the watchdog: ${unresponsive.join(', ')}`);
      if (navigated.length) problems.push(`widgets halted for navigating their own frame: ${navigated.join(', ')}`);
      if (running + capped < widgets) problems.push(`only ${running} of ${widgets} widgets running (${capped} past the auto-start cap)`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (overflow) problems.push('page scrolls horizontally');
      // Deterministic screenshot: reduced motion keeps every widget click-to-run and the saved click-to-load
      // choice keeps third-party embeds behind their button, so no live output is captured.
      const still = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
      await still.addInitScript(() => { try { localStorage.setItem('zuey:embeds', 'click'); } catch {} });
      await still.goto(url, { waitUntil: 'networkidle' });
      if (await still.locator('figure.zif iframe').count()) problems.push('a widget started despite prefers-reduced-motion: reduce');
      const shot = await still.screenshot({ fullPage: true, animations: 'disabled' });
      await still.close();
      const file = path.join(outDir, `${locale}-${viewport.name}.png`);
      const hash = createHash('sha256').update(shot).digest('hex');
      await mkdir(outDir, { recursive: true });
      const baseline = await readFile(file).then(buf => createHash('sha256').update(buf).digest('hex'), () => null);
      if (update || baseline === null) await writeFile(file, shot);
      else if (baseline !== hash) {
        await writeFile(file.replace(/\.png$/, '.changed.png'), shot);
        problems.push(`screenshot differs from baseline (${path.basename(file).replace(/\.png$/, '.changed.png')} written)`);
      }
      report.push({ label, widgets, running, capped, embeds, screenshot: hash.slice(0, 12), baseline: update || baseline === null ? 'written' : baseline === hash ? 'same' : 'changed' });
    }
    await page.close();
    if (problems.length) { failures += 1; console.error(`FAIL ${label}\n  - ${problems.join('\n  - ')}`); }
    else console.log(`ok   ${label}`);
  }
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
process.exit(failures ? 1 : 0);
