import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_TIMEZONE, zonedTimeToUtc } from '../../lib/booking/timezone';

interface RuleDraft {
  weekday: number;
  start_time: string;
  end_time: string;
  timezone: string;
  slot_minutes: number;
}

interface ExceptionDraft {
  start_at: string;
  end_at: string;
  reason: string;
}

interface AdminBooking {
  id: string;
  code: string;
  status: string;
  slot_start: string;
  guest_name: string;
  guest_email: string;
  company: string;
  notes: string;
  payment_method: string;
  amount_paid: number | null;
  amount_expected: number | null;
  currency: string;
  meet_status: string;
  meet_error: string;
  email_status: string;
  email_error: string;
  attention_reason: string;
  admin_note: string;
  meet_url: string;
}

type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function s(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  return typeof v === 'string' ? v : '';
}

function n(r: Record<string, unknown>, k: string): number | null {
  const v = r[k];
  return typeof v === 'number' ? v : null;
}

async function api(url: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const res = await fetch(url, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    const body: unknown = await res.json().catch(() => null);
    if (isRecord(body) && body.success === true && isRecord(body.data)) return { ok: true, data: body.data };
    const err = isRecord(body) && isRecord(body.error) ? body.error : {};
    return { ok: false, message: typeof err.message === 'string' ? err.message : `Request failed (HTTP ${res.status})` };
  } catch {
    return { ok: false, message: 'Network error' };
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUSES = ['', 'held', 'confirmed', 'needs_attention', 'expired', 'cancelled'];
const field = 'px-2.5 py-1.5 bg-stone-900 border border-stone-700 rounded-lg text-xs text-white focus:outline-none focus:border-amber-400 min-w-0';
const btn = 'px-3 py-1.5 rounded-lg text-xs font-semibold border border-stone-700 text-stone-200 hover:bg-stone-800 disabled:opacity-50';
const btnPrimary = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-400 hover:bg-amber-300 text-stone-950 disabled:opacity-50';

const STATUS_STYLE: Record<string, string> = {
  confirmed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  held: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
  needs_attention: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  expired: 'bg-stone-700/40 text-stone-400 border-stone-600',
  cancelled: 'bg-stone-700/40 text-stone-400 border-stone-600',
};

function toBooking(r: Record<string, unknown>): AdminBooking {
  return {
    id: s(r, 'id'), code: s(r, 'code'), status: s(r, 'status'), slot_start: s(r, 'slot_start'),
    guest_name: s(r, 'guest_name'), guest_email: s(r, 'guest_email'), company: s(r, 'company'), notes: s(r, 'notes'),
    payment_method: s(r, 'payment_method'), amount_paid: n(r, 'amount_paid'), amount_expected: n(r, 'amount_expected'),
    currency: s(r, 'currency'), meet_status: s(r, 'meet_status'), meet_error: s(r, 'meet_error'),
    email_status: s(r, 'email_status'), email_error: s(r, 'email_error'), attention_reason: s(r, 'attention_reason'),
    admin_note: s(r, 'admin_note'), meet_url: s(r, 'meet_url'),
  };
}

/** Converts a local date (YYYY-MM-DD) at midnight in `tz` to a UTC ISO string. */
function localDateToIso(date: string, tz: string, plusDays = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]) + plusDays, 0, 0, tz)).toISOString();
}

function formatInTz(iso: string, tz: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function money(amount: number | null, currency: string): string {
  if (amount === null) return '—';
  return currency === 'USD' ? `$${(amount / 100).toFixed(2)}` : `${amount.toLocaleString('en-US')} ${currency || ''}`.trim();
}

export function BookingPanel() {
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionDraft[]>([]);
  const [newEx, setNewEx] = useState({ from: '', to: '', reason: '' });
  const [bookings, setBookings] = useState<AdminBooking[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAvailability = useCallback(async () => {
    const r = await api('/api/v1/booking/availability');
    if (!r.ok) { setMessage({ kind: 'error', text: r.message }); return; }
    const rawRules = Array.isArray(r.data.rules) ? r.data.rules.filter(isRecord) : [];
    const rawEx = Array.isArray(r.data.exceptions) ? r.data.exceptions.filter(isRecord) : [];
    setRules(rawRules.map(x => ({
      weekday: n(x, 'weekday') ?? 1, start_time: s(x, 'start_time'), end_time: s(x, 'end_time'),
      timezone: s(x, 'timezone') || DEFAULT_TIMEZONE, slot_minutes: n(x, 'slot_minutes') ?? 90,
    })));
    setExceptions(rawEx.map(x => ({ start_at: s(x, 'start_at'), end_at: s(x, 'end_at'), reason: s(x, 'reason') })));
  }, []);

  const loadBookings = useCallback(async () => {
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    const r = await api(`/api/v1/booking/admin${qs}`);
    if (!r.ok) { setMessage({ kind: 'error', text: r.message }); return; }
    setBookings((Array.isArray(r.data.bookings) ? r.data.bookings.filter(isRecord) : []).map(toBooking));
  }, [statusFilter]);

  useEffect(() => { void loadAvailability(); }, [loadAvailability]);
  useEffect(() => { void loadBookings(); }, [loadBookings]);

  const saveAvailability = async () => {
    setBusy(true);
    const r = await api('/api/v1/booking/availability', { method: 'PUT', body: JSON.stringify({ rules, exceptions }) });
    setBusy(false);
    if (r.ok) { setMessage({ kind: 'ok', text: 'Availability saved' }); void loadAvailability(); } else setMessage({ kind: 'error', text: r.message });
  };

  const addException = () => {
    const tz = rules[0]?.timezone ?? DEFAULT_TIMEZONE;
    const start = localDateToIso(newEx.from, tz);
    const end = localDateToIso(newEx.to || newEx.from, tz, 1);
    if (!start || !end || end <= start) { setMessage({ kind: 'error', text: 'Pick a valid date range' }); return; }
    setExceptions([...exceptions, { start_at: start, end_at: end, reason: newEx.reason }]);
    setNewEx({ from: '', to: '', reason: '' });
  };

  const act = async (id: string, action: 'cancel' | 'resolve' | 'mark_attention' | 'note') => {
    if (action === 'cancel' && !window.confirm('Cancel this booking? Refunds are NOT automatic; handle them manually in Polar/bank.')) return;
    setBusy(true);
    const r = await api('/api/v1/booking/admin', { method: 'POST', body: JSON.stringify({ id, action, note: notes[id] || undefined }) });
    setBusy(false);
    if (r.ok) { setMessage({ kind: 'ok', text: `Booking ${action} done` }); void loadBookings(); } else setMessage({ kind: 'error', text: r.message });
  };

  const updateRule = (i: number, patch: Partial<RuleDraft>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const adminTz = rules[0]?.timezone ?? DEFAULT_TIMEZONE;

  return (
    <div className="space-y-6">
      <div aria-live="polite" role="status">
        {message && (
          <p className={`text-xs rounded-lg px-3 py-2 border ${message.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>{message.text}</p>
        )}
      </div>

      <section className="bg-stone-900/60 border border-stone-800 rounded-2xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-white text-sm">Weekly availability</h2>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={() => setRules([...rules, { weekday: 1, start_time: '09:00', end_time: '17:00', timezone: DEFAULT_TIMEZONE, slot_minutes: 90 }])}>Add rule</button>
            <button type="button" className={btnPrimary} onClick={saveAvailability} disabled={busy}>Save availability</button>
          </div>
        </div>
        {rules.length === 0 && <p className="text-xs text-stone-400">No rules yet: guests see no open slots until you add one.</p>}
        <div className="space-y-2">
          {rules.map((r, i) => (
            <div key={i} className="grid grid-cols-2 sm:grid-cols-[90px_90px_90px_minmax(0,1fr)_80px_auto] gap-2 items-center">
              <select aria-label="Weekday" className={field} value={r.weekday} onChange={e => updateRule(i, { weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((w, d) => <option key={w} value={d}>{w}</option>)}
              </select>
              <input aria-label="Start time" type="time" className={field} value={r.start_time} onChange={e => updateRule(i, { start_time: e.target.value })} />
              <input aria-label="End time" type="time" className={field} value={r.end_time} onChange={e => updateRule(i, { end_time: e.target.value })} />
              <input aria-label="Time zone" className={field} value={r.timezone} onChange={e => updateRule(i, { timezone: e.target.value })} />
              <input aria-label="Slot minutes" type="number" min={15} max={480} className={field} value={r.slot_minutes} onChange={e => updateRule(i, { slot_minutes: Number(e.target.value) })} />
              <button type="button" className={btn} onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
        </div>

        <h3 className="font-semibold text-white text-xs pt-2">Blocked dates ({adminTz})</h3>
        <div className="grid grid-cols-1 sm:grid-cols-[150px_150px_minmax(0,1fr)_auto] gap-2">
          <input aria-label="Blocked from" type="date" className={field} value={newEx.from} onChange={e => setNewEx({ ...newEx, from: e.target.value })} />
          <input aria-label="Blocked to (inclusive)" type="date" className={field} value={newEx.to} onChange={e => setNewEx({ ...newEx, to: e.target.value })} />
          <input aria-label="Reason" placeholder="Reason (optional)" className={field} value={newEx.reason} onChange={e => setNewEx({ ...newEx, reason: e.target.value })} />
          <button type="button" className={btn} onClick={addException}>Add block</button>
        </div>
        <ul className="space-y-1">
          {exceptions.map((e, i) => (
            <li key={`${e.start_at}-${i}`} className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-300 bg-stone-950/60 rounded-lg px-3 py-2">
              <span>{formatInTz(e.start_at, adminTz)} → {formatInTz(e.end_at, adminTz)} {e.reason && `· ${e.reason}`}</span>
              <button type="button" className={btn} onClick={() => setExceptions(exceptions.filter((_, j) => j !== i))}>Remove</button>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-stone-500">Changes apply after “Save availability”.</p>
      </section>

      <section className="bg-stone-900/60 border border-stone-800 rounded-2xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-white text-sm">Bookings</h2>
          <div className="flex gap-2">
            <select aria-label="Filter by status" className={field} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              {STATUSES.map(st => <option key={st} value={st}>{st || 'all statuses'}</option>)}
            </select>
            <button type="button" className={btn} onClick={() => void loadBookings()}>Refresh</button>
          </div>
        </div>
        {bookings.length === 0 && <p className="text-xs text-stone-400">No bookings.</p>}
        <ul className="space-y-3">
          {bookings.map(b => (
            <li key={b.id} className="border border-stone-800 rounded-xl p-3 space-y-2 text-xs text-stone-300">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full border font-mono text-[10px] ${STATUS_STYLE[b.status] ?? 'border-stone-600'}`}>{b.status}</span>
                {b.attention_reason && <span className="text-rose-300 font-semibold">{b.attention_reason}</span>}
                <span className="font-mono text-stone-400">{b.code}</span>
                <span className="text-white font-semibold">{formatInTz(b.slot_start, adminTz)}</span>
              </div>
              <p className="break-words">{b.guest_name} · {b.guest_email}{b.company && ` · ${b.company}`}</p>
              {b.notes && <p className="text-stone-400 break-words">{b.notes}</p>}
              <p>
                {b.payment_method} · paid {money(b.amount_paid, b.currency)} / expected {money(b.amount_expected, b.currency)}
                {' · '}Meet: <strong>{b.meet_status || '—'}</strong>{b.meet_error && ` (${b.meet_error})`}
                {' · '}Email: <strong>{b.email_status || '—'}</strong>{b.email_error && ` (${b.email_error})`}
              </p>
              {b.meet_url && <a className="text-amber-300 underline break-all" href={b.meet_url} target="_blank" rel="noopener noreferrer">{b.meet_url}</a>}
              {b.admin_note && <p className="text-stone-400">Note: {b.admin_note}</p>}
              <div className="flex flex-wrap gap-2 items-center">
                <input aria-label={`Admin note for ${b.code}`} placeholder="Note" className={`${field} flex-1`} value={notes[b.id] ?? ''} onChange={e => setNotes({ ...notes, [b.id]: e.target.value })} />
                <button type="button" className={btn} disabled={busy} onClick={() => act(b.id, 'note')}>Save note</button>
                {b.status !== 'confirmed' && b.status !== 'cancelled' && (
                  <button type="button" className={btn} disabled={busy} onClick={() => act(b.id, 'resolve')}>Resolve as confirmed</button>
                )}
                {b.status !== 'needs_attention' && b.status !== 'cancelled' && (
                  <button type="button" className={btn} disabled={busy} onClick={() => act(b.id, 'mark_attention')}>Flag</button>
                )}
                {b.status !== 'cancelled' && (
                  <button type="button" className={`${btn} text-rose-300 border-rose-500/40`} disabled={busy} onClick={() => act(b.id, 'cancel')}>Cancel</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
