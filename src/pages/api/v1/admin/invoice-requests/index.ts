import { jsonOk } from '../../../../../lib/http';
import { listInvoiceRequests, parseInvoiceStatus } from '../../../../../lib/promos/invoice-requests';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../lib/referrals/admin-route';

/** Admin: business invoice requests; `?status=requested|issued|awaiting_payment|cancelled|all` (default all). */
export const GET = referralAdminRoute(async (context, { d1 }) => {
  const params = new URL(context.request.url).searchParams;
  const invoice_requests = await listInvoiceRequests(d1, { status: parseInvoiceStatus(params.get('status')) });
  return jsonOk({ invoice_requests }, 200, ADMIN_NO_STORE);
});
