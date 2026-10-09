import { useState } from 'react';
import type { PlansCatalog } from '../../lib/members/account';
import { ReferralCodeField } from '../referral/ReferralCodeField';
import { useReferralQuote } from '../referral/referral-quote';
import { alertError, alertInfo, btnGhost, btnPrimary, callApi, fmtUsd, fmtVnd, isRecord, jsonBody, loginUrl, str } from './member-ui';

interface Props {
  catalog: PlansCatalog;
  initialPlan: string | null;
  initialMonths: number;
}

const MONTH_LABEL: Record<number, string> = { 1: '1 tháng', 3: '3 tháng', 6: '6 tháng', 12: '12 tháng' };

type Provider = 'sepay' | 'dodo';

/**
 * Plan cards. SePay prepays 1/3/6/12 months by VietQR; when Dodo is configured a plan can also be a
 * monthly USD card subscription. Checkout is an explicit click; the status page shows the server state.
 * Referral prices come from the client-side quote so the page itself stays publicly cacheable.
 */
export function PricingTable({ catalog, initialPlan, initialMonths }: Props) {
  const [months, setMonths] = useState(catalog.months.includes(initialMonths) ? initialMonths : 1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cardPlans = new Set(catalog.card_plans);
  const referral = useReferralQuote();
  const referralPercent = referral.quote?.referral?.discount_percent ?? 0;
  const quoteFor = (plan: string) => (referralPercent > 0 ? referral.quote?.plans.find(p => p.plan === plan && p.months === months) ?? null : null);
  const cardFirst = (plan: string) => (referralPercent > 0 ? referral.quote?.card_first_month.find(c => c.plan === plan) ?? null : null);
  // The prepay discount depends only on the term, so any plan's price list carries it.
  const discountFor = (m: number) => catalog.plans[0]?.prices.find(p => p.months === m)?.discount_percent ?? 0;
  const discountNote = catalog.months.filter(m => discountFor(m) > 0).map(m => `${m} tháng −${discountFor(m)}%`).join(', ');

  async function checkout(planId: string, provider: Provider) {
    if (busy) return;
    setBusy(`${planId}:${provider}`);
    setError(null);
    const code = referral.enteredCode ? { referral_code: referral.enteredCode } : {};
    const payload = provider === 'dodo' ? { plan: planId, provider, ...code } : { plan: planId, months, provider, ...code };
    const res = await callApi('/api/v1/billing/orders', { method: 'POST', body: jsonBody(payload) });
    if (res.ok && isRecord(res.data)) {
      if (provider === 'dodo' && str(res.data, 'checkout_url')) {
        window.location.assign(str(res.data, 'checkout_url'));
        return;
      }
      if (provider === 'sepay' && str(res.data, 'code')) {
        window.location.assign(`/billing/${encodeURIComponent(str(res.data, 'code'))}`);
        return;
      }
    }
    setBusy(null);
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
              {discountFor(m) > 0 && <span className="block text-[10px] sm:text-[11px] font-bold opacity-80">−{discountFor(m)}%</span>}
            </label>
          ))}
        </div>
        <p className="mt-2 text-center text-xs text-stone-300">Áp dụng cho chuyển khoản ngân hàng (VietQR): trả trước, không tự động gia hạn{discountNote && `; giảm giá khi trả trước: ${discountNote}`}.</p>
      </fieldset>

      <ReferralCodeField
        state={referral} percent={referralPercent} className="mx-auto w-full max-w-[520px]"
        note="Giảm cho đơn đầu tiên, sau giảm giá trả trước (thẻ quốc tế: tháng đầu)."
      />

      <div aria-live="polite" role="status" className="empty:hidden mx-auto w-full max-w-[720px]">
        {error && <p className={alertError}>{error}</p>}
        {!catalog.billing_configured && cardPlans.size === 0 && <p className={alertInfo}>Thanh toán đang tạm đóng trong lúc cấu hình. Bạn vẫn có thể xem các gói; vui lòng quay lại sau.</p>}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 min-w-0">
        {catalog.plans.map(plan => {
          const price = plan.prices.find(p => p.months === months);
          const ref = quoteFor(plan.id);
          const card = cardFirst(plan.id);
          const highlighted = plan.id === initialPlan;
          const titleId = `plan-${plan.id}`;
          return (
            <li key={plan.id} className={`flex flex-col min-w-0 bg-[#F5EFEB] rounded-[28px] border p-5 text-stone-900 shadow-floating-card ${highlighted ? 'border-amber-500 ring-2 ring-amber-400' : 'border-stone-200/90'}`} aria-labelledby={titleId}>
              <h2 id={titleId} className="text-xl font-bold font-serif">{plan.name}</h2>
              <p className="mt-1 text-sm text-stone-600">{plan.tagline}</p>
              <p className="mt-4"><span className="text-3xl font-bold">{fmtUsd(plan.price_usd_cents)}</span><span className="text-sm text-stone-600">/tháng</span></p>
              <p className="mt-1 text-sm text-stone-700 tabular-nums">
                {price && price.amount_vnd !== null
                  ? <>{MONTH_LABEL[months]}: <strong>{fmtVnd(price.amount_vnd)}</strong>{price.discount_percent > 0 && <> <span className="text-emerald-700 font-semibold">(−{price.discount_percent}%)</span></>}</>
                  : <>{MONTH_LABEL[months]}: {price ? fmtUsd(price.amount_usd_cents) : '—'}</>}
              </p>
              {ref && ref.amount_vnd !== null && ref.discounted_vnd !== null && (
                <p className="mt-1 text-sm tabular-nums">
                  <span className="text-stone-500 line-through">{fmtVnd(ref.amount_vnd)}</span>{' '}
                  <strong className="text-emerald-800">{fmtVnd(ref.discounted_vnd)}</strong>{' '}
                  <span className="text-xs font-semibold text-emerald-800">giới thiệu −{referralPercent}%</span>
                </p>
              )}
              <ul className="mt-4 grid gap-1.5 text-sm text-stone-800 flex-1">
                {plan.features.map(f => (
                  <li key={f} className="flex gap-2 min-w-0"><span aria-hidden="true" className="text-amber-600">✓</span><span className="min-w-0 break-words">{f}</span></li>
                ))}
              </ul>
              {catalog.billing_configured && (
                <button
                  type="button" className={`${highlighted ? btnPrimary : btnGhost} mt-5 w-full`}
                  onClick={() => checkout(plan.id, 'sepay')}
                  disabled={busy !== null}
                  aria-describedby={titleId}
                >
                  {busy === `${plan.id}:sepay` ? 'Đang tạo đơn…' : `Chọn ${plan.name} · VietQR`}
                </button>
              )}
              {cardPlans.has(plan.id) && (
                <button
                  type="button" className={`${catalog.billing_configured ? btnGhost : highlighted ? btnPrimary : btnGhost} mt-2 w-full`}
                  onClick={() => checkout(plan.id, 'dodo')}
                  disabled={busy !== null}
                  aria-describedby={titleId}
                >
                  {busy === `${plan.id}:dodo` ? 'Đang mở trang thanh toán…' : card ? `Thẻ quốc tế · tháng đầu ${fmtUsd(card.discounted_usd_cents)}` : 'Thẻ quốc tế (USD, Dodo)'}
                </button>
              )}
              {!catalog.billing_configured && !cardPlans.has(plan.id) && (
                <button type="button" className={`${btnGhost} mt-5 w-full`} disabled aria-describedby={titleId}>Tạm đóng</button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-center text-xs text-stone-300 max-w-[720px] mx-auto">
        Giá niêm yết bằng USD; số tiền chuyển khoản tính theo VND (làm tròn lên 1.000 ₫ mỗi tháng). Gói được kích hoạt ngay khi hệ thống nhận được chuyển khoản, và cộng dồn nếu bạn gia hạn sớm.
        {cardPlans.size > 0 && ' Thẻ quốc tế thanh toán bằng USD qua Dodo Payments, tự gia hạn hằng tháng và huỷ được bất cứ lúc nào trong mục Tài khoản.'}
      </p>
    </div>
  );
}
