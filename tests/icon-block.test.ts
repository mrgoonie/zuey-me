import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { ICON_COMPONENTS, IconGlyph } from '../src/components/blocks/block-icons';
import { filterIcons } from '../src/components/studio/IconPicker';
import { ICON_ALIASES, ICON_NAMES, isIconName, resolveIconName } from '../src/lib/blocks/icons';
import { validateDocument } from '../src/lib/blocks/validate';
import type { ValidationResult } from '../src/lib/blocks/validate';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { blockWeight } from '../src/lib/blocks/paywall';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import { articlesOpenApi, blockSchemas } from '../src/lib/blocks/openapi';
import { documentText } from '../src/lib/search/text';
import { documentText as aiDocumentText } from '../src/lib/ai/context';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { AppError } from '../src/lib/http';
import type { McpContext } from '../src/lib/mcp/types';

function validDoc(res: ValidationResult): ArticleDocument {
  if (!res.ok) throw new Error(`expected a valid document: ${JSON.stringify(res.errors)}`);
  return res.doc;
}

function errorsOf(res: ValidationResult): string {
  return res.ok ? '' : JSON.stringify(res.errors);
}

function render(blocks: unknown[]): string {
  const doc = validDoc(validateDocument({ version: 1, blocks }));
  return renderToStaticMarkup(createElement(BlockRenderer, { doc, interactive: false }));
}

const INJECTION_NAMES = [
  'x" onload="alert(1)',
  '<script>alert(1)</script>',
  'arrow-right"><svg onload=alert(1)>',
  'javascript:alert(1)',
  '__proto__',
  'constructor',
  'toString',
  '../../etc/passwd',
  'arrow-right ',
  'a'.repeat(5_000),
];

describe('icon registry', () => {
  it('is a curated, unique, kebab-case allowlist backed by real Lucide icons', () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(80);
    expect(ICON_NAMES.length).toBeLessThanOrEqual(150);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
    for (const name of ICON_NAMES) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(existsSync(`node_modules/lucide-react/dist/esm/icons/${name}.mjs`)).toBe(true);
      expect(typeof ICON_COMPONENTS[name]).toBe('object');
    }
    expect(Object.keys(ICON_COMPONENTS).sort()).toEqual([...ICON_NAMES].sort());
  });

  it('resolves aliases to canonical names and rejects everything else', () => {
    for (const [alias, target] of Object.entries(ICON_ALIASES)) {
      expect(isIconName(target)).toBe(true);
      expect(isIconName(alias)).toBe(false);
      expect(resolveIconName(alias)).toBe(target);
    }
    expect(resolveIconName('Warning')).toBe('triangle-alert');
    expect(resolveIconName('  rocket ')).toBe('rocket');
    for (const bad of INJECTION_NAMES.filter(n => n.trim() !== 'arrow-right')) expect(resolveIconName(bad)).toBeNull();
    expect(resolveIconName(42)).toBeNull();
    expect(resolveIconName(null)).toBeNull();
  });
});

describe('icon block validation', () => {
  it('accepts an icon block, applies defaults and stores the canonical name', () => {
    const doc = validDoc(validateDocument({ blocks: [
      { id: 'i1', type: 'icon', name: 'warning' },
      { id: 'i2', type: 'icon', name: 'rocket', size: 'xl', tone: 'success', align: 'center', label: '  Ra mắt  ' },
    ] }));
    expect(doc.blocks[0]).toEqual({ id: 'i1', type: 'icon', name: 'triangle-alert', size: 'md', tone: 'default' });
    expect(doc.blocks[1]).toEqual({ id: 'i2', type: 'icon', name: 'rocket', size: 'xl', tone: 'success', align: 'center', label: 'Ra mắt' });
  });

  it('rejects names outside the allowlist, including injection-like strings, without echoing them', () => {
    for (const name of [...INJECTION_NAMES.filter(n => n !== 'arrow-right '), 'not-an-icon', 42, '', null]) {
      const res = validateDocument({ blocks: [{ type: 'icon', name }] });
      expect(res.ok).toBe(false);
      const errors = errorsOf(res);
      expect(errors).toContain('$.blocks[0].name');
      expect(errors).toContain('icon allowlist');
      expect(errors).not.toContain('onload');
      expect(errors).not.toContain('<script');
    }
  });

  it('rejects bad size, tone, align and over-long labels', () => {
    expect(errorsOf(validateDocument({ blocks: [{ type: 'icon', name: 'star', size: 'huge' }] }))).toContain('$.blocks[0].size');
    expect(errorsOf(validateDocument({ blocks: [{ type: 'icon', name: 'star', tone: 'red' }] }))).toContain('$.blocks[0].tone');
    expect(errorsOf(validateDocument({ blocks: [{ type: 'icon', name: 'star', align: 'left' }] }))).toContain('$.blocks[0].align');
    expect(errorsOf(validateDocument({ blocks: [{ type: 'icon', name: 'star', label: 'x'.repeat(121) }] }))).toContain('$.blocks[0].label');
    expect(errorsOf(validateDocument({ blocks: [{ type: 'icon', name: 'star', label: 5 }] }))).toContain('$.blocks[0].label');
  });

  it('accepts icons inside layouts and toggles', () => {
    const res = validateDocument({ blocks: [
      { type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 }, children: [{ blocks: [{ type: 'icon', name: 'book' }] }] },
      { type: 'toggle', summary: 'More', blocks: [{ type: 'icon', name: 'atom', label: 'Khoa học' }] },
    ] });
    expect(res.ok).toBe(true);
  });

  it('validates the optional callout icon against the same allowlist', () => {
    const doc = validDoc(validateDocument({ blocks: [
      { id: 'c1', type: 'callout', tone: 'tip', text: 'Hi', icon: 'idea' },
      { id: 'c2', type: 'callout', tone: 'info', text: 'Old document' },
      { id: 'c3', type: 'callout', tone: 'warn', text: 'Empty icon', icon: '' },
    ] }));
    expect(doc.blocks[0]).toEqual({ id: 'c1', type: 'callout', tone: 'tip', text: 'Hi', icon: 'lightbulb' });
    expect(doc.blocks[1]).toEqual({ id: 'c2', type: 'callout', tone: 'info', text: 'Old document' });
    expect(doc.blocks[2]).not.toHaveProperty('icon');
    const bad = validateDocument({ blocks: [{ type: 'callout', text: 'x', icon: 'x" onload="alert(1)' }] });
    expect(bad.ok).toBe(false);
    expect(errorsOf(bad)).toContain('$.blocks[0].icon');
  });
});

describe('icon rendering', () => {
  // The server renders icons synchronously; browsers load the icon map lazily (import.meta.env.SSR is live process.env in Bun).
  const previousSsr = process.env.SSR;
  beforeAll(() => { process.env.SSR = 'true'; });
  afterAll(() => { if (previousSsr === undefined) delete process.env.SSR; else process.env.SSR = previousSsr; });

  it('renders a decorative icon as aria-hidden inline SVG', () => {
    const html = render([{ type: 'icon', name: 'rocket', size: 'lg', tone: 'accent', align: 'center' }]);
    expect(html).toContain('class="zb-icon zb-icon-center zb-icon-tone-accent"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toMatch(/<svg[^>]*width="32"/);
    expect(html).toContain('data-icon="rocket"');
    expect(html).not.toContain('role="img"');
  });

  it('renders a labelled icon with role="img" and an accessible name', () => {
    const html = render([{ type: 'icon', name: 'circle-check', label: 'Đã xác minh <b>' }]);
    expect(html).toMatch(/<svg[^>]*role="img"/);
    expect(html).toContain('aria-label="Đã xác minh &lt;b&gt;"');
    expect(html).not.toContain('aria-hidden');
    expect(html).toMatch(/<svg[^>]*width="24"/);
  });

  it('replaces the callout glyph with the chosen icon and keeps the old glyph otherwise', () => {
    const withIcon = render([{ type: 'callout', tone: 'warn', text: 'Careful', icon: 'flame' }]);
    expect(withIcon).toContain('data-icon="flame"');
    expect(withIcon).not.toContain('>!<');
    const legacy = render([{ type: 'callout', tone: 'warn', text: 'Careful' }]);
    expect(legacy).toContain('>!<');
    expect(legacy).not.toContain('<svg');
  });

  it('renders nothing for names outside the allowlist (never injects strings into SVG)', () => {
    for (const name of [...INJECTION_NAMES, 'unknown']) {
      expect(renderToStaticMarkup(createElement(IconGlyph, { name, size: 'md' }))).toBe('');
    }
    // A stored payload that bypassed validation still renders safely (JSON.parse models the D1 read).
    const forged: ArticleDocument = JSON.parse(JSON.stringify({ version: 1, blocks: [
      { id: 'f1', type: 'icon', name: 'x" onload="alert(1)', size: 'md', tone: 'default' },
      { id: 'f2', type: 'callout', tone: 'info', text: 'T', icon: '<img src=x onerror=alert(1)>' },
    ] }));
    const html = renderToStaticMarkup(createElement(BlockRenderer, { doc: forged, interactive: false }));
    expect(html).not.toContain('onload');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<svg');
  });
});

describe('icon text fallbacks', () => {
  const doc = validDoc(validateDocument({ blocks: [
    { type: 'paragraph', text: 'Intro' },
    { type: 'icon', name: 'sparkles' },
    { type: 'icon', name: 'trophy', label: 'Giải thưởng' },
    { type: 'callout', tone: 'tip', text: 'Tip text', icon: 'rocket' },
  ] }));

  it('exports a labelled icon as its label and drops a decorative one in Markdown', () => {
    expect(documentToMarkdown(doc)).toBe('Intro\n\nGiải thưởng\n\n> **TIP:** Tip text');
  });

  it('indexes only the label for search and AI context', () => {
    expect(documentText(doc)).toBe('Intro\nGiải thưởng\nTip text');
    expect(aiDocumentText(doc)).toContain('Giải thưởng');
    expect(aiDocumentText(doc)).not.toContain('sparkles');
  });

  it('gives icons a small paywall weight', () => {
    expect(blockWeight(doc.blocks[1])).toBe(1);
    expect(blockWeight(doc.blocks[2])).toBe(1 + 'Giải thưởng'.length);
  });
});

describe('icon block contracts', () => {
  const ctx: McpContext = {
    request: new Request('https://zuey.test/api/mcp'),
    env: {},
    async requireAdmin() { throw new AppError(401, 'unauthorized', 'Unauthorized'); },
    async isAdmin() { return false; },
  };

  it('exposes the icon block, the allowlist and examples through block_schema', async () => {
    const schema = await articlesMcpModule.call('block_schema', {}, ctx);
    const text = JSON.stringify(schema);
    expect(text).toContain('"BlockIcon"');
    expect(text).toContain('"icons":{"names":[');
    expect(text).toContain('"callout_with_icon"');
    for (const name of ICON_NAMES) expect(text).toContain(`"${name}"`);
    // The examples must themselves be valid documents.
    const examples = JSON.parse(text).examples;
    expect(validateDocument({ blocks: [examples.icon, examples.callout_with_icon] }).ok).toBe(true);
  });

  it('documents the icon block and callout.icon in OpenAPI', () => {
    const icon = JSON.stringify(blockSchemas.BlockIcon);
    expect(icon).toContain('"const":"icon"');
    expect(icon).toContain('"required":["type","name"]');
    expect(icon).toContain('"warning"');
    expect(JSON.stringify(blockSchemas.BlockCallout)).toContain('"icon"');
    const blockUnion = JSON.stringify(articlesOpenApi.schemas);
    expect(blockUnion).toContain('"icon":"#/components/schemas/BlockIcon"');
  });
});

describe('Studio icon picker search', () => {
  it('matches names, groups and aliases', () => {
    expect(filterIcons('')).toHaveLength(ICON_NAMES.length);
    expect(filterIcons('warning')).toContain('triangle-alert');
    expect(filterIcons('ARROW')).toContain('arrow-right');
    expect(filterIcons('learning')).toContain('graduation-cap');
    expect(filterIcons('zzz-nothing')).toEqual([]);
  });
});
