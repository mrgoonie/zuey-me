import { describe, expect, test } from 'bun:test';
import { appFromHash } from '../src/components/os/apps';
import { DEFAULT_LOOK, LOOK_BOOT_SCRIPT, parseLook } from '../src/components/os/look';
import {
  BOOT_APPS, GAP, defaultRect, expoLayout, fitRect, initialWins, modeRect, placedRect, topId, visibleIds, winReducer, type Area,
} from '../src/components/os/window-store';

const AREA: Area = { w: 1440, h: 860, b: 790 };

describe('Zuey OS window store', () => {
  test('boot windows are About and Zuey AI, AI on top', () => {
    const wins = initialWins();
    expect(BOOT_APPS).toEqual(['about', 'ai']);
    expect(visibleIds(wins)).toEqual(['about', 'ai']);
    expect(topId(wins)).toBe('ai');
    expect(wins.pricing.mounted).toBe(false);
  });

  test('open focuses, minimize hides, close keeps the window mounted', () => {
    let wins = winReducer(initialWins(), { type: 'open', id: 'pricing' });
    expect(topId(wins)).toBe('pricing');
    wins = winReducer(wins, { type: 'minimize', id: 'pricing' });
    expect(topId(wins)).toBe('ai');
    expect(wins.pricing.open).toBe(true);
    wins = winReducer(wins, { type: 'open', id: 'pricing' });
    expect(wins.pricing.min).toBe(false);
    wins = winReducer(wins, { type: 'close', id: 'pricing' });
    expect(wins.pricing).toMatchObject({ open: false, mounted: true });
  });

  test('focus on the top window is a no-op', () => {
    const wins = initialWins();
    expect(winReducer(wins, { type: 'focus', id: 'ai' })).toBe(wins);
  });

  test('restore applies saved layout and the open list', () => {
    const rect = { x: 100, y: 40, w: 600, h: 500 };
    const wins = winReducer(initialWins(), { type: 'restore', open: ['github'], layout: { github: { rect, mode: 'left' } } });
    expect(visibleIds(wins)).toEqual(['github']);
    expect(wins.github).toMatchObject({ rect, mode: 'left', mounted: true });
    expect(wins.about.open).toBe(false);
  });

  test('fitRect keeps windows inside the work area and above the app minimum', () => {
    const r = fitRect({ x: -50, y: 2000, w: 100, h: 50 }, 'ai', AREA);
    expect(r.x).toBeGreaterThanOrEqual(GAP);
    expect(r.y + r.h).toBeLessThanOrEqual(AREA.b);
    expect(r.w).toBeGreaterThan(100);
  });

  test('snap modes split the screen in halves and zoom fills it', () => {
    const left = modeRect('left', AREA);
    const right = modeRect('right', AREA);
    expect(left.x).toBe(GAP);
    expect(right.x + right.w).toBe(AREA.w - GAP);
    expect(right.x - (left.x + left.w)).toBeGreaterThanOrEqual(GAP);
    expect(modeRect('max', AREA).w).toBe(AREA.w - 2 * GAP);
  });

  test('About and AI open side by side by default', () => {
    const about = defaultRect('about', 0, AREA);
    const ai = defaultRect('ai', 1, AREA);
    expect(ai.x).toBeGreaterThan(about.x + about.w);
    expect(ai.x + ai.w).toBeLessThanOrEqual(AREA.w - GAP);
    expect(placedRect(initialWins().about, 'about', AREA)).toEqual(about);
  });

  test('Exposé fits every window into the grid without overlap', () => {
    const rects = [defaultRect('about', 0, AREA), defaultRect('ai', 1, AREA), defaultRect('pricing', 2, AREA)];
    const { cols, slots } = expoLayout(rects, AREA);
    expect(slots).toHaveLength(3);
    expect(cols).toBeGreaterThanOrEqual(1);
    slots.forEach((s, i) => {
      expect(s.s).toBeGreaterThan(0);
      expect(s.s).toBeLessThanOrEqual(0.86);
      expect(rects[i].w * s.s).toBeLessThanOrEqual(s.cw + 0.5);
    });
  });
});

describe('Zuey OS look and routing', () => {
  test('parseLook falls back per field and clamps dim', () => {
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
    expect(parseLook({ mode: 'light', accent: 'nope', wallpaper: 'aurora', dim: 400 })).toEqual({ mode: 'light', accent: DEFAULT_LOOK.accent, wallpaper: 'aurora', dim: 80 });
  });

  test('the boot script is a self-contained IIFE', () => {
    expect(LOOK_BOOT_SCRIPT.startsWith('(function(){')).toBe(true);
    expect(() => new Function(LOOK_BOOT_SCRIPT)).not.toThrow();
  });

  test('hashes map to apps, including legacy anchors', () => {
    expect(appFromHash('#ai')).toBe('ai');
    expect(appFromHash('#profile')).toBe('about');
    expect(appFromHash('#activity')).toBe('github');
    expect(appFromHash('#nope')).toBeNull();
  });
});
