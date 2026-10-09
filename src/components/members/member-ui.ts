// Shared styles and a validated JSON client for the member pages (login, account, pricing, billing).

export const card = 'w-full max-w-[720px] mx-auto bg-[#F5EFEB] rounded-[28px] border border-stone-200/90 shadow-floating-card px-4 py-6 sm:p-8 text-stone-900 min-w-0';
export const btnPrimary = 'inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full bg-stone-900 text-amber-50 font-semibold text-sm hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2';
export const btnGhost = 'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-stone-300 bg-white/80 text-stone-800 text-sm font-medium hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500';
export const btnDanger = 'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-rose-300 bg-rose-50 text-rose-800 text-sm font-semibold hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400';
export const input = 'w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-sm text-stone-900 placeholder-stone-400 focus:outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200';
export const alertError = 'rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm p-3';
export const alertOk = 'rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm p-3';
export const alertInfo = 'rounded-xl bg-amber-50 border border-amber-200 text-stone-900 text-sm p-3';

export type ApiResult = { ok: true; status: number; data: unknown } | { ok: false; status: number; code: string; message: string };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  return typeof v === 'string' ? v : '';
}

export function strOrNull(r: Record<string, unknown>, k: string): string | null {
  const v = r[k];
  return typeof v === 'string' ? v : null;
}

export function numOr(r: Record<string, unknown>, k: string, fallback = 0): number {
  const v = r[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function strList(r: Record<string, unknown>, k: string): string[] {
  const v = r[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/** Vietnamese copy for error codes the member APIs return; falls back to the server message. */
const ERROR_COPY: Record<string, string> = {
  network_error: 'Không kết nối được máy chủ. Kiểm tra mạng và thử lại.',
  rate_limited: 'Bạn đã yêu cầu quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.',
  email_unconfigured: 'Dịch vụ gửi email chưa được cấu hình. Vui lòng thử đăng nhập bằng Google hoặc GitHub.',
  email_failed: 'Không gửi được email lúc này. Vui lòng thử lại sau ít phút.',
  invalid_token: 'Liên kết không hợp lệ, đã được dùng hoặc đã hết hạn. Vui lòng yêu cầu liên kết mới.',
  billing_unconfigured: 'Thanh toán đang tạm đóng do chưa cấu hình xong. Vui lòng quay lại sau hoặc email hi@zuey.me.',
  payment_unconfigured: 'Cổng thanh toán này chưa được cấu hình. Vui lòng chọn cách khác hoặc email hi@zuey.me.',
  payment_provider_error: 'Không kết nối được cổng thanh toán. Vui lòng thử lại sau ít phút.',
  already_subscribed: 'Bạn đã có gói này trả bằng thẻ. Quản lý hoặc huỷ trong mục Gói của tài khoản.',
  session_required: 'Thao tác này cần đăng nhập trên trình duyệt tại /account.',
  too_many_pending_orders: 'Bạn đang có quá nhiều đơn chờ thanh toán. Hãy hoàn tất hoặc đợi đơn cũ hết hạn (60 phút).',
  email_taken: 'Email này đã được dùng cho một tài khoản khác.',
  key_limit_reached: 'Bạn đã đạt số lượng khoá API tối đa. Hãy thu hồi bớt khoá cũ.',
  csrf_rejected: 'Yêu cầu bị chặn vì không xuất phát từ zuey.me. Vui lòng tải lại trang.',
  confirmation_required: 'Email xác nhận không khớp với email tài khoản.',
  database_unavailable: 'Hệ thống tạm thời không khả dụng. Vui lòng thử lại sau.',
  referral_code_invalid: 'Mã giới thiệu không áp dụng được cho đơn này (mã không hoạt động, là mã của bạn, hoặc tài khoản đã từng thanh toán). Bỏ mã để thanh toán giá thường.',
  discount_code_invalid: 'Không tìm thấy mã ưu đãi hoặc mã giới thiệu này. Kiểm tra lại mã hoặc bỏ mã để thanh toán giá thường.',
  promo_code_not_found: 'Không tìm thấy mã ưu đãi này.',
  invoice_requires_sepay: 'Hoá đơn công ty chỉ xuất cho thanh toán chuyển khoản (VietQR).',
};

/** Why a promo code was refused (`promo_code_invalid`, reason in the server message). */
const PROMO_REASON_COPY: Record<string, string> = {
  disabled: 'Mã ưu đãi này đã ngừng áp dụng.',
  not_started: 'Mã ưu đãi này chưa đến thời gian áp dụng.',
  expired: 'Mã ưu đãi này đã hết hạn.',
  exhausted: 'Mã ưu đãi này đã hết lượt sử dụng.',
  already_used: 'Bạn đã dùng mã ưu đãi này rồi (mỗi khách một lần).',
  product_not_eligible: 'Mã ưu đãi này không áp dụng cho sản phẩm này.',
  plan_not_eligible: 'Mã ưu đãi này không áp dụng cho gói này.',
  course_not_eligible: 'Mã ưu đãi này không áp dụng cho khoá học này.',
  term_too_short: 'Mã ưu đãi này chỉ áp dụng khi trả trước dài hơn.',
};

export function errorText(code: string, message: string): string {
  if (code === 'promo_code_invalid') {
    const reason = /\(([a-z_]+)\)/.exec(message)?.[1] ?? '';
    return PROMO_REASON_COPY[reason] ?? 'Mã ưu đãi này không áp dụng được cho đơn hàng.';
  }
  return ERROR_COPY[code] ?? message;
}

/** fetch + JSON envelope parsing. Never throws; data is `unknown` and must be validated by the caller. */
export async function callApi(url: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { credentials: 'same-origin', ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    const body: unknown = await res.json().catch(() => null);
    if (isRecord(body) && body.success === true) return { ok: true, status: res.status, data: body.data };
    const err = isRecord(body) && isRecord(body.error) ? body.error : {};
    const code = typeof err.code === 'string' ? err.code : `http_${res.status}`;
    const message = typeof err.message === 'string' ? err.message : 'Đã có lỗi xảy ra. Vui lòng thử lại.';
    return { ok: false, status: res.status, code, message: errorText(code, message) };
  } catch {
    return { ok: false, status: 0, code: 'network_error', message: errorText('network_error', '') };
  }
}

export function jsonBody(value: unknown): RequestInit['body'] {
  return JSON.stringify(value);
}

const SAIGON = 'Asia/Ho_Chi_Minh';

export function fmtDateTime(isoValue: string | null): string {
  if (!isoValue) return '—';
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('vi-VN', { timeZone: SAIGON, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function fmtDate(isoValue: string | null): string {
  if (!isoValue) return '—';
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('vi-VN', { timeZone: SAIGON, dateStyle: 'medium' }).format(d);
}

export function fmtVnd(amount: number): string {
  return `${amount.toLocaleString('vi-VN')} ₫`;
}

export function fmtUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
}

export const PLAN_NAMES: Record<string, string> = {
  knowledges: 'Knowledges',
  ai: 'Zuey AI',
  combo: 'Kết hợp',
  community: 'Cộng đồng',
};

export function planName(id: string): string {
  return PLAN_NAMES[id] ?? id;
}

export function loginUrl(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

export function currentPath(): string {
  return typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`;
}

/** Minimal form-submit event shape (avoids React 19's deprecated FormEvent alias). */
export interface SubmitLike {
  preventDefault(): void;
}
