import { useCallback, useEffect, useState } from 'react';
import { MemberDialog } from '../members/MemberDialog';
import {
  alertError, btnDanger, btnGhost, callApi, card, fmtDateTime, isRecord, numOr, records, str, strList, strOrNull,
} from '../members/member-ui';
import { scopeLabel } from '../../lib/oauth/scope-copy';

export interface ConnectedAppView {
  id: string;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  registration: string;
  redirect_hosts: string[];
  scopes: string[];
  granted_at: string;
  last_used_at: string | null;
  active_tokens: number;
}

function parseApp(v: unknown): ConnectedAppView | null {
  if (!isRecord(v) || !str(v, 'id')) return null;
  return {
    id: str(v, 'id'), client_id: str(v, 'client_id'), client_name: str(v, 'client_name'), client_uri: strOrNull(v, 'client_uri'),
    registration: str(v, 'registration'), redirect_hosts: strList(v, 'redirect_hosts'), scopes: strList(v, 'scopes'),
    granted_at: str(v, 'granted_at'), last_used_at: strOrNull(v, 'last_used_at'), active_tokens: numOr(v, 'active_tokens'),
  };
}

/** Apps (MCP clients) the member authorized through OAuth; disconnecting revokes consent and every token. */
export function ConnectedApps() {
  const [apps, setApps] = useState<ConnectedAppView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ConnectedAppView | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await callApi('/oauth/connections', { cache: 'no-store' });
    if (res.ok) {
      setApps(records(res.data).map(parseApp).filter((a): a is ConnectedAppView => a !== null));
      setError(null);
    } else setError(res.status === 401 ? 'Hãy đăng nhập để xem ứng dụng đã kết nối.' : res.message);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function disconnect(app: ConnectedAppView) {
    if (busy) return;
    setBusy(true);
    setDialogError(null);
    const res = await callApi(`/oauth/connections/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) { setDialogError(res.message); return; }
    setTarget(null);
    void load();
  }

  const close = () => { if (!busy) setTarget(null); };

  return (
    <section id="connected-apps" className={`${card} mt-4 grid gap-4`} aria-labelledby="connected-apps-title">
      <h2 id="connected-apps-title" className="text-lg font-bold">Ứng dụng đã kết nối</h2>
      <p className="text-sm text-stone-700">
        Các ứng dụng MCP (ví dụ Claude, ChatGPT, Cursor) bạn đã cho phép truy cập qua OAuth. Ngắt kết nối sẽ thu hồi ngay mọi token của ứng dụng đó.
      </p>
      <div role="status" aria-live="polite" className="empty:hidden">{error && <p className={alertError}>{error}</p>}</div>
      {apps === null && !error && <p className="text-sm text-stone-600">Đang tải…</p>}
      {apps && apps.length === 0 && <p className="text-sm text-stone-600">Chưa có ứng dụng nào được kết nối.</p>}
      {apps && apps.length > 0 && (
        <ul className="grid gap-3">
          {apps.map(app => (
            <li key={app.id} className="rounded-2xl border border-stone-300 bg-white/70 p-3 sm:p-4 grid gap-2 min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2 min-w-0">
                <p className="font-semibold break-words min-w-0">{app.client_name}</p>
                <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${app.active_tokens > 0 ? 'bg-emerald-100 text-emerald-900' : 'bg-stone-200 text-stone-700'}`}>
                  {app.active_tokens > 0 ? 'Đang kết nối' : 'Không có phiên hoạt động'}
                </span>
              </div>
              {app.redirect_hosts.length > 0 && <p className="text-xs text-stone-600 break-all">Chuyển hướng tới: {app.redirect_hosts.join(', ')}</p>}
              <ul className="grid gap-0.5 text-xs text-stone-700" aria-label={`Quyền của ${app.client_name}`}>
                {app.scopes.map(s => <li key={s} className="break-words"><span className="font-mono">{s}</span> — {scopeLabel(s)}</li>)}
              </ul>
              <p className="text-xs text-stone-600">
                Cho phép {fmtDateTime(app.granted_at)} · Dùng lần cuối {app.last_used_at ? fmtDateTime(app.last_used_at) : 'chưa dùng'}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btnDanger} onClick={() => { setDialogError(null); setTarget(app); }} aria-label={`Ngắt kết nối ${app.client_name}`}>
                  Ngắt kết nối
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <MemberDialog open={target !== null} title="Ngắt kết nối ứng dụng" onClose={close} busy={busy}>
        {target && (
          <>
            <p className="text-sm text-stone-700">
              <strong className="break-words">{target.client_name}</strong> sẽ mất quyền truy cập ngay lập tức. Muốn dùng lại, bạn cần kết nối và đồng ý lần nữa.
            </p>
            <div role="status" aria-live="polite" className="empty:hidden">{dialogError && <p className={alertError}>{dialogError}</p>}</div>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btnGhost} onClick={close} disabled={busy}>Huỷ</button>
              <button type="button" className={btnDanger} onClick={() => { void disconnect(target); }} disabled={busy}>{busy ? 'Đang ngắt…' : 'Ngắt kết nối'}</button>
            </div>
          </>
        )}
      </MemberDialog>
    </section>
  );
}
