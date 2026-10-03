import { quotaFor } from '../../../../lib/ai/chat-service';
import { resolveDeweeConfig } from '../../../../lib/ai/dewee-client';
import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { can } from '../../../../lib/members/policy';

/** What the chat UI should show for this caller: sign-in, upgrade, unconfigured, quota. Never 401/403. */
export const GET = memberRoute(async (_ctx, { d1, env, principal }) => {
  let configured = true;
  try {
    resolveDeweeConfig(env);
  } catch {
    configured = false;
  }
  const entitled = can(principal, 'chat:use') && principal.userId !== null;
  return jsonOk({
    signed_in: principal.userId !== null,
    entitled,
    is_admin: principal.kind === 'admin',
    configured,
    quota: entitled && principal.userId ? await quotaFor(d1, env, principal, principal.userId) : null,
    login_url: '/login?next=%2Fchat',
    upgrade_url: '/pricing?plan=ai',
  }, 200, NO_STORE);
});
