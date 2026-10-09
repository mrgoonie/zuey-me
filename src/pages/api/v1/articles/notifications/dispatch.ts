import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../../../lib/http';
import { requireDb } from '../../../../../lib/booking/store';
import { dispatchArticleNotifications } from '../../../../../lib/notifications/article-notification-dispatch';
import { timingSafeEqualStrings } from '../../../../../lib/payments/sepay';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/** True when the request carries `Authorization: Bearer <CRON_SECRET>` (the Cloudflare cron worker). */
async function isCronCaller(request: Request, secret: string | undefined): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return Boolean(secret && match && (await timingSafeEqualStrings(match[1].trim(), secret)));
}

/** Cron/admin: send due new-article emails within the warm-up budget. Idempotent; safe to call every few minutes. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    if (!(await isCronCaller(request, env.CRON_SECRET))) await requireAdminActor(request, env);
    return jsonOk(await dispatchArticleNotifications(requireDb(env), env), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

export const GET: APIRoute = () => jsonError(405, 'method_not_allowed', 'Use POST');
