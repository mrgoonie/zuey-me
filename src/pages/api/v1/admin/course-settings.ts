import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { DEFAULT_PLAN_DISCOUNTS, getPlanDiscountTable, setPlanDiscountTable } from '../../../../lib/courses/course-pricing';

/** Admin: subscriber discount % per plan applied to every course (courses may override). */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk({ plan_discounts: await getPlanDiscountTable(d1), defaults: DEFAULT_PLAN_DISCOUNTS }, 200, NO_STORE);
});

/** Body: { plan_discounts: { knowledges?, ai?, combo?, community? } } (integers 0–90). */
export const PUT = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const body = await requireJsonBody(request);
  const table = typeof body.plan_discounts === 'object' && body.plan_discounts !== null ? body.plan_discounts as Record<string, unknown> : body;
  return jsonOk({ plan_discounts: await setPlanDiscountTable(d1, table) }, 200, NO_STORE);
});
