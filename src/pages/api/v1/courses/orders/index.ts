import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireUserId } from '../../../../../lib/members/policy';
import { getCourseById } from '../../../../../lib/courses/course-store';
import { listCourseOrders, toCourseOrderView } from '../../../../../lib/courses/course-orders';

/** Your course orders, newest first. */
export const GET = memberRoute(async (_ctx, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'billing:read');
  const orders = await listCourseOrders(d1, { userId });
  return jsonOk(await Promise.all(orders.map(async o => toCourseOrderView(o, await getCourseById(d1, o.course_id), env))), 200, NO_STORE);
});
