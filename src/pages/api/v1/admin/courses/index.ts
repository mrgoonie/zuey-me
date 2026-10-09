import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { createCourse, listCourses } from '../../../../../lib/courses/course-store';

/** Admin: every course including drafts and archived ones. */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await listCourses(d1, { includeDrafts: true }), 200, NO_STORE);
});

/** Admin: create a course (starts as a draft). */
export const POST = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await createCourse(d1, await requireJsonBody(request)), 201, NO_STORE);
});
