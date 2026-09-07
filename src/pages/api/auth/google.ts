import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request, redirect, locals }) => {
  const url = new URL(request.url);
  const clientId = locals.runtime?.env?.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return redirect('/studio?error=google_oauth_not_configured');
  }

  const redirectUri = `${url.origin}/api/auth/google/callback`;
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile`;
  return redirect(googleAuthUrl);
};
