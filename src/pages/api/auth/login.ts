import type { APIRoute } from 'astro';
import { verifyApiKey } from '../../../db/store';

export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;

  try {
    const body = await request.json();
    const token = (body && body.token) || '';

    // Direct owner master token, demo key, or verified API key
    if (token === 'zuey_master_2026' || token === 'zuey_live_demo_key' || (await verifyApiKey(token, d1))) {
      const response = new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
      response.headers.set(
        'Set-Cookie',
        `zuey_session=authenticated; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
      );
      return response;
    }

    return new Response(JSON.stringify({ success: false, error: 'Invalid token or API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
