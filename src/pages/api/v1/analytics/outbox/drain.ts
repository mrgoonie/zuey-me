import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { analyticsEnvFrom } from '../../../../../lib/analytics/destinations/posthog';
import { MAX_DRAIN_LIMIT, drainAnalyticsOutbox } from '../../../../../lib/analytics/outbox';
import { isServerCaptureHost, serverDestinations } from '../../../../../lib/analytics/server';
import { isCronCaller } from '../../../../../lib/cron-auth';
import { requireMembersDb } from '../../../../../lib/members/runtime';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

function parseLimit(body: Record<string, unknown> | null): number | undefined {
  const limit = body?.limit;
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_DRAIN_LIMIT) {
    throw new AppError(400, 'invalid_field', `limit must be an integer from 1 to ${MAX_DRAIN_LIMIT}`, { field: 'limit' });
  }
  return limit;
}

/**
 * Cron/admin: deliver due analytics outbox events (retry with backoff, dead letter after the last attempt)
 * and queue `subscription_expired` for plans that just ended. Delivers only on the production hostnames
 * (or with PUBLIC_ANALYTICS_DEBUG); elsewhere the run is `skipped` and every row stays queued. Idempotent.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    if (!(await isCronCaller(request, env.CRON_SECRET))) await requireAdminActor(request, env);
    const limit = parseLimit(await readJsonObject(request));
    const d1 = requireMembersDb(env);
    const analyticsEnv = analyticsEnvFrom(env);
    const host = new URL(request.url).hostname;
    const destinations = serverDestinations(analyticsEnv, { requestHost: host });
    const result = await drainAnalyticsOutbox(d1, { destinations, limit });
    const skippedReason = result.status !== 'skipped' ? null : isServerCaptureHost(analyticsEnv, host) ? 'analytics_disabled' : 'not_production_host';
    return jsonOk({ ...result, skipped_reason: skippedReason }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

export const GET: APIRoute = () => jsonError(405, 'method_not_allowed', 'Use POST');
