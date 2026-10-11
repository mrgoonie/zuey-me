import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { highlightBlocks } from '../src/lib/blocks/code-highlight';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { blockSchemas } from '../src/lib/blocks/openapi';
import { applyPaywall, blockWeight } from '../src/lib/blocks/paywall';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { readStoredDocument, validateDocument } from '../src/lib/blocks/validate';
import { documentText as aiDocumentText } from '../src/lib/ai/context';
import { documentText } from '../src/lib/search/text';
import { renderArticleEmail } from '../src/lib/notifications/article-email-render';
import { KITCHEN_SINK, LEGACY_STORED, PROSE_ARTICLE } from './fixtures/v1-article-documents';

// Snapshots were recorded from the renderer, serializers and schemas as they were before the block
// registry; every surface must keep producing exactly the same output for stored v1 documents.

const ARTICLE_URL = 'https://zuey.me/articles/demo';

function valid(input: unknown): ArticleDocument {
  const res = validateDocument(input);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.doc;
}

function surfaces(doc: ArticleDocument) {
  const email = (mode: 'full' | 'teaser') => renderArticleEmail({
    locale: 'vi', title: 'Demo', excerpt: 'Tóm tắt', access: 'knowledges', coverUrl: null, document: doc,
    articleUrl: ARTICLE_URL, pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode,
  });
  const paywalled = applyPaywall(doc, 'knowledges', { isAdmin: false, entitlements: [] });
  return {
    html: renderToString(createElement(BlockRenderer, { doc, interactive: false })),
    articleHtml: renderToString(createElement(BlockRenderer, { doc, articleSlug: 'demo', highlights: highlightBlocks(doc.blocks) })),
    markdown: documentToMarkdown(doc, { articleUrl: ARTICLE_URL }),
    searchText: documentText(doc),
    aiText: aiDocumentText(doc),
    weights: doc.blocks.map(b => [b.id, blockWeight(b)]),
    paywall: { kept: paywalled.doc.blocks.map(b => b.id), truncated: paywalled.truncated, outline: paywalled.outline },
    emailFull: email('full'),
    emailTeaser: email('teaser'),
  };
}

describe('schema v1 documents render unchanged', () => {
  // Server rendering (icons inline); import.meta.env.SSR is the live process.env in Bun.
  const previousSsr = process.env.SSR;
  beforeAll(() => { process.env.SSR = 'true'; });
  afterAll(() => { if (previousSsr === undefined) delete process.env.SSR; else process.env.SSR = previousSsr; });

  it('kitchen sink: every v1 block type', () => {
    const doc = valid(KITCHEN_SINK);
    expect(doc).toEqual(KITCHEN_SINK);
    expect(surfaces(doc)).toMatchSnapshot();
  });

  it('prose article', () => {
    const doc = valid(PROSE_ARTICLE);
    expect(surfaces(doc)).toMatchSnapshot();
  });

  it('legacy stored document recovered block by block', () => {
    const read = readStoredDocument(LEGACY_STORED);
    if (!read) throw new Error('expected a readable document');
    expect({ dropped: read.dropped, degraded: read.degraded, ids: read.doc.blocks.map(b => b.id) }).toEqual({ dropped: 3, degraded: 1, ids: ['p1', 'e1', 't1'] });
    expect(surfaces(read.doc)).toMatchSnapshot();
  });

  it('v1 block schemas (OpenAPI and MCP block_schema) are unchanged', () => {
    const v1 = Object.fromEntries(Object.entries(blockSchemas).filter(([name]) => !['BlockSection', 'BlockCard'].includes(name)));
    expect(v1).toMatchSnapshot();
  });
});
