import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { getUserById } from '../../../../../lib/members/users';
import { getCourseById } from '../../../../../lib/courses/course-store';
import type { CourseOrderStatus } from '../../../../../lib/courses/course-orders';
import { listCourseOrders, toCourseOrderView } from '../../../../../lib/courses/course-orders';

const STATUSES: CourseOrderStatus[] = ['pending', 'paid', 'expired', 'needs_attention', 'refunded', 'charged_back', 'cancelled'];

/** Admin: course orders, newest first (`?status=needs_attention` for the review queue). */
export const GET = memberRoute(async ({ request }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const raw = new URL(request.url).searchParams.get('status');
  const status = STATUSES.find(s => s === raw);
  const orders = await listCourseOrders(d1, { status, limit: 200 });
  return jsonOk(await Promise.all(orders.map(async o => ({
    ...toCourseOrderView(o, await getCourseById(d1, o.course_id), env),
    user_id: o.user_id,
    user_email: (await getUserById(d1, o.user_id))?.email ?? null,
  }))), 200, NO_STORE);
});
