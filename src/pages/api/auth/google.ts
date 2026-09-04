import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request, redirect }) => {
  const url = new URL(request.url);
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (clientId) {
    const redirectUri = `${url.origin}/api/auth/google/callback`;
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile`;
    return redirect(googleAuthUrl);
  }

  // Instant SSO demo fallback when OAuth env is not yet populated
  const response = redirect('/studio');
  response.headers.set(
    'Set-Cookie',
    `zuey_session=authenticated; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
  );
  return response;
};
