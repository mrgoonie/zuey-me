import type { APIRoute } from 'astro';
import { verifyApiKey, createSession } from '../../../db/store';

export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;

  try {
    const body = await request.json();
    const token = (body && typeof body.token === 'string') ? body.token.trim() : '';

    if (!token) {
      return new Response(JSON.stringify({ success: false, error: 'API key or token is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify token against database / store
    const isValid = await verifyApiKey(token, d1);
    if (!isValid) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid or revoked API key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const sessionToken = await createSession('admin@zuey.me', d1);
    const response = new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
    response.headers.set(
      'Set-Cookie',
      `zuey_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    );
    return response;
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
