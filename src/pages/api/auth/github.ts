import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request, redirect }) => {
  const url = new URL(request.url);
  const clientId = process.env.GITHUB_CLIENT_ID;

  if (clientId) {
    const redirectUri = `${url.origin}/api/auth/github/callback`;
    const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user,user:email`;
    return redirect(githubAuthUrl);
  }

  // Instant SSO demo fallback when OAuth env is not yet populated
  const response = redirect('/studio');
  response.headers.set(
    'Set-Cookie',
    `zuey_session=authenticated; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
  );
  return response;
};
