import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/components/os/os.css', 'utf8');
const mobile = css.slice(css.indexOf('@media (max-width: 767px)'));

describe('mobile glass sheets', () => {
  test('use a fully opaque surface so sheets underneath do not bleed through', () => {
    expect(mobile).toMatch(/\.osw--glass \{ background: var\(--os-sheet\); \}/);
  });

  test('define an opaque sheet colour for both themes', () => {
    expect(css.match(/--os-sheet: rgb\(/g)?.length).toBe(2);
  });
});
