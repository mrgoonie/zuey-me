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
    return redirect('/studio?error=missing_code');
  }

  const clientId = locals.runtime?.env?.GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID;
  const clientSecret = locals.runtime?.env?.GITHUB_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return redirect('/studio?error=github_oauth_not_configured');
  }

  try {
    // 1. Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      return redirect('/studio?error=token_exchange_failed');
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
