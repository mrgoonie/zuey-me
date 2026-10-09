import { useEffect, useId, useState } from 'react';
import type { SubmitLike } from '../members/member-ui';
import { alertError, btnPrimary, input, isRecord, jsonBody, loginUrl, str } from '../members/member-ui';
import { courseApi, focusRing } from './course-ui';

type Provider = 'sepay' | 'dodo';

interface Props {
  courseSlug: string;
  signedIn: boolean;
  /** SePay bank transfer is configured on this deployment. */
  sepayAvailable: boolean;
  /** Dodo one-time card checkout for courses is configured on this deployment. */
  cardAvailable: boolean;
}

const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Buy box: payment method, mandatory consent to the Terms and the no-refund policy, optional referral
 * code (prefilled from ?ref=). SePay continues on the order status page; Dodo opens the hosted checkout.
 */
export function CourseCheckout({ courseSlug, signedIn, sepayAvailable, cardAvailable }: Props) {
  const [provider, setProvider] = useState<Provider>(sepayAvailable || !cardAvailable ? 'sepay' : 'dodo');
  const [accepted, setAccepted] = useState(false);
  const [referral, setReferral] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const termsId = useId();
  const refId = useId();
  const errId = useId();
  const coursePath = `/courses/${courseSlug}`;

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref && REF_RE.test(ref)) setReferral(ref);
  }, []);

  if (!signedIn) {
    const next = referral ? `${coursePath}?ref=${encodeURIComponent(referral)}` : coursePath;
    return (
      <div className="grid gap-2">
        <a className={`${btnPrimary} min-h-[44px] w-full`} href={loginUrl(next)}>Đăng nhập để mua khoá học</a>
        <p className="text-xs text-stone-600">Bạn cần một tài khoản zuey.me để sở hữu và theo dõi tiến độ học.</p>
      </div>
    );
  }

  if (!sepayAvailable && !cardAvailable) {
    return <p className="rounded-xl bg-amber-50 border border-amber-200 text-sm p-3">Thanh toán đang tạm đóng trong lúc cấu hình. Vui lòng quay lại sau hoặc email hi@zuey.me.</p>;
  }

  async function submit(e: SubmitLike) {
    e.preventDefault();
    if (busy) return;
    if (!accepted) { setError('Bạn cần đồng ý Điều khoản sử dụng và Chính sách (không hoàn tiền) để tiếp tục.'); return; }
    const code = referral.trim();
    if (code && !REF_RE.test(code)) { setError('Mã giới thiệu chỉ gồm chữ, số, dấu gạch ngang hoặc gạch dưới.'); return; }
    setBusy(true);
    setError(null);
    const res = await courseApi(`/api/v1/courses/${encodeURIComponent(courseSlug)}/checkout`, {
      method: 'POST',
      body: jsonBody({ provider, accept_terms: true, ...(code ? { referral_code: code } : {}) }),
    });
    if (res.ok && isRecord(res.data)) {
      const checkoutUrl = str(res.data, 'checkout_url');
      const orderCode = str(res.data, 'code');
      if (provider === 'dodo' && checkoutUrl) { window.location.assign(checkoutUrl); return; }
      if (orderCode) { window.location.assign(`/courses/orders/${encodeURIComponent(orderCode)}`); return; }
    }
    setBusy(false);
    if (!res.ok && res.status === 401) { window.location.assign(loginUrl(coursePath)); return; }
    if (!res.ok && res.code === 'already_owned') { window.location.reload(); return; }
    setError(res.ok ? 'Không tạo được đơn hàng. Vui lòng thử lại.' : res.message);
  }

  const options: Array<{ id: Provider; label: string; hint: string; available: boolean }> = [
    { id: 'sepay', label: 'Chuyển khoản VietQR (VND)', hint: 'Quét mã bằng app ngân hàng, kích hoạt trong khoảng 1 phút.', available: sepayAvailable },
    { id: 'dodo', label: 'Thẻ quốc tế (USD)', hint: 'Thanh toán một lần qua Dodo Payments.', available: cardAvailable },
  ];

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate aria-describedby={error ? errId : undefined}>
      <fieldset className="grid gap-2 min-w-0">
        <legend className="text-sm font-semibold mb-1">Phương thức thanh toán</legend>
        {options.filter(o => o.available).map(o => (
          <label key={o.id} className={`flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 focus-within:ring-2 focus-within:ring-amber-500 ${provider === o.id ? 'border-stone-900 bg-white' : 'border-stone-300 bg-white/60'}`}>
            <input type="radio" name="provider" value={o.id} checked={provider === o.id} onChange={() => setProvider(o.id)} className="mt-1 h-4 w-4 accent-stone-900" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{o.label}</span>
              <span className="block text-xs text-stone-600">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="grid gap-1.5">
        <label htmlFor={refId} className="text-sm font-medium">Mã giới thiệu <span className="font-normal text-stone-500">(không bắt buộc)</span></label>
        <input id={refId} className={input} value={referral} onChange={e => setReferral(e.target.value)} maxLength={64} autoComplete="off" spellCheck={false} />
        <p className="text-xs text-stone-600">Giảm giá thành viên và giảm giá giới thiệu không cộng dồn: hệ thống áp dụng mức cao hơn.</p>
      </div>

      <label htmlFor={termsId} className="flex min-h-[44px] cursor-pointer items-start gap-3 text-sm">
        <input id={termsId} type="checkbox" required checked={accepted} onChange={e => { setAccepted(e.target.checked); if (e.target.checked) setError(null); }} className={`mt-0.5 h-5 w-5 shrink-0 accent-stone-900 ${focusRing}`} />
        <span>
          Tôi đồng ý <a href="/terms" target="_blank" rel="noopener" className="font-semibold underline">Điều khoản sử dụng</a> và{' '}
          <a href="/policy" target="_blank" rel="noopener" className="font-semibold underline">Chính sách</a> (không hoàn tiền).
        </span>
      </label>

      <div role="status" aria-live="polite" className="empty:hidden">{error && <p id={errId} className={alertError}>{error}</p>}</div>

      <button type="submit" className={`${btnPrimary} min-h-[44px] w-full`} disabled={busy}>
        {busy ? (provider === 'dodo' ? 'Đang mở trang thanh toán…' : 'Đang tạo đơn…') : 'Mua khoá học'}
      </button>
    </form>
  );
}
