import { runtimeWaitUntil } from '../../../../../../lib/blocks/articles';
import type { ChannelRef } from '../../../../../../lib/channel-access/admin';
import { adminGetChannelIdentity, adminUnlinkChannelIdentity, decodePathParam, parseChannelRef, parseUnlinkReason } from '../../../../../../lib/channel-access/admin';
import { AppError, jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';
import { requireCan } from '../../../../../../lib/members/policy';

/** Path params arrive still percent-encoded (`777%3A002`); decode once, then validate. */
function refFromParams(params: Record<string, string | undefined>): ChannelRef {
  return parseChannelRef(params.provider, decodePathParam(params.externalId, 'external_id'));
}

/** Admin: which member holds this chat account. */
export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await adminGetChannelIdentity(d1, refFromParams(params)), 200, NO_STORE);
});

/** Optional JSON body `{ reason }`; an empty body is allowed (scripted calls still send Content-Type: application/json). */
async function readReason(request: Request): Promise<string | null> {
  const text = await request.text();
  if (!text.trim()) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
  return parseUnlinkReason('reason' in body ? body.reason : undefined);
}

/** Admin: unlink this chat account from whichever member holds it; dewee is told to re-check the sender at once. */
export const DELETE = memberRoute(async ({ params, request, locals }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const ref = refFromParams(params);
  const reason = await readReason(request);
  const result = await adminUnlinkChannelIdentity(d1, env, ref, { principal, reason, waitUntil: runtimeWaitUntil(locals.runtime) });
  return jsonOk(result, 200, NO_STORE);
});
