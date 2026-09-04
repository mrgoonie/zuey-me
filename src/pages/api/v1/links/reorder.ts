import type { APIRoute } from 'astro';
import { reorderLinks } from '../../../../db/store';
import { authenticateRequest } from '../../../../lib/auth';
import type { D1DatabaseLike } from '../../../../db/store';

export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = (locals as { runtime?: { env?: { DB?: D1DatabaseLike } } })?.runtime;
  const d1 = runtime?.env?.DB;

  const auth = await authenticateRequest(request, d1);
  if (!auth.authenticated) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    if (!body || !Array.isArray(body.order)) {
      return new Response(JSON.stringify({ success: false, error: 'Expected order: string[] array of link IDs' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const success = await reorderLinks(body.order, d1);
    return new Response(JSON.stringify({ success }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
