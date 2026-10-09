import { useId, useState } from 'react';
import { btnGhost, input, type SubmitLike } from '../members/member-ui';
import type { ReferralQuoteState } from './referral-quote';

interface Props {
  state: ReferralQuoteState;
  /** Discount shown for the active referral (membership or booking percent). */
  percent: number | null;
  /** Discount the typed promo code gives this purchase (0 when it does not apply here). */
  promoPercent?: number;
  /** Extra copy under the active referral line (e.g. "first order only"). */
  note?: string;
  className?: string;
}

/**
 * "Mã ưu đãi" box for checkout surfaces: takes a promo code or a referral code, and shows the discount that
 * will apply (the larger of the promo and the referral; they never stack). The quote is display-only; the
 * server re-validates the code at checkout.
 */
export function ReferralCodeField({ state, percent, promoPercent = 0, note, className = '' }: Props) {
  const [value, setValue] = useState('');
  const fieldId = useId();
  const active = state.quote?.referral ?? null;
  const promo = state.promo;
  const promoWins = promo !== null && promoPercent > (percent ?? 0);

  const submit = (e: SubmitLike) => {
    e.preventDefault();
    void state.apply(value);
  };

  return (
    <div className={`rounded-2xl border border-stone-200/90 bg-[#F5EFEB] p-3 sm:p-4 text-stone-900 min-w-0 ${className}`}>
      {promo && (
        <p className="mb-2 text-sm">
          {promoWins
            ? <span className="font-semibold text-emerald-800">Mã ưu đãi −{promoPercent}%</span>
            : <span className="font-semibold text-stone-700">Mã ưu đãi <span className="font-mono">{promo.code}</span> {promoPercent > 0 ? `(−${promoPercent}%) thấp hơn ưu đãi giới thiệu nên không dùng` : 'không áp dụng cho lựa chọn này'}</span>}
          {promoWins && <span className="text-stone-700"> · mã <span className="font-mono">{promo.code}</span></span>}
          {promoWins && promo.card_cycles > 1 && <span className="block text-xs text-stone-600">Thẻ quốc tế: giảm {promo.card_cycles} tháng đầu.</span>}
        </p>
      )}
      {active && percent !== null && percent > 0 && !promoWins && (
        <p className="mb-2 text-sm">
          <span className="font-semibold text-emerald-800">Ưu đãi giới thiệu −{percent}%</span>
          <span className="text-stone-700"> · mã <span className="font-mono">{active.code}</span></span>
          {note && <span className="block text-xs text-stone-600">{note}{active.provisional && ' Áp dụng khi tài khoản chưa từng thanh toán.'}</span>}
        </p>
      )}
      <form className="flex flex-col sm:flex-row gap-2" onSubmit={submit}>
        <label htmlFor={fieldId} className="sr-only">Mã ưu đãi</label>
        <input
          id={fieldId} className={`${input} font-mono`} placeholder="Mã ưu đãi" autoComplete="off" autoCapitalize="none" spellCheck={false}
          maxLength={32} value={value} onChange={e => setValue(e.target.value)}
        />
        <div className="flex gap-2 shrink-0">
          <button type="submit" className={`${btnGhost} flex-1 sm:flex-none`} disabled={state.busy || value.trim() === ''}>{state.busy ? 'Đang kiểm tra…' : 'Áp dụng'}</button>
          {state.enteredCode && <button type="button" className={btnGhost} onClick={() => { setValue(''); state.clear(); }}>Bỏ mã</button>}
        </div>
      </form>
      <div role="status" aria-live="polite" className="empty:hidden">
        {state.message && <p className={`mt-2 text-xs ${state.message.kind === 'ok' ? 'text-emerald-800' : 'text-rose-700'}`}>{state.message.text}</p>}
      </div>
    </div>
  );
}
