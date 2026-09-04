import type { APIRoute } from 'astro';
import { getProfile, updateProfile } from '../../../db/store';
import { authenticateRequest } from '../../../lib/auth';
import type { D1DatabaseLike } from '../../../db/store';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = (locals as { runtime?: { env?: { DB?: D1DatabaseLike } } })?.runtime;
  const d1 = runtime?.env?.DB;

  const profile = await getProfile(d1);
  return new Response(JSON.stringify({ success: true, data: profile }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PUT: APIRoute = async ({ request, locals }) => {
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
    if (!body || typeof body !== 'object') {
      return new Response(JSON.stringify({ success: false, error: 'Invalid body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const updated = await updateProfile(body, d1);
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
