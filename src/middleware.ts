import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  const accept = request.headers.get('accept') || '';

  // Intercept root page when requesting text/markdown
  if (url.pathname === '/' && accept.includes('text/markdown')) {
    return context.redirect('/index.md', 307);
  }

  const response = await next();

  // Add CORS headers for API and Markdown routes
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.md') || url.pathname.endsWith('.txt')) {
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  }

  return response;
});
