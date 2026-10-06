import { useCallback, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiKeysPanel } from './ApiKeysPanel';
import { MemberDialog } from './MemberDialog';
import type { SubmitLike } from './member-ui';
import {
  alertError, alertOk, btnDanger, btnGhost, btnPrimary, callApi, card, fmtDate, fmtDateTime, fmtVnd, input, isRecord, jsonBody, loginUrl,
  numOr, planName, records, str, strList, strOrNull,
} from './member-ui';

interface Me {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  locale: string;
  created_at: string;
  is_admin: boolean;
  plans: string[];
  entitlements: string[];
  identities: { provider: string; email: string | null }[];
}

function parseMe(v: unknown): Me | null {
  if (!isRecord(v) || !str(v, 'id')) return null;
  return {
    id: str(v, 'id'),
    email: str(v, 'email'),
    name: strOrNull(v, 'name'),
    avatar_url: strOrNull(v, 'avatar_url'),
    locale: str(v, 'locale') || 'vi',
    created_at: str(v, 'created_at'),
    is_admin: v.is_admin === true,
    plans: strList(v, 'plans'),
    entitlements: strList(v, 'entitlements'),
    identities: records(v.identities).map(i => ({ provider: str(i, 'provider'), email: strOrNull(i, 'email') })),
  };
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className={`${card} scroll-mt-6`} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-xl sm:text-2xl font-bold font-serif mb-4">{title}</h2>
      {children}
    </section>
  );
}

function Notice({ ok, error }: { ok: string | null; error: string | null }) {
  return (
    <div role="status" aria-live="polite" className="empty:hidden">
      {error && <p className={alertError}>{error}</p>}
      {ok && <p className={alertOk}>{ok}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProfileSection({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const [form, setForm] = useState({ name: me.name ?? '', avatar_url: me.avatar_url ?? '', locale: me.locale });
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), avatar: useId(), locale: useId() };

  async function save(e: SubmitLike) {
    e.preventDefault();
    setBusy(true); setOk(null); setError(null);
    const res = await callApi('/api/v1/me', {
      method: 'PATCH',
      body: jsonBody({ name: form.name.trim() || null, avatar_url: form.avatar_url.trim() || null, locale: form.locale }),
    });
    setBusy(false);
    const next = res.ok ? parseMe(res.data) : null;
    if (next) { onSaved(next); setOk('Đã lưu hồ sơ.'); } else setError(res.ok ? 'Phản hồi không hợp lệ.' : res.message);
  }

  return (
    <Section id="profile" title="Hồ sơ">
      <form className="grid gap-3" onSubmit={save}>
        <label htmlFor={ids.name} className="text-sm font-medium">Tên hiển thị</label>
        <input id={ids.name} className={input} maxLength={80} autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <label htmlFor={ids.avatar} className="text-sm font-medium">Ảnh đại diện (URL https)</label>
        <input id={ids.avatar} className={input} type="url" maxLength={500} inputMode="url" placeholder="https://…" value={form.avatar_url} onChange={e => setForm({ ...form, avatar_url: e.target.value })} />
        <label htmlFor={ids.locale} className="text-sm font-medium">Ngôn ngữ email</label>
        <select id={ids.locale} className={input} value={form.locale} onChange={e => setForm({ ...form, locale: e.target.value })}>
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
        <Notice ok={ok} error={error} />
        <p><button type="submit" className={btnPrimary} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu hồ sơ'}</button></p>
      </form>
    </Section>
  );
}

function EmailSection({ me }: { me: Me }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const linked = new Set(me.identities.map(i => i.provider));

  async function submit(e: SubmitLike) {
    e.preventDefault();
    setBusy(true); setOk(null); setError(null);
    const res = await callApi('/api/v1/me/email', { method: 'POST', body: jsonBody({ new_email: email }) });
    setBusy(false);
    if (res.ok) { setOk(`Đã gửi liên kết xác nhận tới ${email.trim()}. Email chỉ đổi sau khi bạn bấm liên kết (hiệu lực 15 phút).`); setEmail(''); }
    else setError(res.message);
  }

  return (
    <Section id="email" title="Email & đăng nhập">
      <p className="text-sm">Email hiện tại: <strong className="break-all">{me.email}</strong></p>
      <form className="mt-4 grid gap-3" onSubmit={submit}>
        <label htmlFor={fieldId} className="text-sm font-medium">Đổi sang email mới</label>
        <input id={fieldId} className={input} type="email" required maxLength={254} autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
        <Notice ok={ok} error={error} />
        <p><button type="submit" className={btnGhost} disabled={busy || email.trim() === ''}>{busy ? 'Đang gửi…' : 'Gửi liên kết xác nhận'}</button></p>
      </form>
      <h3 className="mt-6 text-sm font-semibold">Tài khoản liên kết</h3>
      <ul className="mt-2 grid gap-2 text-sm">
        {(['google', 'github'] as const).map(p => (
          <li key={p} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
            <span className="min-w-0 break-words">
              {p === 'google' ? 'Google' : 'GitHub'}
              {linked.has(p) ? <span className="text-stone-600"> · đã liên kết{me.identities.find(i => i.provider === p)?.email ? ` (${me.identities.find(i => i.provider === p)?.email})` : ''}</span> : null}
            </span>
            {!linked.has(p) && <a className={btnGhost} href={`/api/members/auth/${p}?next=${encodeURIComponent('/account#email')}`}>Liên kết</a>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

interface Subscription { plan: string; status: string; current_period_end: string }
interface OrderRow { code: string; plan: string; months: number; amount_vnd: number; status: string; created_at: string }
interface CardRow {
  id: string;
  plan: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  can_manage: boolean;
  can_cancel: boolean;
}

const ORDER_STATUS: Record<string, string> = { pending: 'Chờ thanh toán', paid: 'Đã thanh toán', expired: 'Hết hạn', needs_attention: 'Cần kiểm tra' };
const CARD_STATUS: Record<string, string> = {
  pending: 'Chờ xác nhận', active: 'Đang hoạt động', on_hold: 'Tạm dừng do thanh toán lỗi', paused: 'Tạm dừng',
  cancelled: 'Đã kết thúc', failed: 'Thanh toán thất bại', expired: 'Hết hạn', needs_attention: 'Cần kiểm tra',
};

function parseCardRow(r: Record<string, unknown>): CardRow {
  return {
    id: str(r, 'id'),
    plan: strOrNull(r, 'plan'),
    status: str(r, 'status'),
    current_period_end: strOrNull(r, 'current_period_end'),
    cancel_at_period_end: r.cancel_at_period_end === true,
    can_manage: r.can_manage === true,
    can_cancel: r.can_cancel === true,
  };
}

/** Card (Dodo) memberships: renewal date, the Dodo customer portal, and scheduled cancellation. */
function CardSubscriptions({ cards, onChanged }: { cards: CardRow[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<CardRow | null>(null);

  async function manage(c: CardRow) {
    setBusy(c.id); setError(null); setOk(null);
    const res = await callApi(`/api/v1/billing/card/${encodeURIComponent(c.id)}/portal`, { method: 'POST' });
    if (res.ok && isRecord(res.data) && str(res.data, 'url')) {
      window.location.assign(str(res.data, 'url'));
      return;
    }
    setBusy(null);
    setError(res.ok ? 'Không mở được trang quản lý thẻ. Vui lòng thử lại.' : res.message);
  }

  async function cancel() {
    if (!cancelling) return;
    setBusy(cancelling.id); setError(null); setOk(null);
    const res = await callApi(`/api/v1/billing/card/${encodeURIComponent(cancelling.id)}/cancel`, { method: 'POST' });
    setBusy(null);
    if (res.ok) {
      const end = isRecord(res.data) ? strOrNull(res.data, 'current_period_end') : null;
      setOk(`Đã huỷ gia hạn. Gói vẫn dùng được${end ? ` đến ${fmtDateTime(end)}` : ' đến hết kỳ đã thanh toán'}.`);
      setCancelling(null);
      onChanged();
    } else {
      setError(res.message);
    }
  }

  return (
    <>
      <h3 className="mt-6 text-sm font-semibold">Thẻ quốc tế (Dodo)</h3>
      <Notice ok={ok} error={cancelling ? null : error} />
      <ul className="mt-2 grid gap-2 text-sm">
        {cards.map(c => (
          <li key={c.id} className="grid gap-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
            <span className="min-w-0 break-words">
              <a className="underline" href={`/billing/card/${encodeURIComponent(c.id)}`}><strong>{c.plan ? planName(c.plan) : 'Gói thành viên'}</strong></a> · {CARD_STATUS[c.status] ?? c.status}
              {c.status === 'active' && c.current_period_end && (
                <> · {c.cancel_at_period_end ? 'đã huỷ, hiệu lực đến' : 'gia hạn ngày'} {fmtDateTime(c.current_period_end)}</>
              )}
            </span>
            {(c.can_manage || c.can_cancel) && (
              <span className="flex flex-wrap gap-2">
                {c.can_manage && <button type="button" className={btnGhost} onClick={() => { void manage(c); }} disabled={busy !== null}>{busy === c.id && !cancelling ? 'Đang mở…' : 'Quản lý thẻ'}</button>}
                {c.can_cancel && <button type="button" className={btnDanger} onClick={() => { setError(null); setCancelling(c); }} disabled={busy !== null}>Huỷ gia hạn</button>}
              </span>
            )}
          </li>
        ))}
      </ul>
      <MemberDialog open={cancelling !== null} title="Huỷ gia hạn gói thẻ" onClose={() => setCancelling(null)} busy={busy !== null}>
        <div className="grid gap-3">
          <p className="text-sm">
            Gói {cancelling?.plan ? planName(cancelling.plan) : ''} sẽ không tự gia hạn nữa. Bạn vẫn dùng được
            {cancelling?.current_period_end ? ` đến ${fmtDateTime(cancelling.current_period_end)}` : ' đến hết kỳ đã thanh toán'}; không hoàn tiền phần còn lại.
          </p>
          <div role="status" aria-live="polite" className="empty:hidden">{error && <p className={alertError}>{error}</p>}</div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setCancelling(null)} disabled={busy !== null}>Giữ gói</button>
            <button type="button" className={btnDanger} onClick={() => { void cancel(); }} disabled={busy !== null}>{busy ? 'Đang huỷ…' : 'Huỷ gia hạn'}</button>
          </div>
        </div>
      </MemberDialog>
    </>
  );
}

function BillingSection() {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadSubscription = useCallback(async () => {
    const s = await callApi('/api/v1/billing/subscription', { cache: 'no-store' });
    if (s.ok && isRecord(s.data)) {
      setSubs(records(s.data.subscriptions).map(r => ({ plan: str(r, 'plan'), status: str(r, 'status'), current_period_end: str(r, 'current_period_end') })));
      setCards(records(s.data.card_subscriptions).map(parseCardRow).filter(c => c.id && c.status !== 'expired'));
    } else if (!s.ok) setError(s.message);
  }, []);

  useEffect(() => {
    void Promise.all([loadSubscription(), callApi('/api/v1/billing/orders', { cache: 'no-store' })]).then(([, o]) => {
      if (o.ok) {
        setOrders(records(o.data).map(r => ({
          code: str(r, 'code'), plan: str(r, 'plan'), months: numOr(r, 'months', 1), amount_vnd: numOr(r, 'amount_vnd'), status: str(r, 'status'), created_at: str(r, 'created_at'),
        })));
      } else setError(o.message);
    });
  }, []);

  const active = (subs ?? []).filter(s => s.status === 'active');
  return (
    <Section id="billing" title="Gói & thanh toán">
      <Notice ok={null} error={error} />
      {subs === null && !error && <p className="text-sm text-stone-600">Đang tải…</p>}
      {subs && (
        active.length === 0
          ? <p className="text-sm">Bạn chưa có gói nào đang hoạt động.</p>
          : (
            <ul className="grid gap-2">
              {active.map(s => (
                <li key={s.plan} className="rounded-xl border border-stone-300 bg-white/70 px-3 py-2 text-sm">
                  <strong>{planName(s.plan)}</strong> · hiệu lực đến {fmtDateTime(s.current_period_end)}
                </li>
              ))}
            </ul>
          )
      )}
      {subs && subs.some(s => s.status !== 'active') && (
        <p className="mt-2 text-xs text-stone-600">Đã hết hạn: {subs.filter(s => s.status !== 'active').map(s => `${planName(s.plan)} (${fmtDate(s.current_period_end)})`).join(', ')}</p>
      )}
      <p className="mt-4"><a className={btnPrimary} href="/pricing">{active.length > 0 ? 'Gia hạn hoặc thêm gói' : 'Xem các gói'}</a></p>
      {cards.length > 0 && <CardSubscriptions cards={cards} onChanged={() => { void loadSubscription(); }} />}
      <h3 className="mt-6 text-sm font-semibold">Đơn hàng chuyển khoản</h3>
      {orders && orders.length === 0 && <p className="mt-2 text-sm text-stone-600">Chưa có đơn hàng.</p>}
      {orders && orders.length > 0 && (
        <ul className="mt-2 grid gap-2 text-sm">
          {orders.map(o => (
            <li key={o.code} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
              <span className="min-w-0 break-words">
                <a className="font-mono underline" href={`/billing/${encodeURIComponent(o.code)}`}>{o.code}</a> · {planName(o.plan)} {o.months} tháng · <span className="tabular-nums">{fmtVnd(o.amount_vnd)}</span>
              </span>
              <span className="text-xs text-stone-600">{ORDER_STATUS[o.status] ?? o.status} · {fmtDate(o.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

interface SessionRow { id: string; created_at: string; last_seen_at: string; user_agent: string | null; current: boolean }

function SessionsSection() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await callApi('/api/v1/me/sessions', { cache: 'no-store' });
    if (res.ok) {
      setSessions(records(res.data).map(r => ({
        id: str(r, 'id'), created_at: str(r, 'created_at'), last_seen_at: str(r, 'last_seen_at'), user_agent: strOrNull(r, 'user_agent'), current: r.current === true,
      })));
    } else setError(res.message);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(url: string, message: string) {
    setBusy(true); setOk(null); setError(null);
    const res = await callApi(url, { method: 'DELETE' });
    setBusy(false);
    if (res.ok) { setOk(message); void load(); } else setError(res.message);
  }

  return (
    <Section id="sessions" title="Thiết bị đang đăng nhập">
      <Notice ok={ok} error={error} />
      {sessions && (
        <ul className="mt-2 grid gap-2 text-sm">
          {sessions.map(s => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
              <span className="min-w-0 break-words">
                <span className="block">{s.user_agent ? s.user_agent.slice(0, 120) : 'Thiết bị không rõ'}{s.current && <strong> · thiết bị này</strong>}</span>
                <span className="block text-xs text-stone-600">Đăng nhập {fmtDateTime(s.created_at)} · hoạt động {fmtDateTime(s.last_seen_at)}</span>
              </span>
              {!s.current && <button type="button" className={btnGhost} disabled={busy} onClick={() => { void revoke(`/api/v1/me/sessions/${encodeURIComponent(s.id)}`, 'Đã đăng xuất thiết bị.'); }}>Đăng xuất</button>}
            </li>
          ))}
        </ul>
      )}
      {sessions && sessions.length > 1 && (
        <p className="mt-4"><button type="button" className={btnDanger} disabled={busy} onClick={() => { void revoke('/api/v1/me/sessions', 'Đã đăng xuất mọi thiết bị khác.'); }}>Đăng xuất mọi thiết bị khác</button></p>
      )}
    </Section>
  );
}

const ACTIVITY_COPY: Record<string, string> = {
  'account.created': 'Tạo tài khoản',
  login: 'Đăng nhập',
  logout: 'Đăng xuất',
  'profile.updated': 'Cập nhật hồ sơ',
  'email_change.requested': 'Yêu cầu đổi email',
  'email_change.confirmed': 'Đổi email',
  'identity.linked': 'Liên kết tài khoản',
  'sessions.revoked_others': 'Đăng xuất thiết bị khác',
  'session.revoked': 'Đăng xuất một thiết bị',
  'api_key.created': 'Tạo khoá API',
  'api_key.rotated': 'Xoay vòng khoá API',
  'api_key.revoked': 'Thu hồi khoá API',
  'billing.order_created': 'Tạo đơn hàng',
  'billing.paid': 'Thanh toán thành công',
  'billing.needs_attention': 'Thanh toán cần kiểm tra',
  'billing.extra_payment': 'Nhận thêm khoản thanh toán',
  'billing.card_checkout': 'Mở thanh toán bằng thẻ',
  'billing.card_active': 'Kích hoạt gói bằng thẻ',
  'billing.card_renewed': 'Gia hạn gói bằng thẻ',
  'billing.card_ended': 'Gói thẻ kết thúc',
  'billing.card_cancel_scheduled': 'Huỷ gia hạn gói thẻ',
  'account.exported': 'Xuất dữ liệu',
};

function ActivitySection() {
  const [items, setItems] = useState<{ id: number; action: string; created_at: string; user_agent: string | null; detail: unknown }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void callApi('/api/v1/me/activity?limit=50', { cache: 'no-store' }).then(res => {
      if (res.ok) setItems(records(res.data).map(r => ({ id: numOr(r, 'id'), action: str(r, 'action'), created_at: str(r, 'created_at'), user_agent: strOrNull(r, 'user_agent'), detail: r.detail })));
      else setError(res.message);
    });
  }, []);
  return (
    <Section id="activity" title="Hoạt động gần đây">
      <Notice ok={null} error={error} />
      {items && items.length === 0 && <p className="text-sm text-stone-600">Chưa có hoạt động.</p>}
      {items && items.length > 0 && (
        <ol className="grid gap-1.5 text-sm">
          {items.map(a => {
            const method = isRecord(a.detail) && typeof a.detail.method === 'string' ? ` (${a.detail.method})` : '';
            return (
              <li key={a.id} className="flex flex-wrap justify-between gap-x-3 min-w-0 border-b border-stone-200 pb-1.5">
                <span className="min-w-0 break-words">{(ACTIVITY_COPY[a.action] ?? a.action) + method}</span>
                <time className="text-xs text-stone-600" dateTime={a.created_at}>{fmtDateTime(a.created_at)}</time>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

function PrivacySection({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  async function remove(e: SubmitLike) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await callApi('/api/v1/me', { method: 'DELETE', body: jsonBody({ confirm_email: confirm }) });
    setBusy(false);
    if (res.ok) window.location.assign('/?account=deleted');
    else setError(res.message);
  }

  return (
    <Section id="privacy" title="Quyền riêng tư & dữ liệu">
      <p className="text-sm text-stone-700">Tải xuống toàn bộ dữ liệu Zuey lưu về bạn (hồ sơ, phiên đăng nhập, khoá API, gói, đơn hàng, email đã gửi, hoạt động) dưới dạng JSON.</p>
      <p className="mt-3"><a className={btnGhost} href="/api/v1/me/export" download>Xuất dữ liệu (JSON)</a></p>
      <h3 className="mt-6 text-sm font-semibold">Xoá tài khoản</h3>
      <p className="mt-1 text-sm text-stone-700">Xoá hồ sơ, đăng xuất mọi thiết bị và thu hồi mọi khoá API. Gói đang hoạt động sẽ mất. Chứng từ thanh toán được giữ lại theo quy định kế toán nhưng không còn gắn với email của bạn.</p>
      <p className="mt-3"><button type="button" className={btnDanger} onClick={() => { setError(null); setConfirm(''); setOpen(true); }}>Xoá tài khoản…</button></p>
      <MemberDialog open={open} title="Xoá tài khoản vĩnh viễn" onClose={() => setOpen(false)} busy={busy}>
        <form className="grid gap-3" onSubmit={remove}>
          <label htmlFor={fieldId} className="text-sm">Nhập <strong className="break-all">{me.email}</strong> để xác nhận.</label>
          <input id={fieldId} className={input} type="email" autoComplete="off" value={confirm} onChange={e => setConfirm(e.target.value)} />
          <div role="status" aria-live="polite" className="empty:hidden">{error && <p className={alertError}>{error}</p>}</div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setOpen(false)} disabled={busy}>Huỷ</button>
            <button type="submit" className={btnDanger} disabled={busy || confirm.trim().toLowerCase() !== me.email}>{busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}</button>
          </div>
        </form>
      </MemberDialog>
    </Section>
  );
}

// ---------------------------------------------------------------------------

/** /account: profile, email, plan & billing, API keys, sessions, activity, privacy. */
export function AccountApp({ keyScopes }: { keyScopes: readonly string[] }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    void callApi('/api/v1/me', { cache: 'no-store' }).then(res => {
      if (res.ok) { const parsed = parseMe(res.data); if (parsed) setMe(parsed); else setError('Phản hồi không hợp lệ.'); return; }
      // No member account behind this browser's session: send the visitor to sign in instead of a dead end.
      if (res.status === 401 || res.code === 'member_account_required') { window.location.assign(loginUrl('/account')); return; }
      setError(res.message);
    });
  }, []);

  async function logout() {
    setSigningOut(true);
    const res = await callApi('/api/members/auth/logout', { method: 'POST' });
    if (res.ok) window.location.assign('/');
    else { setSigningOut(false); setError(res.message); }
  }

  if (!me) {
    return (
      <section className={card} aria-labelledby="account-title">
        <h1 id="account-title" className="text-2xl font-bold font-serif">Tài khoản</h1>
        <div className="mt-4" role="status" aria-live="polite">{error ? <p className={alertError}>{error}</p> : <p className="text-sm text-stone-600">Đang tải…</p>}</div>
      </section>
    );
  }

  const nav = [['profile', 'Hồ sơ'], ['email', 'Email'], ['billing', 'Gói'], ['keys', 'Khoá API'], ['sessions', 'Thiết bị'], ['activity', 'Hoạt động'], ['privacy', 'Dữ liệu']] as const;

  return (
    <div className="w-full grid gap-5 min-w-0">
      <header className={card}>
        <div className="flex flex-wrap items-center gap-4 min-w-0">
          {me.avatar_url
            ? <img src={me.avatar_url} alt="" width={56} height={56} className="w-14 h-14 rounded-full object-cover border border-stone-300 bg-white" referrerPolicy="no-referrer" />
            : <span aria-hidden="true" className="w-14 h-14 rounded-full bg-stone-900 text-amber-50 grid place-items-center text-xl font-bold">{(me.name ?? me.email).slice(0, 1).toUpperCase()}</span>}
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold font-serif break-words">{me.name ?? 'Tài khoản của bạn'}</h1>
            <p className="text-sm text-stone-600 break-all">{me.email}</p>
            <p className="mt-1 flex flex-wrap gap-1.5 text-xs">
              {me.is_admin && <span className="rounded-full bg-stone-900 text-amber-50 px-2 py-0.5 font-semibold">Quản trị</span>}
              {me.plans.map(p => <span key={p} className="rounded-full bg-amber-200 px-2 py-0.5 font-semibold">{planName(p)}</span>)}
              {!me.is_admin && me.plans.length === 0 && <span className="rounded-full bg-stone-200 px-2 py-0.5">Chưa có gói</span>}
            </p>
          </div>
          <button type="button" className={btnGhost} onClick={() => { void logout(); }} disabled={signingOut}>{signingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}</button>
        </div>
        <nav aria-label="Mục tài khoản" className="mt-5">
          <ul className="flex flex-wrap gap-1.5 text-xs sm:text-sm">
            {nav.map(([id, label]) => <li key={id}><a className="inline-block rounded-full border border-stone-300 bg-white/70 px-3 py-1.5 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500" href={`#${id}`}>{label}</a></li>)}
          </ul>
        </nav>
        <Notice ok={null} error={error} />
      </header>
      <ProfileSection me={me} onSaved={setMe} />
      <EmailSection me={me} />
      <BillingSection />
      <Section id="keys" title="Khoá API">
        <ApiKeysPanel scopes={keyScopes} />
      </Section>
      <SessionsSection />
      <ActivitySection />
      <PrivacySection me={me} />
    </div>
  );
}
