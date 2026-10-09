import type { Locale } from '../../lib/i18n/locales';
import { fmtVnd } from '../members/member-ui';
import { fmtBp, fmtCents, type ReferralMe } from './referral-api';
import { fill, fmtDay, type ReferralStrings } from './referral-i18n';
import { ReferralBadge, ReferralSection, statusTone } from './referral-section';

interface Props {
  me: ReferralMe;
  t: ReferralStrings;
  locale: Locale;
}

/** Balances (held, approved, being paid, paid), the latest commissions and payout history. */
export function ReferralEarnings({ me, t, locale }: Props) {
  const b = me.balance;
  const tiles: [string, number][] = [
    [t.balance.pending, b.pending_cents],
    [t.balance.approved, b.approved_cents],
    [t.balance.processing, b.processing_cents],
    [t.balance.paid, b.paid_cents],
  ];

  return (
    <ReferralSection id="referral-earnings" title={t.balance.title}>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tiles.map(([label, cents]) => (
          <div key={label} className="rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">{label}</dt>
            <dd className={`mt-0.5 text-lg font-bold tabular-nums ${cents < 0 ? 'text-rose-700' : ''}`}>{fmtCents(cents)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-stone-600">
        {fill(t.balance.note, { date: fmtDay(me.next_close_date, locale), min: fmtCents(me.program.payout_threshold_cents), days: me.program.hold_days })}
      </p>

      <h4 className="mt-6 text-sm font-semibold">{t.commissions.title}</h4>
      {me.commissions.length === 0 ? (
        <p className="mt-2 text-sm text-stone-600">{t.commissions.empty}</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {me.commissions.map(c => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 text-sm min-w-0">
              <span className="min-w-0">
                <span className="block font-medium break-all">{c.referee ?? '—'}</span>
                <span className="block text-xs text-stone-600">
                  {t.kinds[c.source_kind] ?? c.source_kind} · {fmtDay(c.paid_at, locale)}
                  {c.status === 'pending' && ` · ${fill(t.commissions.holdUntil, { date: fmtDay(c.hold_until, locale) })}`}
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-right tabular-nums">
                  <span className="block font-semibold">{fmtCents(c.commission_cents)}</span>
                  <span className="block text-[11px] text-stone-500">{c.commission_percent}% × {fmtCents(c.base_amount_cents)}</span>
                </span>
                <ReferralBadge tone={statusTone(c.status)}>{t.statuses[c.status] ?? c.status}</ReferralBadge>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-6 text-sm font-semibold">{t.payouts.title}</h4>
      {me.payouts.length === 0 ? (
        <p className="mt-2 text-sm text-stone-600">{t.payouts.empty}</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {me.payouts.map(p => (
            <li key={p.id} className="rounded-xl border border-stone-300 bg-white/70 px-3 py-2 text-sm min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold tabular-nums">{p.period} · {t.profile.methods[p.method === 'paypal' ? 'paypal' : 'vn_bank']}</span>
                <ReferralBadge tone={statusTone(p.status)}>{t.payouts.statuses[p.status] ?? p.status}</ReferralBadge>
              </div>
              <p className="mt-1 text-xs text-stone-700 tabular-nums break-words">
                {t.payouts.gross} {fmtCents(p.gross_cents)} · {t.payouts.deduction} {fmtBp(p.deduction_bp)} ({fmtCents(-p.deduction_cents)}) ·{' '}
                <strong>{t.payouts.net} {fmtCents(p.net_cents)}</strong>{p.net_vnd !== null && p.method === 'vn_bank' && ` ≈ ${fmtVnd(p.net_vnd)}`}
                {p.transaction_ref && <> · {t.payouts.ref} <span className="font-mono">{p.transaction_ref}</span></>}
                {p.paid_at && ` · ${fmtDay(p.paid_at, locale)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </ReferralSection>
  );
}
