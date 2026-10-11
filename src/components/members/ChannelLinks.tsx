import { useCallback, useEffect, useState } from 'react';
import { alertError, btnDanger, callApi, fmtDateTime, records, str } from './member-ui';

interface ChannelLink {
  provider: string;
  external_id: string;
  linked_at: string;
}

const PROVIDER_LABEL: Record<string, string> = { telegram: 'Telegram' };

/** Chat accounts (Telegram) linked for the Zuey AI agent gate, with unlink. Rendered inside "Tài khoản liên kết". */
export function ChannelLinks() {
  const [links, setLinks] = useState<ChannelLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await callApi('/api/v1/me/channels');
    if (res.ok) {
      setLinks(records(res.data).map(r => ({ provider: str(r, 'provider'), external_id: str(r, 'external_id'), linked_at: str(r, 'linked_at') })));
    } else {
      setLinks([]);
      setError(res.message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function unlink(l: ChannelLink) {
    const key = `${l.provider}:${l.external_id}`;
    setBusy(key); setError(null);
    const res = await callApi(`/api/v1/me/channels/${encodeURIComponent(l.provider)}/${encodeURIComponent(l.external_id)}`, { method: 'DELETE' });
    setBusy(null);
    if (res.ok) await load();
    else setError(res.message);
  }

  if (!links || links.length === 0) {
    return error ? <p className={`${alertError} mt-2`}>{error}</p> : null;
  }
  return (
    <>
      <ul className="mt-2 grid gap-2 text-sm">
        {links.map(l => {
          const key = `${l.provider}:${l.external_id}`;
          return (
            <li key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
              <span className="min-w-0 break-words">
                {PROVIDER_LABEL[l.provider] ?? l.provider}
                <span className="text-stone-600"> · ID {l.external_id} · liên kết {fmtDateTime(l.linked_at)} (dùng cho Zuey AI trên Telegram)</span>
              </span>
              <button type="button" className={btnDanger} disabled={busy === key} onClick={() => unlink(l)}>
                {busy === key ? 'Đang huỷ…' : 'Huỷ liên kết'}
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className={`${alertError} mt-2`}>{error}</p>}
    </>
  );
}
