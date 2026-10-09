import { invoiceRequestsCsv, parseInvoiceStatus } from '../../../../lib/promos/invoice-requests';
import { referralAdminRoute } from '../../../../lib/referrals/admin-route';

/** Admin: CSV for the accountant; `?status=` as the list (default `requested`: paid, not yet invoiced). */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const raw = new URL(context.request.url).searchParams.get('status');
  const status = raw === null ? 'requested' : parseInvoiceStatus(raw);
  return new Response(await invoiceRequestsCsv(d1, status), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="invoice-requests-${status ?? 'all'}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});
