import type { APIRoute } from 'astro';

export const POST: APIRoute = async () => {
  const response = new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
  response.headers.set('Set-Cookie', 'zuey_session=; Path=/; HttpOnly; Max-Age=0');
  return response;
};
