import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request, redirect, locals }) => {
  const url = new URL(request.url);
  const clientId = locals.runtime?.env?.GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID;

  if (!clientId) {
    return redirect('/studio?error=github_oauth_not_configured');
  }

  const redirectUri = `${url.origin}/api/auth/github/callback`;
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user,user:email`;
  return redirect(githubAuthUrl);
};
