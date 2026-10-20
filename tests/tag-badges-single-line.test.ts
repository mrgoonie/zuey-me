import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TagBadges } from '../src/components/knowledge/TagBadges';
import type { PublicTag } from '../src/lib/taxonomy/tags';

const tags: PublicTag[] = ['claude-code', 'ai-agents', 'context-engineering'].map((slug, i) => ({ id: `t${i}`, slug, name: slug }));

describe('TagBadges row', () => {
  test('wraps by default', () => {
    const html = renderToStaticMarkup(createElement(TagBadges, { tags, size: 'sm' }));
    expect(html).toContain('flex-wrap');
    expect(html).not.toContain('flex-nowrap');
  });

  test('singleLine keeps one row whose height does not depend on the font (list cards rely on it)', () => {
    const html = renderToStaticMarkup(createElement(TagBadges, { tags, size: 'sm', singleLine: true }));
    const ul = (html.match(/<ul class="([^"]+)"/)?.[1] ?? '').replaceAll('&amp;', '&').replaceAll('&gt;', '>');
    // overflow-clip, not overflow-hidden: a clipped container cannot be scrolled by focusing a hidden badge.
    for (const cls of ['flex-nowrap', 'overflow-clip', '[&>li]:flex', '[&>li]:flex-none']) expect(ul.split(' ')).toContain(cls);
    expect(ul.split(' ')).not.toContain('flex-wrap');
    expect(ul.split(' ')).not.toContain('overflow-hidden');
    // Keyboard focus unclips the row so the focused badge and its ring are visible.
    for (const cls of ['has-[:focus-visible]:flex-wrap', 'has-[:focus-visible]:overflow-visible', 'has-[:focus-visible]:[mask-image:none]']) expect(ul.split(' ')).toContain(cls);
    expect(html).toContain('title="#claude-code, #ai-agents, #context-engineering"');
    expect(html.match(/<li/g)).toHaveLength(3);
  });
});
