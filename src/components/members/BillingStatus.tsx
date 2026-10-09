import { useCallback, useEffect, useState } from 'react';
import {
  alertError, alertInfo, alertOk, btnGhost, btnPrimary, callApi, card, fmtDateTime, fmtUsd, fmtVnd, isRecord, loginUrl, numOr, planName, str, strOrNull,
} from './member-ui';

interface Transfer {
  bank_account: string;
  bank_code: string;
  amount: number;
  transfer_content: string;
  qr_url: string;
}

interface Order {
  code: string;
  plan: string;
  plan_name: string;
  months: number;
  amount_vnd: number;
  status: string;
  expires_at: string;
  paid_at: string | null;
  amount_paid: number | null;
  attention_reason: string | null;
  transfer: Transfer | null;
  /** Referral discount snapshotted on the order, and the total before it (null without a referral). */
  referral_discount_percent: number | null;
  amount_before_referral_vnd: number | null;
}

function parseOrder(v: unknown): Order | null {
  if (!isRecord(v) || !str(v, 'code')) return null;
  const t = isRecord(v.transfer) ? v.transfer : null;
  return {
    code: str(v, 'code'),
    plan: str(v, 'plan'),
    plan_name: str(v, 'plan_name'),
    months: numOr(v, 'months', 1),
    amount_vnd: numOr(v, 'amount_vnd'),
    status: str(v, 'status'),
    expires_at: str(v, 'expires_at'),
    paid_at: strOrNull(v, 'paid_at'),
    amount_paid: typeof v.amount_paid === 'number' ? v.amount_paid : null,
    attention_reason: strOrNull(v, 'attention_reason'),
    referral_discount_percent: typeof v.referral_discount_percent === 'number' ? v.referral_discount_percent : null,
    amount_before_referral_vnd: typeof v.amount_before_referral_vnd === 'number' ? v.amount_before_referral_vnd : null,
    transfer: t && str(t, 'qr_url')
      ? { bank_account: str(t, 'bank_account'), bank_code: str(t, 'bank_code'), amount: numOr(t, 'amount'), transfer_content: str(t, 'transfer_content'), qr_url: str(t, 'qr_url') }
      : null,
  };
}

const ATTENTION_COPY: Record<string, string> = {
  underpaid: 'Số tiền nhận được thấp hơn giá trị đơn hàng.',
  late_payment: 'Chuyển khoản đến sau khi đơn đã hết hạn.',
  duplicate_payment: 'Đơn đã được thanh toán trước đó; khoản chuyển thêm cần được đối soát.',
  additional_payment: 'Có thêm một khoản chuyển cho đơn này.',
};

const POLL_MS = 5000;

function useCountdown(target: string, active: boolean): number {
  const [left, setLeft] = useState(() => Math.max(0, Date.parse(target) - Date.now()));
  useEffect(() => {
    if (!active) return;
    const tick = () => setLeft(Math.max(0, Date.parse(target) - Date.now()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [target, active]);
  return left;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button" className="ml-2 text-xs font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
      onClick={() => { navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false)); }}
      aria-label={`Sao chép ${label}`}
    >
      {copied ? 'Đã chép' : 'Chép'}
    </button>
  );
}

/** Order status page: VietQR while payable, live countdown, and polling until the webhook confirms payment. */
export function BillingStatus({ code }: { code: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await callApi(`/api/v1/billing/orders/${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (res.ok) {
      const parsed = parseOrder(res.data);
      if (parsed) { setOrder(parsed); setError(null); } else setError('Phản hồi không hợp lệ từ máy chủ.');
      return parsed;
    }
    if (res.status === 401) { window.location.assign(loginUrl(`/billing/${code}`)); return null; }
    setError(res.status === 404 ? 'Không tìm thấy đơn hàng này trong tài khoản của bạn.' : res.message);
    return null;
  }, [code]);

  useEffect(() => { void load(); }, [load]);

  const pending = order?.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [pending, load]);

  const left = useCountdown(order?.expires_at ?? new Date(0).toISOString(), pending);
  const expiredLocally = pending && left <= 0;
  useEffect(() => { if (expiredLocally) void load(); }, [expiredLocally, load]);

  if (!order) {
    return (
      <section className={card} aria-labelledby="order-title">
        <h1 id="order-title" className="text-2xl font-bold font-serif">Đơn hàng {code}</h1>
        <div className="mt-4" role="status" aria-live="polite">
          {error ? <p className={alertError}>{error}</p> : <p className="text-sm text-stone-600">Đang tải đơn hàng…</p>}
        </div>
        {error && <p className="mt-4 flex flex-wrap gap-2"><a className={btnGhost} href="/account#billing">Về tài khoản</a><a className={btnGhost} href="/pricing">Xem các gói</a></p>}
      </section>
    );
  }

  const mm = String(Math.floor(left / 60000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');

  return (
    <section className={card} aria-labelledby="order-title">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Đơn hàng <span className="font-mono">{order.code}</span></p>
      <h1 id="order-title" className="mt-1 text-2xl sm:text-3xl font-bold font-serif">{order.plan_name} · {order.months} tháng</h1>
      <p className="mt-1 text-sm text-stone-700 tabular-nums">Tổng: <strong>{fmtVnd(order.amount_vnd)}</strong></p>
      {order.referral_discount_percent !== null && order.referral_discount_percent > 0 && order.amount_before_referral_vnd !== null && (
        <p className="mt-0.5 text-xs text-stone-600 tabular-nums">
          Giá trước ưu đãi <span className="line-through">{fmtVnd(order.amount_before_referral_vnd)}</span> ·{' '}
          <span className="font-semibold text-emerald-800">Giảm giới thiệu −{order.referral_discount_percent}% (−{fmtVnd(order.amount_before_referral_vnd - order.amount_vnd)})</span>
        </p>
      )}

      <div className="mt-5 grid gap-4" role="status" aria-live="polite" aria-atomic="true">
        {order.status === 'paid' && (
          <div className="grid gap-3">
            <p className={alertOk}>Đã nhận thanh toán lúc {fmtDateTime(order.paid_at)}. Gói {order.plan_name} đã được kích hoạt — cảm ơn bạn! Biên nhận đã gửi qua email.</p>
            <p className="flex flex-wrap gap-2"><a className={btnPrimary} href="/account#billing">Xem gói của tôi</a><a className={btnGhost} href="/">Về trang chủ</a></p>
          </div>
        )}
        {order.status === 'expired' && (
          <div className="grid gap-3">
            <p className={alertInfo}>Đơn đã hết hạn thanh toán. Nếu bạn đã chuyển khoản sau thời hạn, giao dịch vẫn được ghi nhận để đối soát thủ công; vui lòng email hi@zuey.me kèm mã {order.code}.</p>
            <p><a className={btnPrimary} href={`/pricing?plan=${order.plan}&months=${order.months}`}>Tạo đơn mới</a></p>
          </div>
        )}
        {order.status === 'needs_attention' && (
          <p className={alertInfo}>
            Đơn cần kiểm tra thủ công: {ATTENTION_COPY[order.attention_reason ?? ''] ?? 'giao dịch cần đối soát.'}
            {order.amount_paid !== null && <> Đã nhận {fmtVnd(order.amount_paid)}.</>} Zuey sẽ liên hệ với bạn qua email; bạn cũng có thể email hi@zuey.me kèm mã {order.code}.
          </p>
        )}
      </div>

      {pending && (
        <div className="mt-2 grid gap-4">
          <p className={`text-center text-3xl font-bold tabular-nums ${left <= 0 ? 'text-rose-700' : ''}`} role="timer" aria-live="off" aria-label={`Thời gian còn lại ${mm} phút ${ss} giây`}>
            {mm}:{ss}
          </p>
          {order.transfer ? (
            <div className="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)] items-start">
              <img
                src={order.transfer.qr_url} alt={`Mã VietQR chuyển khoản ${fmtVnd(order.transfer.amount)} tới ${order.transfer.bank_code}`}
                width={200} height={200} className="w-48 h-48 mx-auto rounded-xl bg-white p-2 border border-stone-300"
              />
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
          <p className="text-xs text-stone-600">
            Quét mã bằng ứng dụng ngân hàng và giữ nguyên nội dung chuyển khoản. Trang này tự cập nhật khi hệ thống nhận được tiền (thường trong vòng 1 phút). Đơn hết hạn lúc {fmtDateTime(order.expires_at)}.
          </p>
          <p><button type="button" className={btnGhost} onClick={() => { void load(); }}>Kiểm tra lại ngay</button></p>
        </div>
      )}
      {error && <p className={`mt-4 ${alertError}`}>{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Card subscription (Dodo): the page members land on after the hosted checkout
// ---------------------------------------------------------------------------

interface CardSub {
  id: string;
  plan: string | null;
  plan_name: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  amount_cents: number | null;
  attention_reason: string | null;
  /** Referral discount on the first monthly charge only (null without a referral). */
  referral_discount_percent: number | null;
}

function parseCard(v: unknown): CardSub | null {
  if (!isRecord(v) || !str(v, 'id')) return null;
  const plan = strOrNull(v, 'plan');
  return {
    id: str(v, 'id'),
    plan,
    plan_name: strOrNull(v, 'plan_name') ?? (plan ? planName(plan) : 'Gói thành viên'),
    status: str(v, 'status'),
    current_period_end: strOrNull(v, 'current_period_end'),
    cancel_at_period_end: v.cancel_at_period_end === true,
    amount_cents: typeof v.amount_cents === 'number' ? v.amount_cents : null,
    attention_reason: strOrNull(v, 'attention_reason'),
    referral_discount_percent: typeof v.referral_discount_percent === 'number' ? v.referral_discount_percent : null,
  };
}

const CARD_ATTENTION_COPY: Record<string, string> = {
  amount_mismatch: 'Số tiền hoặc loại tiền thanh toán không khớp với giá gói.',
  product_mismatch: 'Sản phẩm thanh toán không khớp với gói đã chọn.',
  metadata_missing: 'Thanh toán thiếu thông tin liên kết tài khoản.',
  metadata_mismatch: 'Thông tin tài khoản trong thanh toán không khớp.',
};

/** Stop automatic polling after this long and say plainly that confirmation has not arrived yet. */
const CARD_WAIT_MS = 10 * 60 * 1000;

/**
 * Card checkout result. Returning from Dodo proves nothing, so the page polls the server until a
 * verified webhook moves the subscription out of `pending`, and only then reports the plan as active.
 */
export function CardBillingStatus({ id }: { id: string }) {
  const [sub, setSub] = useState<CardSub | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState(() => Date.now());
  const [gaveUp, setGaveUp] = useState(false);

  const load = useCallback(async () => {
    const res = await callApi(`/api/v1/billing/card/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.ok) {
      const parsed = parseCard(res.data);
      if (parsed) { setSub(parsed); setError(null); } else setError('Phản hồi không hợp lệ từ máy chủ.');
      return;
    }
    if (res.status === 401) { window.location.assign(loginUrl(`/billing/card/${id}`)); return; }
    setError(res.status === 404 ? 'Không tìm thấy giao dịch thẻ này trong tài khoản của bạn.' : res.message);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const pending = sub?.status === 'pending';
  useEffect(() => {
    if (!pending || gaveUp) return;
    const timer = window.setInterval(() => {
      if (Date.now() - since > CARD_WAIT_MS) { setGaveUp(true); return; }
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, gaveUp, load, since]);

  const retry = () => { setGaveUp(false); setSince(Date.now()); void load(); };
  const renewCopy = sub?.current_period_end
    ? (sub.cancel_at_period_end ? `, hiệu lực đến ${fmtDateTime(sub.current_period_end)} (đã huỷ gia hạn).` : `, tự gia hạn vào ${fmtDateTime(sub.current_period_end)}.`)
    : '.';

  return (
    <section className={card} aria-labelledby="card-title">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Thẻ quốc tế · Dodo Payments</p>
      <h1 id="card-title" className="mt-1 text-2xl sm:text-3xl font-bold font-serif">{sub ? `${sub.plan_name} · hằng tháng` : 'Thanh toán bằng thẻ'}</h1>
      {sub && sub.amount_cents !== null && <p className="mt-1 text-sm text-stone-700 tabular-nums">{fmtUsd(sub.amount_cents)}/tháng</p>}
      {sub && sub.referral_discount_percent !== null && sub.referral_discount_percent > 0 && (
        <p className="mt-0.5 text-xs font-semibold text-emerald-800">Giảm giới thiệu −{sub.referral_discount_percent}% cho tháng đầu; các tháng sau theo giá gói.</p>
      )}
      <div className="mt-5 grid gap-4" role="status" aria-live="polite" aria-atomic="true">
        {!sub && !error && <p className="text-sm text-stone-600">Đang kiểm tra trạng thái thanh toán…</p>}
        {error && <p className={alertError}>{error}</p>}
        {sub && pending && !gaveUp && (
          <p className={alertInfo}>Đang chờ Dodo Payments xác nhận thanh toán. Trang tự cập nhật; gói chỉ được kích hoạt khi hệ thống nhận được xác nhận từ Dodo, không dựa vào việc bạn được chuyển về trang này.</p>
        )}
        {sub && pending && gaveUp && (
          <p className={alertInfo}>Chưa nhận được xác nhận từ Dodo. Nếu bạn đã thanh toán, xác nhận có thể đến muộn; hãy kiểm tra lại sau hoặc email hi@zuey.me kèm mã {sub.id}. Nếu bạn chưa thanh toán thì không có khoản nào bị trừ.</p>
        )}
        {sub?.status === 'active' && (
          <div className="grid gap-3">
            <p className={alertOk}>Đã xác nhận thanh toán. Gói {sub.plan_name} đang hoạt động{renewCopy}</p>
            <p className="flex flex-wrap gap-2"><a className={btnPrimary} href="/account#billing">Xem gói của tôi</a><a className={btnGhost} href="/">Về trang chủ</a></p>
          </div>
        )}
        {sub && ['failed', 'expired', 'cancelled', 'on_hold', 'paused'].includes(sub.status) && (
          <div className="grid gap-3">
            <p className={alertInfo}>
              {sub.status === 'failed' && 'Thanh toán không thành công; gói chưa được kích hoạt.'}
              {sub.status === 'expired' && 'Phiên thanh toán đã hết hạn mà chưa có khoản thanh toán nào được xác nhận.'}
              {sub.status === 'cancelled' && 'Gói thẻ này đã kết thúc.'}
              {(sub.status === 'on_hold' || sub.status === 'paused') && 'Gia hạn bằng thẻ đang tạm dừng (thường do thẻ bị từ chối). Hãy cập nhật thẻ trong mục Gói của tài khoản.'}
            </p>
            <p className="flex flex-wrap gap-2">
              <a className={btnPrimary} href={sub.plan ? `/pricing?plan=${sub.plan}` : '/pricing'}>Chọn lại gói</a>
              <a className={btnGhost} href="/account#billing">Về tài khoản</a>
            </p>
          </div>
        )}
        {sub?.status === 'needs_attention' && (
          <p className={alertInfo}>
            Thanh toán cần Zuey kiểm tra thủ công: {CARD_ATTENTION_COPY[sub.attention_reason ?? ''] ?? 'giao dịch cần đối soát.'} Zuey sẽ liên hệ với bạn qua email; bạn cũng có thể email hi@zuey.me kèm mã {sub.id}.
          </p>
        )}
      </div>
      {sub && pending && <p className="mt-4"><button type="button" className={btnGhost} onClick={retry}>Kiểm tra lại ngay</button></p>}
    </section>
  );
}
