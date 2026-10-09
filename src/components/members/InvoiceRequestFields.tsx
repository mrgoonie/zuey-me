import { useId, useState } from 'react';
import { input } from './member-ui';

/** Same rule as the server: 10 digits, or 10 digits-3 digits for a branch. */
const TAX_ID_RE = /^\d{10}(-\d{3})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InvoiceRequestState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  taxId: string;
  setTaxId: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  /** `invoice` body field, null when not requested; `error` when requested but incomplete. */
  payload: () => { invoice: { tax_id: string; email: string } | null; error: string | null };
}

export function useInvoiceRequest(): InvoiceRequestState {
  const [enabled, setEnabled] = useState(false);
  const [taxId, setTaxId] = useState('');
  const [email, setEmail] = useState('');
  const payload = () => {
    if (!enabled) return { invoice: null, error: null };
    const t = taxId.trim();
    const e = email.trim();
    if (!TAX_ID_RE.test(t)) return { invoice: null, error: 'Mã số thuế gồm 10 chữ số (hoặc 10 chữ số-3 chữ số cho chi nhánh).' };
    if (!EMAIL_RE.test(e)) return { invoice: null, error: 'Nhập email nhận hoá đơn hợp lệ.' };
    return { invoice: { tax_id: t, email: e }, error: null };
  };
  return { enabled, setEnabled, taxId, setTaxId, email, setEmail, payload };
}

interface Props {
  state: InvoiceRequestState;
  className?: string;
}

/**
 * "Xuất hoá đơn công ty" for bank-transfer (SePay) checkouts: tax ID + email only. The invoice is issued by
 * hand after the payment arrives; card payments get the provider's receipt instead.
 */
export function InvoiceRequestFields({ state, className = '' }: Props) {
  const id = useId();
  return (
    <div className={`rounded-2xl border border-stone-200/90 bg-[#F5EFEB] p-3 sm:p-4 text-stone-900 min-w-0 ${className}`}>
      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={state.enabled} onChange={e => state.setEnabled(e.target.checked)} />
        <span>
          <span className="font-semibold">Xuất hoá đơn công ty (VAT)</span>
          <span className="block text-xs text-stone-600">Chỉ áp dụng khi chuyển khoản VietQR. Hoá đơn điện tử được gửi tới email bên dưới sau khi nhận thanh toán.</span>
        </span>
      </label>
      {state.enabled && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor={`${id}-tax`} className="block text-xs font-semibold text-stone-700 mb-1">Mã số thuế</label>
            <input
              id={`${id}-tax`} className={`${input} font-mono`} inputMode="numeric" autoComplete="off" placeholder="0101234567"
              maxLength={14} value={state.taxId} onChange={e => state.setTaxId(e.target.value)}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor={`${id}-email`} className="block text-xs font-semibold text-stone-700 mb-1">Email nhận hoá đơn</label>
            <input
              id={`${id}-email`} className={input} type="email" autoComplete="email" placeholder="ketoan@congty.vn"
              maxLength={254} value={state.email} onChange={e => state.setEmail(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
