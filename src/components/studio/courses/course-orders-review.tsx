import { useCallback, useEffect, useState } from 'react';
import type { CourseOrderStatus } from '../../../lib/courses/course-orders';
import { StatusLine, api, btnCls, dangerCls, formatTime, inputCls, isObj, num, objArr, primaryCls, str, strOrNull } from '../knowledge-studio-kit';
import type { Obj, StatusMsg } from '../knowledge-studio-kit';
import { errText, usd } from './courses-admin-api';

const STATUSES: CourseOrderStatus[] = ['needs_attention', 'pending', 'paid', 'expired', 'refunded', 'charged_back', 'cancelled'];
type Action = 'grant' | 'dismiss' | 'refund';

const CONFIRM: Record<Action, string> = {
  grant: 'Mark this order paid and give the buyer access to the course?',
  dismiss: 'Dismiss this order (cancelled, no access)?',
  refund: 'Record a manual refund? This revokes course access, GitHub access and any referral commission. Send the money back yourself in SePay/Dodo.',
};

interface OrderRow {
  code: string; provider: string; status: string; course_title: string; user_id: string; user_email: string | null; list_usd_cents: number; amount_usd_cents: number;
  applied_pct: number; amount_vnd: number | null; amount_paid: number | null; currency_paid: string | null; attention_reason: string | null;
  created_at: string; paid_at: string | null;
}

function toRow(o: Obj): OrderRow {
  return {
    code: str(o, 'code'), provider: str(o, 'provider'), status: str(o, 'status'), course_title: isObj(o.course) ? str(o.course, 'title') : '(deleted course)',
    user_id: str(o, 'user_id'), user_email: typeof o.user_email === 'string' ? o.user_email : null, list_usd_cents: num(o, 'list_usd_cents'), amount_usd_cents: num(o, 'amount_usd_cents'), applied_pct: num(o, 'applied_pct'),
    amount_vnd: typeof o.amount_vnd === 'number' ? o.amount_vnd : null, amount_paid: typeof o.amount_paid === 'number' ? o.amount_paid : null,
    currency_paid: strOrNull(o, 'currency_paid'), attention_reason: strOrNull(o, 'attention_reason'), created_at: str(o, 'created_at'), paid_at: strOrNull(o, 'paid_at'),
  };
}

function OrderCard({ order, busy, onResolve }: { order: OrderRow; busy: boolean; onResolve: (action: Action, reason: string) => void }) {
  const [reason, setReason] = useState('');
  const canGrant = order.status !== 'paid';
  const canDismiss = order.status !== 'paid' && order.status !== 'cancelled';
  const canRefund = order.status === 'paid' || order.status === 'needs_attention';
  const go = (a: Action) => { if (window.confirm(`${order.code}: ${CONFIRM[a]}`)) onResolve(a, reason.trim()); };
  return (
    <li className="rounded-xl border border-stone-800 bg-stone-950/60 p-3 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono font-bold text-white">{order.code}</span>
        <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-stone-800 text-stone-300">{order.provider}</span>
        <span className={`px-1.5 py-0.5 rounded-md text-[10px] ${order.status === 'needs_attention' ? 'bg-amber-400/15 text-amber-300' : 'bg-stone-800 text-stone-300'}`}>{order.status}</span>
        <span className="text-stone-200">{order.course_title}</span>
        <span className="ml-auto text-stone-500">{formatTime(order.created_at)}</span>
      </div>
      <p className="text-[11px] text-stone-400">
        {usd(order.amount_usd_cents)}{order.applied_pct ? ` (list ${usd(order.list_usd_cents)}, −${order.applied_pct}%)` : ''}
        {order.amount_vnd !== null && ` · ${order.amount_vnd.toLocaleString('vi-VN')} ₫`}
        {order.amount_paid !== null && ` · paid ${order.amount_paid.toLocaleString('vi-VN')} ${order.currency_paid ?? ''}`}
        {order.paid_at && ` · at ${formatTime(order.paid_at)}`} · {order.user_email ?? <span className="font-mono">{order.user_id}</span>}
      </p>
      {order.attention_reason && <p className="text-[11px] text-amber-200">Reason: {order.attention_reason}</p>}
      {(canGrant || canDismiss || canRefund) && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <input className={`${inputCls} flex-1`} value={reason} onChange={e => setReason(e.target.value)} placeholder="Note / reason (stored on the order)" aria-label={`Reason for ${order.code}`} />
          {canGrant && <button type="button" className={btnCls} disabled={busy} onClick={() => go('grant')}>Grant</button>}
          {canDismiss && <button type="button" className={btnCls} disabled={busy} onClick={() => go('dismiss')}>Dismiss</button>}
          {canRefund && <button type="button" className={dangerCls} disabled={busy} onClick={() => go('refund')}>Refund</button>}
        </div>
      )}
    </li>
  );
}

/** Course orders, filtered by status (the review queue is `needs_attention`), with grant/dismiss/refund. */
export function CourseOrdersReview() {
  const [filter, setFilter] = useState<CourseOrderStatus | ''>('needs_attention');
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);

  const load = useCallback(async () => {
    setOrders(null);
    const r = await api(`/api/v1/admin/course-orders${filter ? `?status=${filter}` : ''}`);
    if (!r.ok) { setStatus({ text: errText(r), error: true }); setOrders([]); return; }
    setOrders(objArr(r.data).map(toRow));
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const resolve = async (code: string, action: Action, reason: string) => {
    setBusy(true);
    setStatus(null);
    const r = await api(`/api/v1/admin/course-orders/${encodeURIComponent(code)}/resolve`, { method: 'POST', body: { action, reason: reason || undefined } });
    setStatus(r.ok ? { text: `${code}: ${action} done.`, error: false } : { text: errText(r), error: true });
    if (r.ok) await load();
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputCls} w-auto`} value={filter} aria-label="Order status filter"
          onChange={e => setFilter(STATUSES.find(s => s === e.target.value) ?? '')}>
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button type="button" className={primaryCls} onClick={() => void load()} disabled={busy}>Refresh</button>
        <StatusLine status={status} />
      </div>
      {orders === null ? <p className="text-xs text-stone-400">Loading…</p> : orders.length === 0 ? <p className="text-xs text-stone-500">No orders.</p> : (
        <ul className="space-y-2">
          {orders.map(o => <OrderCard key={`${o.code}:${o.status}`} order={o} busy={busy} onResolve={(a, reason) => void resolve(o.code, a, reason)} />)}
        </ul>
      )}
    </div>
  );
}
