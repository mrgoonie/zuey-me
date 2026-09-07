import type { APIRoute } from 'astro';
import { createSession } from '../../../../db/store';

const ALLOWED_GITHUB_USERS: Record<string, true> = { mrgoonie: true };
const ALLOWED_EMAILS: Record<string, true> = {
  'hi@zuey.me': true,
  'digitop.vn@gmail.com': true,
};

export const GET: APIRoute = async ({ request, redirect, locals }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    const error = url.searchParams.get('error') || 'missing_code';
    const desc = url.searchParams.get('error_description') || '';
    return redirect(`/studio?error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(desc)}`);
  }

  const rawClientId = locals.runtime?.env?.GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID || '';
  const rawClientSecret = locals.runtime?.env?.GITHUB_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET || '';
  const clientId = rawClientId.trim();
  const clientSecret = rawClientSecret.trim();

  if (!clientId || !clientSecret) {
    return redirect('/studio?error=github_oauth_not_configured');
  }

  try {
    const redirectUri = `${url.origin}/api/auth/github/callback`;

    // 1. Exchange code for access token with User-Agent and matching redirect_uri
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'zuey-me-auth',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code.trim(),
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenData.access_token) {
      const errCode = encodeURIComponent(tokenData.error || 'token_exchange_failed');
      const errDesc = encodeURIComponent(tokenData.error_description || '');
      console.error(`GitHub OAuth token error: ${tokenData.error} - ${tokenData.error_description}`);
      return redirect(`/studio?error=${errCode}&error_description=${errDesc}`);
    }

    // 2. Fetch authenticated GitHub user
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'zuey-me-auth',
        Accept: 'application/json',
      },
    });

    if (!userRes.ok) {
      return redirect('/studio?error=failed_to_fetch_user');
    }

    const userData = await userRes.json() as { login?: string; email?: string };
    const username = (userData.login || '').toLowerCase();
    const userEmail = (userData.email || '').toLowerCase();

    // Also fetch user emails in case primary email is private
    let hasAllowedEmail = Boolean(ALLOWED_EMAILS[userEmail]);
    if (!hasAllowedEmail) {
      try {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'zuey-me-auth',
            Accept: 'application/json',
          },
        });
        if (emailsRes.ok) {
          const emails = await emailsRes.json() as Array<{ email: string; verified: boolean }>;
          hasAllowedEmail = emails.some(e => e.verified && Boolean(ALLOWED_EMAILS[e.email.toLowerCase()]));
        }
      } catch {
        // ignore email fetch failure
      }
    }

    // 3. Strict Identity Verification: must be @mrgoonie or owner email
    const isAuthorized = Boolean(ALLOWED_GITHUB_USERS[username]) || hasAllowedEmail;
    if (!isAuthorized) {
      console.warn(`Unauthorized GitHub login attempt: ${username} (${userEmail})`);
      return redirect('/studio?error=unauthorized_github_account');
    }

    // 4. Issue cryptographically secure session
    const d1 = locals.runtime?.env?.DB;
    const sessionToken = await createSession(userData.login || 'mrgoonie', d1);

    const response = redirect('/studio');
    response.headers.set(
      'Set-Cookie',
      `zuey_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    );
    return response;
  } catch (err) {
    console.error('GitHub OAuth exception:', err);
    return redirect('/studio?error=oauth_exception');
  }
};
