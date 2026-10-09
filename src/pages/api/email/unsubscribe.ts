import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../lib/http';
import { requireDb } from '../../../lib/booking/store';
import { optInArticleEmails, optOutArticleEmails, unsubscribeSecret, verifyUnsubscribeToken } from '../../../lib/notifications/article-email-subscription';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

async function readFields(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const out: Record<string, string> = {};
  try {
    if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
      for (const [k, v] of (await request.formData()).entries()) if (typeof v === 'string') out[k] = v;
    } else if (type === 'application/json') {
      const body: unknown = await request.json();
      if (typeof body === 'object' && body !== null) {
        for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
      }
    }
  } catch {
    // An unreadable body falls back to the query string (one-click requests carry the token in the URL).
  }
  return out;
}

/**
 * Article-email preference, authorized by the signed token from the email (no session, no cookies).
 * - RFC 8058 one-click (`List-Unsubscribe=One-Click` form body from mailbox providers) → 200.
 * - Form from the /unsubscribe page (`action` = unsubscribe | resubscribe) → 303 back to the page.
 * - JSON `{ token, action? }` → JSON envelope.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const fields = await readFields(request);
    const token = fields.token || url.searchParams.get('token') || '';
    const fromPage = fields.action !== undefined && fields['List-Unsubscribe'] === undefined
      && request.headers.get('content-type')?.includes('form') === true;
    const userId = await verifyUnsubscribeToken(unsubscribeSecret(env), token);
    if (!userId) {
      if (fromPage) return seeOther('/unsubscribe?error=invalid_token');
      return jsonError(400, 'invalid_token', 'Invalid unsubscribe link');
    }
    const db = requireDb(env);
    const resubscribe = fields.action === 'resubscribe';
    const changed = resubscribe ? await optInArticleEmails(db, userId) : await optOutArticleEmails(db, userId, 'unsubscribe');
    if (!changed) return jsonError(404, 'not_found', 'Account not found');
    if (fromPage) {
      const done = resubscribe ? 'resubscribed' : 'unsubscribed';
      return seeOther(`/unsubscribe?token=${encodeURIComponent(token)}&done=${done}`);
    }
    return jsonOk({ subscribed: resubscribe }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
