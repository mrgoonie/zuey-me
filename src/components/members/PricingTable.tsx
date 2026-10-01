import { useState } from 'react';
import type { PlansCatalog } from '../../lib/members/account';
import { alertError, alertInfo, btnGhost, btnPrimary, callApi, fmtUsd, fmtVnd, isRecord, jsonBody, loginUrl, str } from './member-ui';

interface Props {
  catalog: PlansCatalog;
  initialPlan: string | null;
  initialMonths: number;
}

const MONTH_LABEL: Record<number, string> = { 1: '1 tháng', 3: '3 tháng', 6: '6 tháng', 12: '12 tháng' };

/** Plan cards with a prepay-length selector; checkout is an explicit click that creates a SePay order. */
export function PricingTable({ catalog, initialPlan, initialMonths }: Props) {
  const [months, setMonths] = useState(catalog.months.includes(initialMonths) ? initialMonths : 1);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function checkout(planId: string) {
    if (busyPlan) return;
    setBusyPlan(planId);
    setError(null);
    const res = await callApi('/api/v1/billing/orders', { method: 'POST', body: jsonBody({ plan: planId, months }) });
    if (res.ok && isRecord(res.data) && str(res.data, 'code')) {
      window.location.assign(`/billing/${encodeURIComponent(str(res.data, 'code'))}`);
      return;
    }
    setBusyPlan(null);
    if (!res.ok && res.status === 401) {
      window.location.assign(loginUrl(`/pricing?plan=${planId}&months=${months}`));
      return;
    }
    setError(res.ok ? 'Không tạo được đơn hàng. Vui lòng thử lại.' : res.message);
  }

  return (
    <div className="w-full max-w-[1100px] mx-auto grid gap-5 min-w-0">
      <fieldset className="mx-auto w-full max-w-[520px] min-w-0">
        <legend className="sr-only">Thời hạn trả trước</legend>
        <div className="grid grid-cols-4 gap-1 rounded-full bg-[#F5EFEB] p-1 border border-stone-200/90">
          {catalog.months.map(m => (
            <label key={m} className={`cursor-pointer rounded-full px-1 py-2 text-center text-xs sm:text-sm font-semibold focus-within:ring-2 focus-within:ring-amber-500 ${months === m ? 'bg-stone-900 text-amber-50' : 'text-stone-700 hover:bg-white/70'}`}>
              <input type="radio" name="months" value={m} checked={months === m} onChange={() => setMonths(m)} className="sr-only" />
              {MONTH_LABEL[m] ?? `${m} tháng`}
            </label>
          ))}
        </div>
        <p className="mt-2 text-center text-xs text-stone-300">Trả trước qua chuyển khoản ngân hàng (VietQR). Không tự động gia hạn, không giảm giá theo kỳ.</p>
      </fieldset>

      <div aria-live="polite" role="status" className="empty:hidden mx-auto w-full max-w-[720px]">
        {error && <p className={alertError}>{error}</p>}
        {!catalog.billing_configured && <p className={alertInfo}>Thanh toán đang tạm đóng trong lúc cấu hình. Bạn vẫn có thể xem các gói; vui lòng quay lại sau.</p>}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 min-w-0">
        {catalog.plans.map(plan => {
          const price = plan.prices.find(p => p.months === months);
          const highlighted = plan.id === initialPlan;
          const titleId = `plan-${plan.id}`;
          return (
            <li key={plan.id} className={`flex flex-col min-w-0 bg-[#F5EFEB] rounded-[28px] border p-5 text-stone-900 shadow-floating-card ${highlighted ? 'border-amber-500 ring-2 ring-amber-400' : 'border-stone-200/90'}`} aria-labelledby={titleId}>
              <h2 id={titleId} className="text-xl font-bold font-serif">{plan.name}</h2>
              <p className="mt-1 text-sm text-stone-600">{plan.tagline}</p>
              <p className="mt-4"><span className="text-3xl font-bold">{fmtUsd(plan.price_usd_cents)}</span><span className="text-sm text-stone-600">/tháng</span></p>
              <p className="mt-1 text-sm text-stone-700 tabular-nums">
                {price && price.amount_vnd !== null
                  ? <>{MONTH_LABEL[months]}: <strong>{fmtVnd(price.amount_vnd)}</strong></>
                  : <>{MONTH_LABEL[months]}: {price ? fmtUsd(price.amount_usd_cents) : '—'}</>}
              </p>
              <ul className="mt-4 grid gap-1.5 text-sm text-stone-800 flex-1">
                {plan.features.map(f => (
                  <li key={f} className="flex gap-2 min-w-0"><span aria-hidden="true" className="text-amber-600">✓</span><span className="min-w-0 break-words">{f}</span></li>
                ))}
              </ul>
              <button
                type="button" className={`${highlighted ? btnPrimary : btnGhost} mt-5 w-full`}
                onClick={() => checkout(plan.id)}
                disabled={!catalog.billing_configured || busyPlan !== null}
                aria-describedby={titleId}
              >
                {busyPlan === plan.id ? 'Đang tạo đơn…' : `Chọn ${plan.name}`}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-center text-xs text-stone-300 max-w-[720px] mx-auto">
        Giá niêm yết bằng USD; số tiền chuyển khoản tính theo VND (làm tròn lên 1.000 ₫ mỗi tháng). Gói được kích hoạt ngay khi hệ thống nhận được chuyển khoản, và cộng dồn nếu bạn gia hạn sớm.
      </p>
    </div>
  );
}
