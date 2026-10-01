import { useCallback, useEffect, useId, useState } from 'react';
import { MemberDialog } from './MemberDialog';
import type { SubmitLike } from './member-ui';
import {
  alertError, alertInfo, btnDanger, btnGhost, btnPrimary, callApi, fmtDate, fmtDateTime, input, isRecord, jsonBody, records, str, strList, strOrNull,
} from './member-ui';

interface KeyView {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  replaced_by: string | null;
  status: string;
}

const SCOPE_COPY: Record<string, string> = {
  'articles:read': 'Đọc bài viết (theo gói của bạn)',
  'chat:write': 'Chat với Zuey AI (theo gói của bạn)',
  'account:read': 'Xem hồ sơ, phiên đăng nhập và hoạt động',
  'account:write': 'Sửa hồ sơ (tên, ảnh, ngôn ngữ)',
  'billing:read': 'Xem gói và đơn hàng',
  'checkout:write': 'Tạo đơn thanh toán',
};

const STATUS_COPY: Record<string, string> = { active: 'Đang hoạt động', expired: 'Đã hết hạn', revoked: 'Đã thu hồi' };

function parseKey(v: unknown): KeyView | null {
  if (!isRecord(v) || !str(v, 'id')) return null;
  return {
    id: str(v, 'id'), prefix: str(v, 'prefix'), name: str(v, 'name'), scopes: strList(v, 'scopes'),
    created_at: str(v, 'created_at'), expires_at: str(v, 'expires_at'), last_used_at: strOrNull(v, 'last_used_at'),
    revoked_at: strOrNull(v, 'revoked_at'), replaced_by: strOrNull(v, 'replaced_by'), status: str(v, 'status'),
  };
}

type Dialog =
  | { kind: 'create' }
  | { kind: 'reveal'; secret: string; key: KeyView; rotatedFrom: KeyView | null }
  | { kind: 'rotate'; key: KeyView }
  | { kind: 'revoke'; key: KeyView }
  | null;

function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const fieldId = useId();
  return (
    <div className="grid gap-3">
      <p className={alertInfo}>Đây là lần duy nhất khoá được hiển thị. Hãy lưu vào trình quản lý mật khẩu hoặc biến môi trường ngay bây giờ.</p>
      <label htmlFor={fieldId} className="text-sm font-medium">Khoá API</label>
      <input id={fieldId} readOnly value={secret} className={`${input} font-mono text-xs`} onFocus={e => e.currentTarget.select()} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnGhost} onClick={() => { navigator.clipboard.writeText(secret).then(() => setCopied(true), () => setCopied(false)); }}>
          {copied ? 'Đã sao chép' : 'Sao chép khoá'}
        </button>
        <button type="button" className={btnPrimary} onClick={onDone}>Tôi đã lưu khoá</button>
      </div>
      <p className="text-xs text-stone-600 break-words">Dùng với header <code className="font-mono">Authorization: Bearer &lt;khoá&gt;</code> cho REST API và MCP.</p>
    </div>
  );
}

/** Personal API keys: create (scoped, expiring), one-time reveal, rotate with overlap, revoke. */
export function ApiKeysPanel({ scopes }: { scopes: readonly string[] }) {
  const [keys, setKeys] = useState<KeyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; scopes: string[]; days: number }>({ name: '', scopes: ['articles:read'], days: 90 });
  const nameId = useId();
  const daysId = useId();

  const load = useCallback(async () => {
    const res = await callApi('/api/v1/me/keys', { cache: 'no-store' });
    if (res.ok) {
      setKeys(records(res.data).map(parseKey).filter((k): k is KeyView => k !== null));
      setError(null);
    } else setError(res.message);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function open(d: Dialog) {
    setDialogError(null);
    setDialog(d);
  }

  async function create(e: SubmitLike) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setDialogError(null);
    const res = await callApi('/api/v1/me/keys', { method: 'POST', body: jsonBody({ name: form.name, scopes: form.scopes, expires_in_days: form.days }) });
    setBusy(false);
    const key = res.ok && isRecord(res.data) ? parseKey(res.data.key) : null;
    const secret = res.ok && isRecord(res.data) ? str(res.data, 'secret') : '';
    if (!res.ok || !key || !secret) { setDialogError(res.ok ? 'Phản hồi không hợp lệ.' : res.message); return; }
    setForm({ name: '', scopes: ['articles:read'], days: 90 });
    setDialog({ kind: 'reveal', secret, key, rotatedFrom: null });
    void load();
  }

  async function rotate(key: KeyView) {
    if (busy) return;
    setBusy(true);
    setDialogError(null);
    const res = await callApi(`/api/v1/me/keys/${encodeURIComponent(key.id)}/rotate`, { method: 'POST', body: jsonBody({}) });
    setBusy(false);
    const next = res.ok && isRecord(res.data) ? parseKey(res.data.key) : null;
    const secret = res.ok && isRecord(res.data) ? str(res.data, 'secret') : '';
    if (!res.ok || !next || !secret) { setDialogError(res.ok ? 'Phản hồi không hợp lệ.' : res.message); return; }
    setDialog({ kind: 'reveal', secret, key: next, rotatedFrom: key });
    void load();
  }

  async function revoke(key: KeyView) {
    if (busy) return;
    setBusy(true);
    setDialogError(null);
    const res = await callApi(`/api/v1/me/keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) { setDialogError(res.message); return; }
    setDialog(null);
    void load();
  }

  const toggleScope = (scope: string) =>
    setForm(f => ({ ...f, scopes: f.scopes.includes(scope) ? f.scopes.filter(s => s !== scope) : [...f.scopes, scope] }));

  const close = () => { if (!busy) setDialog(null); };

  return (
    <div className="grid gap-4 min-w-0">
      <p className="text-sm text-stone-700">
        Khoá API cá nhân cho phép công cụ của bạn (script, agent, MCP client) truy cập dữ liệu của chính bạn trong phạm vi quyền đã chọn và gói hiện tại. Khoá không bao giờ có quyền quản trị.
      </p>
      <div role="status" aria-live="polite" className="empty:hidden">{error && <p className={alertError}>{error}</p>}</div>
      <p><button type="button" className={btnPrimary} onClick={() => open({ kind: 'create' })}>Tạo khoá mới</button></p>

      {keys === null && !error && <p className="text-sm text-stone-600">Đang tải khoá…</p>}
      {keys && keys.length === 0 && <p className="text-sm text-stone-600">Bạn chưa có khoá API nào.</p>}
      {keys && keys.length > 0 && (
        <ul className="grid gap-3">
          {keys.map(k => (
            <li key={k.id} className="rounded-2xl border border-stone-300 bg-white/70 p-3 sm:p-4 grid gap-2 min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2 min-w-0">
                <p className="font-semibold break-words min-w-0">{k.name}</p>
                <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${k.status === 'active' ? 'bg-emerald-100 text-emerald-900' : 'bg-stone-200 text-stone-700'}`}>
                  {STATUS_COPY[k.status] ?? k.status}{k.replaced_by && k.status === 'active' ? ' · đã có khoá thay thế' : ''}
                </span>
              </div>
              <p className="font-mono text-xs text-stone-700 break-all">{k.prefix}…</p>
              <p className="text-xs text-stone-600 break-words">Quyền: {k.scopes.join(', ')}</p>
              <p className="text-xs text-stone-600">
                Tạo {fmtDate(k.created_at)} · Hết hạn {fmtDate(k.expires_at)} · Dùng lần cuối {k.last_used_at ? fmtDateTime(k.last_used_at) : 'chưa dùng'}
              </p>
              {k.status !== 'revoked' && (
                <div className="flex flex-wrap gap-2">
                  {k.status === 'active' && !k.replaced_by && (
                    <button type="button" className={btnGhost} onClick={() => open({ kind: 'rotate', key: k })} aria-label={`Xoay vòng khoá ${k.name}`}>Xoay vòng</button>
                  )}
                  <button type="button" className={btnDanger} onClick={() => open({ kind: 'revoke', key: k })} aria-label={`Thu hồi khoá ${k.name}`}>Thu hồi</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <MemberDialog open={dialog?.kind === 'create'} title="Tạo khoá API" onClose={close} busy={busy}>
        <form className="grid gap-3" onSubmit={create}>
          <label htmlFor={nameId} className="text-sm font-medium">Tên khoá</label>
          <input id={nameId} className={input} required maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ví dụ: Claude Desktop" />
          <fieldset className="grid gap-2 min-w-0">
            <legend className="text-sm font-medium mb-1">Quyền</legend>
            {scopes.map(scope => (
              <label key={scope} className="flex gap-2 items-start text-sm min-w-0">
                <input type="checkbox" className="mt-1 accent-stone-900" checked={form.scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                <span className="min-w-0"><span className="font-mono text-xs">{scope}</span><span className="block text-xs text-stone-600">{SCOPE_COPY[scope] ?? ''}</span></span>
              </label>
            ))}
          </fieldset>
          <label htmlFor={daysId} className="text-sm font-medium">Hết hạn sau</label>
          <select id={daysId} className={input} value={form.days} onChange={e => setForm({ ...form, days: Number(e.target.value) })}>
            {[7, 30, 90, 180, 365].map(d => <option key={d} value={d}>{d} ngày</option>)}
          </select>
          <div role="status" aria-live="polite" className="empty:hidden">{dialogError && <p className={alertError}>{dialogError}</p>}</div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btnGhost} onClick={close} disabled={busy}>Huỷ</button>
            <button type="submit" className={btnPrimary} disabled={busy || form.name.trim() === '' || form.scopes.length === 0}>{busy ? 'Đang tạo…' : 'Tạo khoá'}</button>
          </div>
        </form>
      </MemberDialog>

      <MemberDialog open={dialog?.kind === 'reveal'} title={dialog?.kind === 'reveal' && dialog.rotatedFrom ? 'Khoá thay thế đã sẵn sàng' : 'Khoá API đã được tạo'} onClose={() => setDialog(null)}>
        {dialog?.kind === 'reveal' && (
          <>
            {dialog.rotatedFrom && (
              <p className="text-sm text-stone-700">Khoá cũ <strong className="break-words">{dialog.rotatedFrom.name}</strong> vẫn hoạt động cho đến khi bạn thu hồi — hãy cập nhật công cụ sang khoá mới rồi thu hồi khoá cũ.</p>
            )}
            <SecretReveal secret={dialog.secret} onDone={() => setDialog(null)} />
          </>
        )}
      </MemberDialog>

      <MemberDialog open={dialog?.kind === 'rotate'} title="Xoay vòng khoá" onClose={close} busy={busy}>
        {dialog?.kind === 'rotate' && (
          <>
            <p className="text-sm text-stone-700">Tạo khoá mới cùng quyền cho <strong className="break-words">{dialog.key.name}</strong>. Khoá cũ vẫn dùng được đến khi bạn thu hồi, để bạn chuyển đổi không gián đoạn.</p>
            <div role="status" aria-live="polite" className="empty:hidden">{dialogError && <p className={alertError}>{dialogError}</p>}</div>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btnGhost} onClick={close} disabled={busy}>Huỷ</button>
              <button type="button" className={btnPrimary} onClick={() => { void rotate(dialog.key); }} disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo khoá thay thế'}</button>
            </div>
          </>
        )}
      </MemberDialog>

      <MemberDialog open={dialog?.kind === 'revoke'} title="Thu hồi khoá" onClose={close} busy={busy}>
        {dialog?.kind === 'revoke' && (
          <>
            <p className="text-sm text-stone-700">Khoá <strong className="break-words">{dialog.key.name}</strong> (<span className="font-mono">{dialog.key.prefix}…</span>) sẽ ngừng hoạt động ngay lập tức. Không thể hoàn tác.</p>
            <div role="status" aria-live="polite" className="empty:hidden">{dialogError && <p className={alertError}>{dialogError}</p>}</div>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btnGhost} onClick={close} disabled={busy}>Huỷ</button>
              <button type="button" className={btnDanger} onClick={() => { void revoke(dialog.key); }} disabled={busy}>{busy ? 'Đang thu hồi…' : 'Thu hồi khoá'}</button>
            </div>
          </>
        )}
      </MemberDialog>
    </div>
  );
}
