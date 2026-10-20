import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/components/os/os.css', 'utf8');

describe('mobile glass sheets', () => {
  const rule = css.match(/\n\s*\.osw--glass \{[^}]*\}/)?.[0] ?? '';

  test('stay near-opaque and blurred so sheets underneath do not bleed through', () => {
    expect(rule).toContain('var(--os-sheet) 97%');
    expect(rule).toContain('blur(28px)');
  });

  test('fall back to a solid sheet under prefers-reduced-transparency', () => {
    expect(css).toMatch(/prefers-reduced-transparency: reduce\) \{ \.osw--glass \{ background: var\(--os-sheet\)/);
  });
});
