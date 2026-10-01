import { useCallback, useEffect, useState } from 'react';
import {
  alertError, alertInfo, alertOk, btnGhost, btnPrimary, callApi, card, fmtDateTime, fmtVnd, isRecord, loginUrl, numOr, str, strOrNull,
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
