import React, { useCallback, useEffect, useState } from 'react';
import { OWNER_MODES, OWNER_STATUS_TEXT_MAX, type OwnerMode, type OwnerPublicStatus, type OwnerStatusState } from '../../lib/presence/contract';
import { isOwnerStatusState, sanitizeOwnerStatusText } from '../../lib/presence/presence-owner-status-guards';

const ENDPOINT = '/api/v1/presence/owner';

const MODE_COPY: Record<OwnerMode, { label: string; hint: string }> = {
  auto: { label: 'Auto', hint: 'Online while you have zuey.me open, offline otherwise.' },
  away: { label: 'Away', hint: 'Shown as away, whether or not you are on the site.' },
  busy: { label: 'Busy', hint: 'Shown as busy, whether or not you are on the site.' },
  offline: { label: 'Offline', hint: 'Shown as offline; your status text is hidden.' },
  invisible: { label: 'Invisible', hint: 'Shows as offline. Visitors cannot tell it apart from offline.' },
};

const PUBLIC_COPY: Record<OwnerPublicStatus, string> = { online: 'Online', away: 'Away', busy: 'Busy', offline: 'Offline' };
const PUBLIC_TONE: Record<OwnerPublicStatus, string> = {
  online: 'bg-emerald-400', away: 'bg-amber-400', busy: 'bg-rose-400', offline: 'bg-stone-500',
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads the `{ success, data | error }` envelope into the owner state or a readable error. */
async function readState(res: Response): Promise<OwnerStatusState> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (isRecord(body) && body.success === true && res.ok && isOwnerStatusState(body.data)) return body.data;
  const err = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = err && typeof err.code === 'string' ? err.code : `HTTP ${res.status}`;
  const message = err && typeof err.message === 'string' ? err.message : 'Unexpected response';
  throw new Error(`${code}: ${message}`);
}

/** Formats the last-saved time; `null` when the setting was never saved (the Worker reports epoch 0 for its default). */
export function fmtChangedAt(ts: string): string | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.getTime() <= 0 ? null : d.toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' });
}

/** Studio panel (owner only): the realtime presence mode and status text shown in the Activity Monitor. */
export const PresenceOwnerPanel: React.FC = () => {
  const [state, setState] = useState<OwnerStatusState | null>(null);
  const [mode, setMode] = useState<OwnerMode>('auto');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = (next: OwnerStatusState) => {
    setState(next);
    setMode(next.mode);
    setText(next.text ?? '');
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      apply(await readState(await fetch(ENDPOINT, { credentials: 'same-origin', headers: { Accept: 'application/json' } })));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load presence status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (nextMode: OwnerMode, nextText: string) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ mode: nextMode, text: sanitizeOwnerStatusText(nextText) || null }),
      });
      apply(await readState(res));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save presence status');
    } finally {
      setSaving(false);
    }
  };

  const changedAt = state ? fmtChangedAt(state.updatedAt) : null;
  const cleanText = sanitizeOwnerStatusText(text);
  const tooLong = cleanText.length > OWNER_STATUS_TEXT_MAX;
  const dirty = state !== null && (mode !== state.mode || cleanText !== (state.text ?? ''));

  return (
    <section className="bg-stone-950/80 border border-stone-800 rounded-3xl p-5 sm:p-6 text-stone-100 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold font-serif text-white">Presence</h2>
          <p className="text-xs text-stone-400 mt-1">Your status in the Activity Monitor. Only you (the owner) can change it.</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="px-3 py-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 disabled:opacity-50 text-stone-200 text-xs font-semibold border border-stone-700"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">{error}</p>
      )}

      {state && (
        <div className="rounded-2xl border border-stone-800 bg-stone-900/70 p-4 text-xs text-stone-300 space-y-1" data-presence-preview>
          <div className="text-[11px] uppercase tracking-wide text-stone-500">Visitors see</div>
          <div className="flex items-center gap-2 text-sm text-white font-semibold">
            <span className={`w-2.5 h-2.5 rounded-full ${PUBLIC_TONE[state.public.status]}`} aria-hidden="true" />
            {PUBLIC_COPY[state.public.status]}
            <span className="text-xs font-normal text-stone-400">· {state.public.onSite ? 'On zuey.me right now' : 'Not on zuey.me'}</span>
          </div>
          {state.public.text && <p className="text-stone-200 break-words">{state.public.text}</p>}
          <p className="text-stone-500">
            Setting: {MODE_COPY[state.mode].label} · {state.connected ? 'connected' : 'not connected'}
            {changedAt && ` · changed ${changedAt}`}
          </p>
        </div>
      )}

      <fieldset className="space-y-2" disabled={saving || state === null}>
        <legend className="text-xs font-semibold text-stone-400 mb-1">Mode</legend>
        {OWNER_MODES.map(m => (
          <label
            key={m}
            className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${mode === m ? 'border-amber-400 bg-amber-400/10' : 'border-stone-800 hover:border-stone-700'}`}
          >
            <input type="radio" name="presence-mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="mt-0.5 accent-amber-400" />
            <span>
              <span className="block text-sm font-semibold text-white">{MODE_COPY[m].label}</span>
              <span className="block text-xs text-stone-400">{MODE_COPY[m].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <label htmlFor="presence-text" className="block text-xs font-semibold text-stone-400 mb-1">Status text (optional, public)</label>
        <input
          id="presence-text"
          type="text"
          value={text}
          maxLength={OWNER_STATUS_TEXT_MAX * 2}
          disabled={saving || state === null}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Shipping the presence feature"
          className="w-full px-3.5 py-2 bg-stone-900 border border-stone-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400"
        />
        <p className={`mt-1 text-[11px] ${tooLong ? 'text-rose-400' : 'text-stone-500'}`}>
          {cleanText.length}/{OWNER_STATUS_TEXT_MAX} · hidden while offline or invisible
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save(mode, text)}
          disabled={saving || state === null || tooLong || !dirty}
          className="px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-stone-950 text-sm font-semibold"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => state && void save(state.mode, '')}
          disabled={saving || state === null || !state.text}
          className="px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 disabled:opacity-50 text-stone-200 text-sm font-semibold border border-stone-700"
        >
          Clear text
        </button>
        {saved && !dirty && <span className="text-xs text-emerald-400">Saved</span>}
      </div>
    </section>
  );
};
