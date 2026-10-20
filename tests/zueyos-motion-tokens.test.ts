import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { motionEase, motionMs, parseCssTime } from '../src/components/home/motion';

// Motion tokens are the only durations and easings Zuey OS chrome uses; reduced motion zeroes them.

const root = join(import.meta.dir, '..');
const osCss = readFileSync(join(root, 'src/components/os/os.css'), 'utf8');
const homeCss = readFileSync(join(root, 'src/components/home/home.css'), 'utf8');
const activityCss = readFileSync(join(root, 'src/components/activity-monitor/activity-monitor.css'), 'utf8');
const DURATIONS = ['instant', 'fast', 'base', 'slow', 'slower'];
const EASINGS = ['standard', 'out', 'in', 'spring', 'genie'];

/** Body of the first top-level `@media (prefers-reduced-motion: reduce)` block that zeroes tokens. */
function reducedBlock(css: string): string {
  const start = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  return start < 0 ? '' : css.slice(start);
}

/** Every `transition` / `animation` declaration value in a stylesheet. */
function motionDeclarations(css: string): string[] {
  return Array.from(css.matchAll(/(?:^|[;{\s])(transition|animation)\s*:\s*([^;}]+)/g), m => m[2].trim());
}

describe('motion tokens', () => {
  test('each duration and easing token is defined once in os.css', () => {
    for (const d of DURATIONS) {
      const defs = osCss.match(new RegExp(`--motion-dur-${d}:\\s*\\d+ms`, 'g')) ?? [];
      // One real value plus its zero under reduced motion.
      expect(defs.length).toBe(2);
    }
    for (const e of EASINGS) expect((osCss.match(new RegExp(`--motion-ease-${e}:`, 'g')) ?? []).length).toBe(1);
  });

  test('OS chrome transitions use tokens, never ad-hoc durations or easings', () => {
    for (const [name, css] of [['os.css', osCss], ['home.css', homeCss], ['activity-monitor.css', activityCss]] as const) {
      for (const value of motionDeclarations(css)) {
        if (value === 'none' || value.startsWith('none ')) continue;
        // Long ambient loops (aurora, clouds, shimmer, entrance fallback) are keyframe animations, not chrome feedback.
        if (/^(os-aurora|home-cloud-drift|home-shimmer|home-reveal-fallback|am-pulse)\b/.test(value)) continue;
        const stripped = value.replace(/var\([^()]*\)/g, '').replace(/calc\([^()]*\)/g, '');
        expect({ file: name, value, raw: /\d*\.?\d+m?s\b|cubic-bezier|\bease(-in|-out|-in-out)?\b/.test(stripped) }).toEqual({ file: name, value, raw: false });
      }
    }
  });

  test('windows never transition layout properties', () => {
    for (const m of osCss.matchAll(/\.osw[^{]*\{([^}]*)\}/g)) {
      const transition = /transition:\s*([^;]+)/.exec(m[1])?.[1] ?? '';
      expect(transition).not.toMatch(/\b(left|top|width|height)\b/);
    }
  });

  test('reduced motion zeroes every duration token and stops view transitions', () => {
    const block = reducedBlock(osCss);
    for (const d of DURATIONS) expect(block).toContain(`--motion-dur-${d}: 0ms`);
    expect(block).toContain('::view-transition-old(*)');
    expect(homeCss).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.home-skeleton\s*\{\s*animation:\s*none/);
  });

  test('no motion library is bundled into the OS shell', () => {
    const dir = join(root, 'src/components/os');
    const sources = [...readdirSync(dir).filter(f => /\.tsx?$/.test(f)).map(f => readFileSync(join(dir, f), 'utf8')),
      readFileSync(join(root, 'src/components/feedback/Toaster.tsx'), 'utf8')];
    for (const src of sources) expect(src).not.toMatch(/from ['"](framer-motion|motion|gsap|animejs|react-spring)['"]/);
  });
});

describe('motion token readers', () => {
  test('parseCssTime reads ms and s, rejects anything else', () => {
    expect(parseCssTime('180ms')).toBe(180);
    expect(parseCssTime('.2s')).toBe(200);
    expect(parseCssTime(' 0ms ')).toBe(0);
    expect(parseCssTime('fast')).toBeNull();
    expect(parseCssTime('')).toBeNull();
    expect(parseCssTime('-5ms')).toBeNull();
  });

  test('without a document the fallbacks apply', () => {
    expect(motionMs('slow', 340)).toBe(340);
    expect(motionEase('out', 'ease-out')).toBe('ease-out');
  });
});
