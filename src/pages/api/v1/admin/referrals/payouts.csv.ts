import { AppError } from '../../../../../lib/http';
import { referralAdminRoute } from '../../../../../lib/referrals/admin-route';
import { parsePeriod, payoutsCsv } from '../../../../../lib/referrals/payouts';

/** Admin: CSV export of one period (`?period=YYYY-MM`, required). */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const period = parsePeriod(new URL(context.request.url).searchParams.get('period'));
  if (!period) throw new AppError(400, 'invalid_period', 'period (YYYY-MM) is required', { field: 'period' });
  return new Response(await payoutsCsv(d1, period), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="referral-payouts-${period}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});
