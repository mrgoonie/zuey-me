import type { APIRoute } from 'astro';
import { updateLink, deleteLink } from '../../../../db/store';
import { authenticateRequest } from '../../../../lib/auth';
import type { D1DatabaseLike } from '../../../../db/store';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ success: false, error: 'Missing link id' }), {
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

  try {
    const body = await request.json();
    const updated = await updateLink(id, body, d1);
    if (!updated) {
      return new Response(JSON.stringify({ success: false, error: 'Link not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, data: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ success: false, error: 'Missing link id' }), {
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

  const deleted = await deleteLink(id, d1);
  return new Response(JSON.stringify({ success: deleted }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
