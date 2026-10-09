import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { AppError } from '../../../../lib/http';
import { listCourseLocks, lockCourseAccess, unlockCourseAccess } from '../../../../lib/members/account-flags';

function userIdOf(body: Record<string, unknown>): string {
  if (typeof body.user_id !== 'string' || !body.user_id) throw new AppError(400, 'invalid_field', 'user_id is required', { field: 'user_id' });
  return body.user_id;
}

/** Admin: accounts whose course access is locked. */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk({ locks: await listCourseLocks(d1) }, 200, NO_STORE);
});

/** Admin: lock course access for an account. Body: { user_id, reason }. */
export const POST = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const body = await requireJsonBody(request);
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'admin';
  await lockCourseAccess(d1, userIdOf(body), reason);
  return jsonOk({ locked: true }, 200, NO_STORE);
});

/** Admin: lift a lock. Body: { user_id }. */
export const DELETE = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk({ unlocked: await unlockCourseAccess(d1, userIdOf(await requireJsonBody(request))) }, 200, NO_STORE);
});
