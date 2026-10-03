import { AppError, jsonOk } from '../../../../lib/http';
import { NO_STORE, buildMeView, memberRoute, requireJsonBody, requireUser } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { MEMBER_COOKIE, clearMemberCookie, memberCookie, readCookie } from '../../../../lib/members/session';
import { deleteAccount, logActivity, parseProfileInput, updateUserProfile } from '../../../../lib/members/users';

/** The signed-in member (session or personal API key with account:read). Refreshes the 30-day session cookie. */
export const GET = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'account:read');
  const headers: Record<string, string> = { ...NO_STORE };
  const token = principal.via === 'member_session' ? readCookie(request, MEMBER_COOKIE) : null;
  if (token) headers['Set-Cookie'] = memberCookie(token);
  return jsonOk(await buildMeView(d1, principal), 200, headers);
});

/** Update display name, avatar URL and locale. */
export const PATCH = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'account:write');
  const user = requireUser(principal);
  const input = parseProfileInput(await requireJsonBody(request));
  await updateUserProfile(d1, user, input);
  await logActivity(d1, user.id, 'profile.updated', { fields: Object.keys(input) }, request);
  const refreshed = { ...principal, user: { ...user, ...input } };
  return jsonOk(await buildMeView(d1, refreshed), 200, NO_STORE);
});

/** Delete the account. Body: { confirm_email } must equal the account email. Session only. */
export const DELETE = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  const body = await requireJsonBody(request);
  const confirm = typeof body.confirm_email === 'string' ? body.confirm_email.trim().toLowerCase() : '';
  if (confirm !== user.email) {
    throw new AppError(400, 'confirmation_required', 'Type your account email in confirm_email to delete the account', { field: 'confirm_email' });
  }
  await deleteAccount(d1, user);
  return jsonOk({ deleted: true }, 200, { ...NO_STORE, 'Set-Cookie': clearMemberCookie() });
});
