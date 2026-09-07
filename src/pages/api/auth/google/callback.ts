import type { APIRoute } from 'astro';
import { createSession } from '../../../../db/store';

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

  const clientId = locals.runtime?.env?.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = locals.runtime?.env?.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return redirect('/studio?error=google_oauth_not_configured');
  }

  try {
    const redirectUri = `${url.origin}/api/auth/google/callback`;

    // 1. Exchange code for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      return redirect('/studio?error=token_exchange_failed');
    }

    // 2. Fetch authenticated Google user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userRes.ok) {
      return redirect('/studio?error=failed_to_fetch_user');
    }

    const userData = await userRes.json() as { email?: string; verified_email?: boolean };
    const email = (userData.email || '').toLowerCase();

    // 3. Strict Identity Verification: must be on allowlist
    const isAuthorized = Boolean(ALLOWED_EMAILS[email]);
    if (!isAuthorized) {
      console.warn(`Unauthorized Google login attempt: ${email}`);
      return redirect('/studio?error=unauthorized_google_account');
    }

    // 4. Issue cryptographically secure session
    const d1 = locals.runtime?.env?.DB;
    const sessionToken = await createSession(email, d1);

    const response = redirect('/studio');
    response.headers.set(
      'Set-Cookie',
      `zuey_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    );
    return response;
  } catch (err) {
    console.error('Google OAuth exception:', err);
    return redirect('/studio?error=oauth_exception');
  }
};
