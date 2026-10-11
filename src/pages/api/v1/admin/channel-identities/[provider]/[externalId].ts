import { runtimeWaitUntil } from '../../../../../../lib/blocks/articles';
import { adminGetChannelIdentity, adminUnlinkChannelIdentity, parseChannelRef, parseUnlinkReason } from '../../../../../../lib/channel-access/admin';
import { AppError, jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';
import { adminLabel } from '../../../../../../lib/members/billing-attention';
import { requireCan } from '../../../../../../lib/members/policy';

/** Admin: which member holds this chat account. */
export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await adminGetChannelIdentity(d1, parseChannelRef(params.provider, params.externalId)), 200, NO_STORE);
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
  const ref = parseChannelRef(params.provider, params.externalId);
  const reason = await readReason(request);
  const result = await adminUnlinkChannelIdentity(d1, env, ref, {
    admin: adminLabel(principal), reason, request, waitUntil: runtimeWaitUntil(locals.runtime),
  });
  return jsonOk(result, 200, NO_STORE);
});
