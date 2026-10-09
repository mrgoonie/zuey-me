import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../../../lib/http';
import { requireDb } from '../../../../../lib/booking/store';
import { processGithubInvites } from '../../../../../lib/courses/course-github-invites';
import { timingSafeEqualStrings } from '../../../../../lib/payments/sepay';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

async function isCronCaller(request: Request, secret: string | undefined): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return Boolean(secret && match && (await timingSafeEqualStrings(match[1].trim(), secret)));
}

/** Cron/admin: process due GitHub repository invitations and removals. Idempotent. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    if (!(await isCronCaller(request, env.CRON_SECRET))) await requireAdminActor(request, env);
    return jsonOk(await processGithubInvites(requireDb(env), env), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

export const GET: APIRoute = () => jsonError(405, 'method_not_allowed', 'Use POST');
