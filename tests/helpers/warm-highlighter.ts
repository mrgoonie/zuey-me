import { highlightCode } from '../../src/lib/blocks/code-highlight';
import { HIGHLIGHT_LANGUAGES } from '../../src/lib/blocks/code-syntax';
import type { HighlightLanguage } from '../../src/lib/blocks/code-syntax';

/** Generous budget for a `beforeAll` hook: the first highlight of each language compiles its grammar. */
export const HIGHLIGHTER_WARMUP_TIMEOUT_MS = 60_000;

const SCRIPT = [
  "import { a as b } from './mod';",
  '// comment',
  '/** doc */',
  'export async function f<T extends object>(x: T, y = 1): Promise<T> {',
  '\tif (x && y > 0 || !x) return `t${y}` as unknown as T;',
  '  const re = /a+b/gi, s = "str" + \'q\' + 0x1f + 1.5e3;',
  '  for (const k of Object.keys(x)) { await g(k); }',
  '  try { throw new Error(s); } catch (e) { return x; } finally { y++; }',
  '}',
  'class C extends D { #p = 1; static m(): void {} get v() { return this.#p; } }',
  'type U = { a?: string } | [number, ...string[]];',
  'const el = <div className="a" onClick={() => f(1)}>{x}</div>;',
].join('\n');

const SAMPLES: Record<HighlightLanguage, string> = {
  typescript: SCRIPT,
  javascript: SCRIPT,
  tsx: SCRIPT,
  jsx: SCRIPT,
  json: '{ "a": [1, 2.5, true, null], "b": { "c": "d\\n" } }',
  shellscript: '#!/usr/bin/env bash\nset -euo pipefail\nFOO="$(echo "$1" | tr a-z A-Z)"\nif [ -n "$FOO" ]; then echo "${FOO}" >> out.txt; fi\nfor f in *.ts; do bun test "$f" || exit 1; done',
  python: '@dec\nasync def f(x: int = 1, *a, **k) -> None:\n    """doc"""\n    if x and not a: return [i for i in range(3)]\n    print(f"{x!r}", {"a": 1})\nclass C(B):\n    pass',
  sql: "-- c\nSELECT a, COUNT(*) AS n FROM t LEFT JOIN u ON t.id = u.id WHERE a >= 1 AND b LIKE 'x%' GROUP BY a ORDER BY n DESC LIMIT 5;\nINSERT INTO t (a) VALUES (1);\nCREATE TABLE x (id INTEGER PRIMARY KEY);",
  html: '<!doctype html>\n<!-- c -->\n<div class="a" id=\'b\' data-x=1>text &amp; <b>bold</b><script>let a = 1;</script><style>a { color: red }</style></div>',
  css: '@media (min-width: 1px) { .a > b:hover, #c::after { color: #fff; margin: 0 auto; background: url(x.png) var(--x, 1px); } }\n/* c */',
  yaml: '# c\nkey: value\nlist:\n  - a\n  - b: 1\nanchor: &x { a: 1 }\nref: *x\ntext: |\n  block\n',
  markdown: '# H\n\n**b** _i_ `c` [l](https://x.y)\n\n- a\n1. b\n\n> q\n\n```ts\nlet a = 1;\n```\n',
  diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n',
};

/**
 * Compiles every highlighter grammar up front. Shiki compiles a grammar's regexes lazily on first use (about 1.2s
 * for TypeScript on an idle machine, several times that on a loaded CI runner), so without this whichever test
 * highlights first pays that cost against bun's 5s per-test timeout, and the failing test changes between runs.
 * Call it from `beforeAll(warmHighlighter, HIGHLIGHTER_WARMUP_TIMEOUT_MS)`.
 */
export function warmHighlighter(): void {
  for (const language of HIGHLIGHT_LANGUAGES) highlightCode(SAMPLES[language], language);
}
