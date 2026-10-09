import { InvoiceRequestsPanel } from './promos/InvoiceRequestsPanel';
import { PromoCodesPanel } from './promos/PromoCodesPanel';

/** Studio admin for promo codes ("Mã ưu đãi" at checkout). */
export function PromosTab() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-stone-800">
        <h2 className="text-lg font-bold text-white font-serif">Promo codes</h2>
        <p className="text-xs text-stone-400">Percent-off codes for membership, consultations and courses: date window, use limits, product limits and card months.</p>
      </div>
      <PromoCodesPanel />
    </div>
  );
}

/** Studio admin for business invoice requests from bank-transfer (SePay) orders. */
export function InvoicesTab() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-stone-800">
        <h2 className="text-lg font-bold text-white font-serif">Invoices</h2>
        <p className="text-xs text-stone-400">Customers who entered a tax ID (MST) when paying by bank transfer. Issue the e-invoice by hand, then record its number.</p>
      </div>
      <InvoiceRequestsPanel />
    </div>
  );
}
