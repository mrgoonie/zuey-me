import type { APIRoute } from 'astro';
import { reorderLinks } from '../../../../db/store';
import { authenticateAdmin } from '../../../../lib/auth';

export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const auth = await authenticateAdmin(request, d1, locals.runtime?.env);
  if (!auth.authenticated) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: auth.role ? 403 : 401,
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
