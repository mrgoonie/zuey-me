import { jsonOk } from '../../../../../../lib/http';
import { requireJsonBody } from '../../../../../../lib/members/account';
import { markInvoiceIssued } from '../../../../../../lib/promos/invoice-requests';
import { ADMIN_NO_STORE, referralAdminRoute } from '../../../../../../lib/referrals/admin-route';

/** Admin: records the invoice issued by hand. Body `{ invoice_no, note? }`; paid requests only (409 otherwise). */
export const POST = referralAdminRoute(async (context, { d1, actor }) =>
  jsonOk(await markInvoiceIssued(d1, context.params.id ?? '', await requireJsonBody(context.request), actor), 200, ADMIN_NO_STORE));
