import type { APIRoute } from 'astro';
import { revokeApiKey } from '../../../../db/store';
import { authenticateAdmin } from '../../../../lib/auth';

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ success: false, error: 'Missing key id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const d1 = locals.runtime?.env?.DB;
  const auth = await authenticateAdmin(request, d1, locals.runtime?.env);
  if (!auth.authenticated) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: auth.role ? 403 : 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const success = await revokeApiKey(id, d1);
  return new Response(JSON.stringify({ success }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
