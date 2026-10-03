import { useEffect, useId, useState } from 'react';
import type { SubmitLike } from './member-ui';
import { alertError, alertInfo, alertOk, btnGhost, btnPrimary, callApi, card, input, isRecord, jsonBody, str } from './member-ui';

const LOGIN_ERRORS: Record<string, string> = {
  oauth_state: 'Phiên đăng nhập đã hết hạn hoặc không khớp. Vui lòng thử lại.',
  oauth_denied: 'Bạn đã huỷ đăng nhập.',
  oauth_failed: 'Không đăng nhập được với nhà cung cấp. Vui lòng thử lại.',
  oauth_token_failed: 'Không xác thực được với nhà cung cấp. Vui lòng thử lại.',
  oauth_profile_failed: 'Không đọc được hồ sơ từ nhà cung cấp. Vui lòng thử lại.',
  email_unverified: 'Email của tài khoản này chưa được nhà cung cấp xác minh. Hãy dùng liên kết qua email.',
  identity_linked_elsewhere: 'Tài khoản này đã được liên kết với một thành viên khác.',
  google_unconfigured: 'Đăng nhập bằng Google chưa được cấu hình.',
  github_unconfigured: 'Đăng nhập bằng GitHub chưa được cấu hình.',
  database_unavailable: 'Hệ thống tạm thời không khả dụng. Vui lòng thử lại sau.',
};

interface LoginProps {
  next: string;
  error: string | null;
}

/** Magic-link and Google/GitHub sign-in. `next` is already validated server-side. */
export function LoginForm({ next, error }: LoginProps) {
  const emailId = useId();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(error ? (LOGIN_ERRORS[error] ?? 'Đăng nhập không thành công. Vui lòng thử lại.') : null);

  async function submit(e: SubmitLike) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const res = await callApi('/api/members/auth/magic-link', { method: 'POST', body: jsonBody({ email, next }) });
    setBusy(false);
    if (res.ok) setSentTo(email.trim());
    else setMessage(res.message);
  }

  const oauthHref = (provider: 'google' | 'github') => `/api/members/auth/${provider}?next=${encodeURIComponent(next)}`;

  return (
    <section className={`${card} max-w-[460px]`} aria-labelledby="login-title">
      <h1 id="login-title" className="text-2xl sm:text-3xl font-bold font-serif">Đăng nhập Zuey</h1>
      <p className="mt-2 text-sm text-stone-600">Không cần mật khẩu. Tài khoản mới được tạo tự động ở lần đăng nhập đầu tiên.</p>

      <div aria-live="polite" role="status" className="mt-4 empty:hidden">
        {message && <p className={alertError}>{message}</p>}
      </div>

      {sentTo ? (
        <div className="mt-5 grid gap-3">
          <p className={alertOk}>
            Đã gửi liên kết đăng nhập tới <strong className="break-all">{sentTo}</strong>. Liên kết có hiệu lực trong 15 phút và chỉ dùng được một lần.
          </p>
          <p className="text-xs text-stone-600">Không thấy email? Kiểm tra mục Spam/Quảng cáo, hoặc gửi lại sau ít phút.</p>
          <button type="button" className={btnGhost} onClick={() => setSentTo(null)}>Dùng email khác</button>
        </div>
      ) : (
        <form className="mt-5 grid gap-3" onSubmit={submit}>
          <label htmlFor={emailId} className="text-sm font-medium">Email</label>
          <input
            id={emailId} className={input} type="email" required maxLength={254} autoComplete="email" inputMode="email"
            value={email} onChange={e => setEmail(e.target.value)} placeholder="ban@example.com"
          />
          <button type="submit" className={btnPrimary} disabled={busy || email.trim().length === 0}>
            {busy ? 'Đang gửi…' : 'Gửi liên kết đăng nhập'}
          </button>
        </form>
      )}

      <div className="mt-6 flex items-center gap-3 text-xs text-stone-500" aria-hidden="true">
        <span className="h-px flex-1 bg-stone-300" />hoặc<span className="h-px flex-1 bg-stone-300" />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <a className={btnGhost} href={oauthHref('google')}>Tiếp tục với Google</a>
        <a className={btnGhost} href={oauthHref('github')}>Tiếp tục với GitHub</a>
      </div>
      <p className="mt-5 text-xs text-stone-500">
        Khi đăng nhập, bạn đồng ý để Zuey lưu email và lịch sử đăng nhập nhằm bảo vệ tài khoản. Bạn có thể xuất hoặc xoá dữ liệu bất kỳ lúc nào trong trang Tài khoản.
      </p>
    </section>
  );
}

interface TokenConfirmProps {
  mode: 'magic_link' | 'email_change';
}

/**
 * Consumes an emailed token only after an explicit click, so link scanners that open the URL
 * cannot burn the single-use token. The token is read from the query string client-side.
 */
export function TokenConfirm({ mode }: TokenConfirmProps) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token');
    setToken(t && t.length <= 200 ? t : '');
    // Drop the token from the address bar and history once read.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const isLogin = mode === 'magic_link';

  async function confirm() {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    const res = await callApi(isLogin ? '/api/members/auth/magic-link/verify' : '/api/v1/me/email/confirm', { method: 'POST', body: jsonBody({ token }) });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const data = isRecord(res.data) ? res.data : {};
    if (isLogin) {
      const next = str(data, 'next');
      window.location.assign(next.startsWith('/') && !next.startsWith('//') ? next : '/account');
      return;
    }
    setDone(str(data, 'email'));
  }

  return (
    <section className={`${card} max-w-[460px]`} aria-labelledby="confirm-title">
      <h1 id="confirm-title" className="text-2xl sm:text-3xl font-bold font-serif">{isLogin ? 'Xác nhận đăng nhập' : 'Xác nhận email mới'}</h1>
      <div aria-live="polite" role="status" className="mt-4 grid gap-3">
        {token === null && <p className="text-sm text-stone-600">Đang đọc liên kết…</p>}
        {token === '' && <p className={alertError}>Liên kết thiếu mã xác nhận. Vui lòng mở lại liên kết trong email.</p>}
        {error && <p className={alertError}>{error}</p>}
        {done && <p className={alertOk}>Email tài khoản đã đổi thành <strong className="break-all">{done}</strong>. Email cũ đã nhận được thông báo.</p>}
      </div>
      {token && !done && (
        <div className="mt-5 grid gap-3">
          <p className="text-sm text-stone-700">
            {isLogin ? 'Bấm nút bên dưới để hoàn tất đăng nhập trên thiết bị này.' : 'Bấm nút bên dưới để xác nhận bạn sở hữu địa chỉ email mới.'}
          </p>
          <button type="button" className={btnPrimary} onClick={confirm} disabled={busy}>
            {busy ? 'Đang xác nhận…' : isLogin ? 'Đăng nhập' : 'Xác nhận email'}
          </button>
        </div>
      )}
      {(error || token === '') && (
        <p className="mt-4 text-sm"><a className="underline" href={isLogin ? '/login' : '/account'}>{isLogin ? 'Yêu cầu liên kết mới' : 'Về trang tài khoản'}</a></p>
      )}
      {done && <p className="mt-4"><a className={btnGhost} href="/account">Về trang tài khoản</a></p>}
      {isLogin && !error && <p className={`mt-5 text-xs ${alertInfo}`}>Nếu bạn không yêu cầu đăng nhập, hãy đóng trang này — không có gì thay đổi.</p>}
    </section>
  );
}
