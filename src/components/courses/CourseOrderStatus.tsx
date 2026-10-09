import { useCallback, useEffect, useState } from 'react';
import { alertError, alertInfo, alertOk, btnGhost, btnPrimary, card, fmtDateTime, fmtUsd, fmtVnd, isRecord, loginUrl, numOr, str, strOrNull } from '../members/member-ui';
import { CopyButton } from './CopyButton';
import { courseApi } from './course-ui';

interface Transfer { bank_account: string; bank_code: string; amount: number; transfer_content: string; qr_url: string }
interface Order {
  code: string; provider: string; status: string; courseSlug: string | null; courseTitle: string;
  amount_usd_cents: number; list_usd_cents: number; applied_pct: number; amount_vnd: number | null;
  amount_paid: number | null; currency_paid: string | null; attention_reason: string | null;
  expires_at: string; paid_at: string | null; transfer: Transfer | null;
}

function parseOrder(v: unknown): Order | null {
  if (!isRecord(v) || !str(v, 'code')) return null;
  const course = isRecord(v.course) ? v.course : null;
  const t = isRecord(v.transfer) ? v.transfer : null;
  return {
    code: str(v, 'code'), provider: str(v, 'provider'), status: str(v, 'status'),
    courseSlug: course ? strOrNull(course, 'slug') : null, courseTitle: course ? str(course, 'title') : 'Khoá học',
    amount_usd_cents: numOr(v, 'amount_usd_cents'), list_usd_cents: numOr(v, 'list_usd_cents'), applied_pct: numOr(v, 'applied_pct'),
    amount_vnd: typeof v.amount_vnd === 'number' ? v.amount_vnd : null,
    amount_paid: typeof v.amount_paid === 'number' ? v.amount_paid : null, currency_paid: strOrNull(v, 'currency_paid'),
    attention_reason: strOrNull(v, 'attention_reason'), expires_at: str(v, 'expires_at'), paid_at: strOrNull(v, 'paid_at'),
    transfer: t && str(t, 'qr_url')
      ? { bank_account: str(t, 'bank_account'), bank_code: str(t, 'bank_code'), amount: numOr(t, 'amount'), transfer_content: str(t, 'transfer_content'), qr_url: str(t, 'qr_url') }
      : null,
  };
}

const ATTENTION_COPY: Record<string, string> = {
  underpaid: 'Số tiền nhận được thấp hơn giá trị đơn hàng.',
  late_payment: 'Thanh toán đến sau khi đơn đã hết hạn.',
  duplicate_payment: 'Đơn đã được thanh toán trước đó; khoản thanh toán thêm cần được đối soát.',
  additional_payment: 'Có thêm một khoản thanh toán cho đơn này.',
  provider_mismatch: 'Cổng thanh toán không khớp với đơn hàng.',
};

const POLL_MS = 5000;
/** Card confirmations come from a webhook; stop polling automatically after this long. */
const MAX_WAIT_MS = 15 * 60 * 1000;

/** Course order status: VietQR while payable, polling until the payment webhook confirms, then a link into the course. */
export function CourseOrderStatus({ code }: { code: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const res = await courseApi(`/api/v1/courses/orders/${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (res.ok) {
      const parsed = parseOrder(res.data);
      if (parsed) { setOrder(parsed); setError(null); } else setError('Phản hồi không hợp lệ từ máy chủ.');
      return;
    }
    if (res.status === 401) { window.location.assign(loginUrl(`/courses/orders/${code}`)); return; }
    setError(res.status === 404 ? 'Không tìm thấy đơn hàng này trong tài khoản của bạn.' : res.message);
  }, [code]);

  useEffect(() => { void load(); }, [load]);

  const pending = order?.status === 'pending';
  const gaveUp = pending && now - since > MAX_WAIT_MS && order?.provider === 'dodo';
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === 'visible' && !gaveUp) void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [pending, gaveUp, load]);

  const left = order ? Math.max(0, Date.parse(order.expires_at) - now) : 0;
  const mm = String(Math.floor(left / 60000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  const courseHref = order?.courseSlug ? `/courses/${order.courseSlug}` : '/courses';

  return (
    <section className={card} aria-labelledby="order-title">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Đơn khoá học <span className="font-mono">{code}</span></p>
      <h1 id="order-title" className="mt-1 text-2xl sm:text-3xl font-bold font-serif break-words">{order?.courseTitle ?? 'Đơn hàng'}</h1>
      {order && (
        <p className="mt-1 text-sm text-stone-700 tabular-nums">
          Tổng: <strong>{order.provider === 'sepay' && order.amount_vnd !== null ? fmtVnd(order.amount_vnd) : fmtUsd(order.amount_usd_cents)}</strong>
          {order.applied_pct > 0 && <> · giảm {order.applied_pct}% từ {fmtUsd(order.list_usd_cents)}</>}
          {' · '}{order.provider === 'dodo' ? 'Thẻ quốc tế (Dodo)' : 'Chuyển khoản VietQR'}
        </p>
      )}

      <div className="mt-5 grid gap-4" role="status" aria-live="polite" aria-atomic="true">
        {!order && !error && <p className="text-sm text-stone-600">Đang tải đơn hàng…</p>}
        {error && <p className={alertError}>{error}</p>}
        {order?.status === 'paid' && (
          <div className="grid gap-3">
            <p className={alertOk}>Đã nhận thanh toán lúc {fmtDateTime(order.paid_at)}. Khoá học đã thuộc về bạn — chúc bạn học vui! Biên nhận đã gửi qua email.</p>
            <p className="flex flex-wrap gap-2"><a className={`${btnPrimary} min-h-[44px]`} href={courseHref}>Vào học ngay</a><a className={`${btnGhost} min-h-[44px]`} href="/account#learning">Khoá học của tôi</a></p>
          </div>
        )}
        {order && pending && order.provider === 'dodo' && (
          <p className={alertInfo}>
            {gaveUp
              ? `Chưa nhận được xác nhận từ Dodo. Nếu bạn đã thanh toán, xác nhận có thể đến muộn; tải lại trang sau hoặc email hi@zuey.me kèm mã ${order.code}.`
              : 'Đang chờ Dodo Payments xác nhận thanh toán. Trang tự cập nhật; khoá học chỉ được mở khi hệ thống nhận được xác nhận.'}
          </p>
        )}
        {(order?.status === 'expired' || order?.status === 'cancelled') && (
          <div className="grid gap-3">
            <p className={alertInfo}>Đơn đã {order.status === 'expired' ? 'hết hạn' : 'bị huỷ'} mà chưa ghi nhận thanh toán. Nếu bạn đã chuyển khoản, email hi@zuey.me kèm mã {order.code} để được đối soát.</p>
            <p><a className={`${btnPrimary} min-h-[44px]`} href={courseHref}>Tạo đơn mới</a></p>
          </div>
        )}
        {order?.status === 'needs_attention' && (
          <p className={alertInfo}>
            Đơn cần kiểm tra thủ công: {ATTENTION_COPY[order.attention_reason ?? ''] ?? 'giao dịch cần đối soát.'}
            {order.amount_paid !== null && <> Đã nhận {order.currency_paid === 'VND' || order.provider === 'sepay' ? fmtVnd(order.amount_paid) : fmtUsd(order.amount_paid)}.</>} Zuey sẽ liên hệ qua email; bạn cũng có thể email hi@zuey.me kèm mã {order.code}.
          </p>
        )}
        {(order?.status === 'refunded' || order?.status === 'charged_back') && (
          <p className={alertInfo}>Thanh toán của đơn này đã bị {order.status === 'refunded' ? 'hoàn lại' : 'khiếu nại (chargeback)'}; quyền truy cập khoá học đã được thu hồi. Liên hệ hi@zuey.me nếu cần hỗ trợ.</p>
        )}
      </div>

      {order && pending && order.provider === 'sepay' && (
        <div className="mt-2 grid gap-4">
          <p className={`text-center text-3xl font-bold tabular-nums ${left <= 0 ? 'text-rose-700' : ''}`} role="timer" aria-live="off" aria-label={`Thời gian còn lại ${mm} phút ${ss} giây`}>{mm}:{ss}</p>
          {order.transfer ? (
            <div className="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)] items-start">
              <img src={order.transfer.qr_url} alt={`Mã VietQR chuyển khoản ${fmtVnd(order.transfer.amount)} tới ${order.transfer.bank_code}`} width={200} height={200} className="w-48 h-48 mx-auto rounded-xl bg-white p-2 border border-stone-300" />
              <dl className="text-sm grid gap-1.5 min-w-0 break-words">
                <div><dt className="inline font-semibold">Ngân hàng: </dt><dd className="inline">{order.transfer.bank_code}</dd></div>
                <div><dt className="inline font-semibold">Số tài khoản: </dt><dd className="inline font-mono">{order.transfer.bank_account}</dd><CopyButton value={order.transfer.bank_account} label="số tài khoản" /></div>
                <div><dt className="inline font-semibold">Số tiền: </dt><dd className="inline tabular-nums">{fmtVnd(order.transfer.amount)}</dd><CopyButton value={String(order.transfer.amount)} label="số tiền" /></div>
                <div><dt className="inline font-semibold">Nội dung: </dt><dd className="inline font-mono">{order.transfer.transfer_content}</dd><CopyButton value={order.transfer.transfer_content} label="nội dung chuyển khoản" /></div>
              </dl>
            </div>
          ) : (
            <p className={alertError}>Thông tin chuyển khoản hiện không khả dụng. Vui lòng thử lại sau hoặc email hi@zuey.me.</p>
          )}
          <p className="text-xs text-stone-600">Quét mã bằng ứng dụng ngân hàng và giữ nguyên nội dung chuyển khoản. Trang tự cập nhật khi hệ thống nhận được tiền (thường trong vòng 1 phút). Đơn hết hạn lúc {fmtDateTime(order.expires_at)}.</p>
        </div>
      )}
      {order && pending && <p className="mt-4"><button type="button" className={`${btnGhost} min-h-[44px]`} onClick={() => { setNow(Date.now()); void load(); }}>Kiểm tra lại ngay</button></p>}
    </section>
  );
}
