import { AppError, jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireUserId } from '../../../../../lib/members/policy';
import { ownsCourse } from '../../../../../lib/courses/course-access';
import { enqueueGithubSync, listGithubInvites } from '../../../../../lib/courses/course-github-invites';
import { requireVisibleCourse } from '../../../../../lib/courses/course-store';

/** Your GitHub repository access for an owned course. */
export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  const userId = requireUserId(principal, 'account:read');
  const course = await requireVisibleCourse(d1, params.course ?? '', false);
  return jsonOk(await listGithubInvites(d1, userId, course.id), 200, NO_STORE);
});

/** Queue the repository invitations again (after linking GitHub at /account, or a declined invite). */
export const POST = memberRoute(async ({ params }, { d1, principal }) => {
  const userId = requireUserId(principal, 'account:write');
  const course = await requireVisibleCourse(d1, params.course ?? '', false);
  if (!(await ownsCourse(d1, userId, course.id))) throw new AppError(403, 'purchase_required', 'Buy this course to access its repositories');
  await enqueueGithubSync(d1, userId, course, 'invite');
  return jsonOk(await listGithubInvites(d1, userId, course.id), 200, NO_STORE);
});
