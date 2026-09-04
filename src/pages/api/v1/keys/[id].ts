import type { APIRoute } from 'astro';
import { revokeApiKey } from '../../../../db/store';
import { authenticateRequest } from '../../../../lib/auth';
import type { D1DatabaseLike } from '../../../../db/store';

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ success: false, error: 'Missing key id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const runtime = (locals as { runtime?: { env?: { DB?: D1DatabaseLike } } })?.runtime;
  const d1 = runtime?.env?.DB;

  const auth = await authenticateRequest(request, d1);
  if (!auth.authenticated) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const success = await revokeApiKey(id, d1);
  return new Response(JSON.stringify({ success }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
