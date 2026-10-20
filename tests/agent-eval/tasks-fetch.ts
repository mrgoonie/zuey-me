import type { FetchTask } from './lib/types';

/**
 * No-JS lane: the agent starts at /, /llms.txt and /index.md and follows links it finds. `follow`
 * models the agent's intent (it only follows links that look relevant to the prompt).
 */
const t = (id: string, prompt: string, follow: string, matchers: FetchTask['expect']['matchers'], extra: Partial<FetchTask> = {}): FetchTask => ({
  id, lane: 'fetch', prompt, follow, maxHops: 2, expect: { matchers }, ...extra,
});

export const FETCH_TASKS: FetchTask[] = [
  t('fetch-pricing-url', 'Find the URL of the membership pricing page of zuey.me.', 'pric|plan|membership', [{ link: '^https?://[^/]+/pricing/?$' }]),
  t('fetch-list-apps', 'List the apps available in the ZueyOS desktop on the home page (at least pricing, zueytube, reads, github).', 'zueyos|apps?', [{ text: 'zueytube' }, { text: 'pricing' }, { text: 'reads' }, { text: 'github' }], { maxHops: 1 }),
  t('fetch-latest-article', 'What is the title of the most recent article published on zuey.me?', 'article|blog|knowledge', [], { truth: 'latest-article-title' }),
  t('fetch-mcp-endpoint', 'Find the MCP server endpoint URL that agents can connect to.', 'mcp|docs|agent', [{ text: 'https?://[^/\\s]+/(api/)?mcp\\b' }]),
  t('fetch-zueytube-route', 'Find the standalone page URL for Zueytube (curated videos).', 'video|zueytube|tube', [{ link: '^https?://[^/]+/videos/?$' }]),
  t('fetch-app-deeplink', 'How do I deep-link directly to a specific ZueyOS app (e.g. open Pricing) with a URL?', 'deep|link|hash|docs|agent', [{ text: '/#(pricing|zueytube|reads|knowledges)\\b' }]),
  t('fetch-courses-url', 'Find the page that lists Zuey courses.', 'course', [{ link: '^https?://[^/]+/courses(\\.md)?/?$' }]),
  t('fetch-reads-url', 'Find the page listing recommended reads (Zuey Reads).', 'reads?', [{ link: '^https?://[^/]+/reads(\\.md)?/?$' }]),
  t('fetch-business-url', 'Find how to book a 1:1 consultation (Zuey for Business) and its URL.', 'business|consult|book', [{ link: '^https?://[^/]+/business/?$' }]),
  t('fetch-openapi-spec', 'Find the URL of the machine-readable OpenAPI spec of the site API.', 'openapi|docs|api', [{ link: '/api/openapi\\.json$' }]),
  t('fetch-referral-url', 'Find the referral program page URL.', 'referral|affiliate|refer', [{ link: '^https?://[^/]+/referral/?$' }]),
  t('fetch-contact-email', 'What is the contact email address of the site owner?', 'contact|about', [{ text: '[a-z0-9._-]+@zuey\\.me' }], { maxHops: 0 }),
  t('fetch-llms-full', 'Find the full-context LLM file (llms-full.txt) URL.', 'llms', [{ link: '/llms-full\\.txt$' }]),
  t('fetch-checkout-guide', 'Find the guide an agent should read before helping a human buy a membership or course.', 'checkout|buy|purchase', [{ link: '/checkout\\.md$' }]),
];
