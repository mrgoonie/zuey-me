import type { ReactNode } from 'react';
import { alertError, alertOk, card } from '../members/member-ui';

/** Light card section of the Referral app (same surface as the Account app sections). */
export function ReferralSection({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} className={`${card} scroll-mt-6`} aria-labelledby={`${id}-title`}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${id}-title`} className="text-xl sm:text-2xl font-bold font-serif">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Polite live region for a form's last outcome. */
export function ReferralNotice({ ok, error }: { ok: string | null; error: string | null }) {
  return (
    <div role="status" aria-live="polite" className="empty:hidden">
      {error && <p className={alertError}>{error}</p>}
      {ok && <p className={alertOk}>{ok}</p>}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  wait: 'bg-amber-100 text-amber-900 border-amber-200',
  bad: 'bg-rose-100 text-rose-900 border-rose-200',
  mute: 'bg-stone-200 text-stone-700 border-stone-300',
};

/** Status pill; `tone` picks the colour, the label carries the meaning. */
export function ReferralBadge({ tone, children }: { tone: 'ok' | 'wait' | 'bad' | 'mute'; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${BADGE_TONES[tone]}`}>{children}</span>;
}

/** Badge tone of a commission, payout or payout-profile status. */
export function statusTone(status: string): 'ok' | 'wait' | 'bad' | 'mute' {
  if (status === 'approved' || status === 'paid' || status === 'verified') return 'ok';
  if (status === 'pending' || status === 'review' || status === 'submitted' || status === 'draft') return 'wait';
  if (status === 'reversed' || status === 'blocked' || status === 'rejected') return 'bad';
  return 'mute';
}
