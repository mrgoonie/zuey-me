import { NO_STORE, memberRoute, requireUser } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { exportAccount, logActivity } from '../../../../lib/members/users';

/** Download everything stored about your account as JSON (no secrets or token hashes). */
export const GET = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'account:read');
  const user = requireUser(principal);
  const data = await exportAccount(d1, user);
  await logActivity(d1, user.id, 'account.exported', null, request);
  return new Response(JSON.stringify({ success: true, data }, null, 2), {
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="zuey-account-${user.id}.json"`,
    },
  });
});
