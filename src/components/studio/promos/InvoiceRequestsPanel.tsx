import { useCallback, useEffect, useState } from 'react';
import { Flash, Pill, adminApi, btn, btnPrimary, field, list, n, nn, panel, row, s, sn, vnd, when, type FlashMessage } from '../referrals/referral-admin-kit';

const STATUSES = ['requested', 'issued', 'awaiting_payment', 'cancelled', 'all'] as const;
type StatusFilter = (typeof STATUSES)[number];

interface InvoiceRequest {
  id: string; source_kind: string; source_code: string; tax_id: string; email: string; description: string;
  amount_vnd: number; amount_paid_vnd: number | null; status: string; paid_at: string | null;
  invoice_no: string | null; issued_at: string | null; note: string | null; created_at: string;
}

function toInvoice(r: Record<string, unknown>): InvoiceRequest {
  return {
    id: s(r, 'id'), source_kind: s(r, 'source_kind'), source_code: s(r, 'source_code'), tax_id: s(r, 'tax_id'), email: s(r, 'email'),
    description: s(r, 'description'), amount_vnd: n(r, 'amount_vnd'), amount_paid_vnd: nn(r, 'amount_paid_vnd'), status: s(r, 'status'),
    paid_at: sn(r, 'paid_at'), invoice_no: sn(r, 'invoice_no'), issued_at: sn(r, 'issued_at'), note: sn(r, 'note'), created_at: s(r, 'created_at'),
  };
}

const PILL: Record<string, string> = { requested: 'pending', issued: 'paid', awaiting_payment: 'draft', cancelled: 'cancelled' };

/**
 * Studio "Invoices": business (VAT) invoice requests from bank-transfer orders. Admins are emailed when an
 * order is paid; the invoice is issued by hand in the e-invoice system and its number recorded here.
 */
export function InvoiceRequestsPanel() {
  const [status, setStatus] = useState<StatusFilter>('requested');
  const [items, setItems] = useState<InvoiceRequest[]>([]);
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>('load');
  const [message, setMessage] = useState<FlashMessage>(null);

  const load = useCallback(async () => {
    setBusy('load');
    const r = await adminApi(`/api/v1/admin/invoice-requests?status=${status}`);
    setBusy(null);
    if (r.ok) setItems(list(r.data.invoice_requests).map(toInvoice)); else setMessage({ kind: 'error', text: r.message });
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const issue = async (inv: InvoiceRequest) => {
    const invoiceNo = (numbers[inv.id] ?? inv.invoice_no ?? '').trim();
    if (!invoiceNo) { setMessage({ kind: 'error', text: `${inv.source_code}: enter the invoice number first.` }); return; }
    setBusy(inv.id); setMessage(null);
    const r = await adminApi(`/api/v1/admin/invoice-requests/${encodeURIComponent(inv.id)}/issue`, { method: 'POST', body: { invoice_no: invoiceNo } });
    setBusy(null);
    if (!r.ok) { setMessage({ kind: 'error', text: `${inv.source_code}: ${r.message}` }); return; }
    const saved = toInvoice(r.data);
    setItems(prev => (status === 'requested' ? prev.filter(i => i.id !== saved.id) : prev.map(i => (i.id === saved.id ? saved : i))));
    setMessage({ kind: 'ok', text: `${saved.source_code}: invoice ${saved.invoice_no} recorded.` });
  };

  return (
    <section aria-labelledby="invoice-requests" className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="invoice-requests" className="font-bold text-white text-sm">Invoice requests · {items.length}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-stone-400">Status
            <select className={field} value={status} onChange={e => setStatus(STATUSES.find(x => x === e.target.value) ?? 'requested')}>
              {STATUSES.map(x => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
            </select>
          </label>
          <a className={btn} href={`/api/v1/admin/invoice-requests.csv?status=${status}`} download>CSV</a>
        </div>
      </div>
      <p className="text-[11px] text-stone-500">“requested” = paid and waiting for an invoice. Issue it in the e-invoice system, then record its number.</p>
      <Flash message={message} />
      {busy !== 'load' && items.length === 0 && <p className="text-xs text-stone-400">Nothing here.</p>}
      <ul className="space-y-3">
        {items.map(inv => (
          <li key={inv.id} className={row}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="font-mono font-bold text-white">{inv.source_code}</span>
                <Pill status={PILL[inv.status] ?? inv.status}>{inv.status.replace('_', ' ')}</Pill>
                <span className="text-stone-400 truncate">{inv.description}</span>
              </div>
              <span className="tabular-nums font-semibold text-white">{vnd(inv.amount_paid_vnd ?? inv.amount_vnd)}</span>
            </div>
            <p className="tabular-nums">MST <span className="font-mono text-white select-all">{inv.tax_id}</span> · email <span className="select-all">{inv.email}</span> · paid {when(inv.paid_at)}</p>
            {inv.status === 'issued' && <p className="text-emerald-300">Invoice <span className="font-mono">{inv.invoice_no}</span> · {when(inv.issued_at)}</p>}
            {(inv.status === 'requested' || inv.status === 'issued') && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className={`${field} font-mono`} placeholder="Invoice number" aria-label={`Invoice number for ${inv.source_code}`} maxLength={64}
                  value={numbers[inv.id] ?? inv.invoice_no ?? ''} onChange={e => setNumbers(prev => ({ ...prev, [inv.id]: e.target.value }))}
                />
                <button type="button" className={btnPrimary} onClick={() => void issue(inv)} disabled={busy === inv.id}>
                  {inv.status === 'issued' ? 'Update number' : 'Mark issued'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
