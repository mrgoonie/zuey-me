import type { APIRoute } from 'astro';
import { getProfile, updateProfile } from '../../../db/store';
import { authenticateAdmin } from '../../../lib/auth';

export const GET: APIRoute = async ({ locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const profile = await getProfile(d1);
  return new Response(JSON.stringify({
    success: true,
    data: {
      theme: profile.theme,
      custom_css: profile.custom_css || '',
    }
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PUT: APIRoute = async ({ request, locals }) => {
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
    if (!body || typeof body !== 'object' || !body.theme) {
      return new Response(JSON.stringify({ success: false, error: 'theme string is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const updated = await updateProfile({
      theme: body.theme,
      custom_css: body.custom_css,
    }, d1);

    return new Response(JSON.stringify({
      success: true,
      data: {
        theme: updated.theme,
        custom_css: updated.custom_css,
      }
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
