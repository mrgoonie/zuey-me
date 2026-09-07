import type { APIRoute } from 'astro';
import { destroySession } from '../../../db/store';

export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)zuey_session=([^;]+)/);
  if (match) {
    const token = decodeURIComponent(match[1]);
    await destroySession(token, d1);
  }

  const response = new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
  response.headers.set('Set-Cookie', 'zuey_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return response;
};
