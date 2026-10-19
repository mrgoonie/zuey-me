import type { APIRoute } from 'astro';
import { renderCheckoutMarkdown } from '../lib/agent-commerce/checkout-markdown';

/** Public and identical for every caller: no per-user or order data is ever rendered here. */
export const GET: APIRoute = ({ locals, request }) => {
  const env = locals.runtime?.env ?? {};
  const origin = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  return new Response(renderCheckoutMarkdown(origin), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
};
