import { useCallback, useEffect, useState } from 'react';
import { alertError, btnDanger, callApi, fmtDateTime, records, str, strOrNull } from './member-ui';

interface ChannelLink {
  id: string;
  channel_type: string;
  sender_hint: string;
  linked_at: string | null;
}

const CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', zalo: 'Zalo', facebook: 'Facebook', discord: 'Discord' };

/**
 * Chat accounts linked in Dewee for the Zuey AI agent gate, with unlink. Rendered inside "Tài khoản liên kết".
 * Linking itself happens from the chat: the bot sends a Dewee link when needed. Hidden while Dewee linking is not configured.
 */
export function ChannelLinks() {
  const [links, setLinks] = useState<ChannelLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await callApi('/api/v1/me/channels');
    if (res.ok) {
      setLinks(records(res.data).map(r => ({ id: str(r, 'id'), channel_type: str(r, 'channel_type'), sender_hint: str(r, 'sender_hint'), linked_at: strOrNull(r, 'linked_at') })));
      return;
    }
    setLinks([]);
    if (res.code !== 'dewee_identity_unconfigured') setError(res.message);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function unlink(l: ChannelLink) {
    setBusy(l.id); setError(null);
    const res = await callApi(`/api/v1/me/channels/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
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
        {links.map(l => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
            <span className="min-w-0 break-words">
              {CHANNEL_LABEL[l.channel_type] ?? l.channel_type}
              <span className="text-stone-600">
                {l.sender_hint ? ` · ID …${l.sender_hint}` : ''}{l.linked_at ? ` · liên kết ${fmtDateTime(l.linked_at)}` : ''} (dùng cho Zuey AI trong ứng dụng chat)
              </span>
            </span>
            <button type="button" className={btnDanger} disabled={busy === l.id} onClick={() => unlink(l)}>
              {busy === l.id ? 'Đang huỷ…' : 'Huỷ liên kết'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className={`${alertError} mt-2`}>{error}</p>}
    </>
  );
}
