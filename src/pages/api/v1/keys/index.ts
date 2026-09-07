import type { APIRoute } from 'astro';
import { listApiKeys, createApiKey } from '../../../../db/store';
import { authenticateRequest } from '../../../../lib/auth';

export const GET: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const auth = await authenticateRequest(request, d1);
  if (!auth.authenticated) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const keys = await listApiKeys(d1);
  return new Response(JSON.stringify({ success: true, data: keys }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const auth = await authenticateRequest(request, d1);
  if (!auth.authenticated) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const name = (body && body.name) || 'New API Key';
    const role = (body && body.role === 'read') ? 'read' : 'admin';

    const result = await createApiKey(name, role, d1);
    return new Response(JSON.stringify({
      success: true,
      data: {
        key: result.key,
        record: result.record,
      }
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
