import { useCallback, useEffect, useRef, useState } from 'react';

type ResolveAction = 'activate' | 'dismiss';

interface AttentionOrder {
  code: string;
  member_email: string;
  plan_name: string;
  months: number;
  amount_vnd: number;
  amount_paid: number | null;
  attention_reason: string;
  payment_ref: string;
  created_at: string;
  updated_at: string;
}

interface AttentionCard {
  id: string;
  member_email: string;
  plan_name: string;
  amount_cents: number | null;
  currency: string;
  attention_reason: string;
  provider_subscription_id: string;
  updated_at: string;
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

function toOrder(r: Record<string, unknown>): AttentionOrder {
  return {
    code: s(r, 'code'), member_email: s(r, 'member_email'), plan_name: s(r, 'plan_name'), months: n(r, 'months') ?? 1,
    amount_vnd: n(r, 'amount_vnd') ?? 0, amount_paid: n(r, 'amount_paid'), attention_reason: s(r, 'attention_reason'),
    payment_ref: s(r, 'payment_ref'), created_at: s(r, 'created_at'), updated_at: s(r, 'updated_at'),
  };
}

function toCard(r: Record<string, unknown>): AttentionCard {
  return {
    id: s(r, 'id'), member_email: s(r, 'member_email'), plan_name: s(r, 'plan_name'), amount_cents: n(r, 'amount_cents'),
    currency: s(r, 'currency'), attention_reason: s(r, 'attention_reason'), provider_subscription_id: s(r, 'provider_subscription_id'),
    updated_at: s(r, 'updated_at'),
  };
}

const vnd = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('vi-VN')} ₫`);
const when = (iso: string) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—');

const field = 'px-2.5 py-1.5 bg-stone-900 border border-stone-700 rounded-lg text-xs text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 min-w-0';
const btn = 'px-3 py-1.5 rounded-lg text-xs font-semibold border border-stone-700 text-stone-200 hover:bg-stone-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-50 disabled:cursor-not-allowed';
const btnPrimary = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-400 hover:bg-amber-300 text-stone-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-50 disabled:cursor-not-allowed';

const ACTION_COPY: Record<ResolveAction, { title: string; body: string; confirm: string; done: string }> = {
  activate: {
    title: 'Activate this order?',
    body: 'The order is marked paid now and the member’s plan is granted or extended exactly like a normal payment. A receipt email is sent.',
    confirm: 'Activate plan',
    done: 'activated',
  },
  dismiss: {
    title: 'Dismiss this order?',
    body: 'The order is closed without granting access. Refunds are NOT automatic; handle any transfer back manually.',
    confirm: 'Dismiss order',
    done: 'dismissed',
  },
};

interface Pending {
  code: string;
  action: ResolveAction;
}

/** Studio admin queue of payments flagged `needs_attention`, with Activate / Dismiss for SePay orders. */
export function BillingAttentionPanel() {
  const [orders, setOrders] = useState<AttentionOrder[]>([]);
  const [cards, setCards] = useState<AttentionCard[]>([]);
  const [cardNote, setCardNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const ordersHeadingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api('/api/v1/admin/billing/attention');
    setLoading(false);
    if (!r.ok) { setMessage({ kind: 'error', text: r.message }); return; }
    setOrders((Array.isArray(r.data.orders) ? r.data.orders.filter(isRecord) : []).map(toOrder));
    setCards((Array.isArray(r.data.card_subscriptions) ? r.data.card_subscriptions.filter(isRecord) : []).map(toCard));
    setCardNote(s(r.data, 'card_note'));
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    if (!pending && dialog.open) dialog.close();
  }, [pending]);

  const ask = (code: string, action: ResolveAction, trigger: HTMLElement) => {
    returnFocusRef.current = trigger;
    setPending({ code, action });
  };

  const closeDialog = () => {
    setPending(null);
    returnFocusRef.current?.focus();
  };

  const confirm = async () => {
    if (!pending) return;
    const { code, action } = pending;
    setPending(null);
    setBusyCode(code); // disable the row's buttons immediately; re-enabled only if the request fails
    setMessage(null);
    const note = notes[code]?.trim();
    const r = await api(`/api/v1/admin/billing/orders/${encodeURIComponent(code)}/resolve`, {
      method: 'POST',
      body: JSON.stringify(note ? { action, note } : { action }),
    });
    setBusyCode(null);
    if (!r.ok) {
      setMessage({ kind: 'error', text: `${code}: ${r.message}` });
      returnFocusRef.current?.focus();
      return;
    }
    const outcome = s(r.data, 'outcome');
    const already = outcome.startsWith('already_');
    setMessage({ kind: 'ok', text: `${code} ${already ? `was already ${ACTION_COPY[action].done}` : ACTION_COPY[action].done}.` });
    setOrders(list => list.filter(o => o.code !== code));
    // The row (and its button) is gone: move focus to the list heading instead of losing it.
    ordersHeadingRef.current?.focus();
  };

  const copy = pending ? ACTION_COPY[pending.action] : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-stone-800">
        <div>
          <h2 className="text-lg font-bold text-white font-serif">Payments needing attention</h2>
          <p className="text-xs text-stone-400">Late, short or repeated SePay transfers and card subscriptions the webhooks could not settle.</p>
        </div>
        <button type="button" className={btn} onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      <div aria-live="polite" role="status">
        {message && (
          <p className={`text-xs rounded-lg px-3 py-2 border ${message.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>{message.text}</p>
        )}
      </div>

      <section aria-labelledby="attention-orders" className="bg-stone-900/60 border border-stone-800 rounded-2xl p-4 sm:p-6 space-y-4">
        <h3 id="attention-orders" ref={ordersHeadingRef} tabIndex={-1} className="font-bold text-white text-sm focus:outline-none">Bank transfer orders (SePay) · {orders.length}</h3>
        {!loading && orders.length === 0 && <p className="text-xs text-stone-400">Nothing to review.</p>}
        <ul className="space-y-3">
          {orders.map(o => {
            const busy = busyCode === o.code;
            const noteId = `attention-note-${o.code}`;
            return (
              <li key={o.code} className="border border-stone-800 rounded-xl p-3 space-y-2 text-xs text-stone-300" aria-busy={busy}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full border font-mono text-[10px] bg-rose-500/20 text-rose-300 border-rose-500/40">{o.attention_reason || 'needs_attention'}</span>
                  <span className="font-mono text-stone-400">{o.code}</span>
                  <span className="text-white font-semibold break-all">{o.member_email || 'unknown member'}</span>
                </div>
                <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1">
                  <div><dt className="inline text-stone-500">Plan: </dt><dd className="inline">{o.plan_name} × {o.months} mo</dd></div>
                  <div><dt className="inline text-stone-500">Expected: </dt><dd className="inline">{vnd(o.amount_vnd)}</dd></div>
                  <div><dt className="inline text-stone-500">Received: </dt><dd className={`inline ${o.amount_paid !== null && o.amount_paid < o.amount_vnd ? 'text-amber-300' : ''}`}>{vnd(o.amount_paid)}</dd></div>
                  <div><dt className="inline text-stone-500">Ref: </dt><dd className="inline font-mono break-all">{o.payment_ref || '—'}</dd></div>
                  <div><dt className="inline text-stone-500">Created: </dt><dd className="inline">{when(o.created_at)}</dd></div>
                  <div><dt className="inline text-stone-500">Flagged: </dt><dd className="inline">{when(o.updated_at)}</dd></div>
                </dl>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <label htmlFor={noteId} className="sr-only">Admin note for {o.code}</label>
                  <input
                    id={noteId}
                    placeholder="Note for the audit log (optional)"
                    maxLength={500}
                    className={`${field} flex-1`}
                    value={notes[o.code] ?? ''}
                    disabled={busy}
                    onChange={e => setNotes({ ...notes, [o.code]: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <button type="button" className={btnPrimary} disabled={busy} onClick={e => ask(o.code, 'activate', e.currentTarget)}>
                      {busy ? 'Working…' : 'Activate'}
                    </button>
                    <button type="button" className={`${btn} text-rose-300 border-rose-500/40`} disabled={busy} onClick={e => ask(o.code, 'dismiss', e.currentTarget)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="attention-cards" className="bg-stone-900/60 border border-stone-800 rounded-2xl p-4 sm:p-6 space-y-4">
        <h3 id="attention-cards" className="font-bold text-white text-sm">Card subscriptions (Dodo) · {cards.length}</h3>
        {cardNote && <p className="text-[11px] text-stone-400">{cardNote}</p>}
        {!loading && cards.length === 0 && <p className="text-xs text-stone-400">Nothing to review.</p>}
        <ul className="space-y-3">
          {cards.map(c => (
            <li key={c.id} className="border border-stone-800 rounded-xl p-3 space-y-1 text-xs text-stone-300">
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2 py-0.5 rounded-full border font-mono text-[10px] bg-rose-500/20 text-rose-300 border-rose-500/40">{c.attention_reason || 'needs_attention'}</span>
                <span className="text-white font-semibold break-all">{c.member_email || 'unknown customer'}</span>
              </div>
              <p className="break-words">
                {c.plan_name || 'unknown plan'} · {c.amount_cents === null ? '—' : `${(c.amount_cents / 100).toFixed(2)} ${c.currency}`}
                {' · '}<span className="font-mono">{c.provider_subscription_id || c.id}</span>
                {' · '}flagged {when(c.updated_at)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <dialog
        ref={dialogRef}
        aria-labelledby="attention-dialog-title"
        aria-describedby="attention-dialog-body"
        onCancel={e => { e.preventDefault(); closeDialog(); }}
        className="w-[min(92vw,28rem)] rounded-2xl border border-stone-700 bg-stone-950 p-5 text-stone-100 backdrop:bg-black/70"
      >
        {pending && copy && (
          <div className="space-y-4">
            <h3 id="attention-dialog-title" className="text-base font-bold text-white">{copy.title}</h3>
            <p id="attention-dialog-body" className="text-xs text-stone-300">
              <span className="font-mono text-stone-400">{pending.code}</span> — {copy.body}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btn} onClick={closeDialog} autoFocus>Cancel</button>
              <button
                type="button"
                className={pending.action === 'activate' ? btnPrimary : `${btn} text-rose-300 border-rose-500/40`}
                onClick={() => void confirm()}
              >
                {copy.confirm}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
