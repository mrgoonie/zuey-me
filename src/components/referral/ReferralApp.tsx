import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { alertError, alertInfo, btnGhost, btnPrimary, callApi, card, loginUrl } from '../members/member-ui';
import { parseReferralMe, type ReferralMe } from './referral-api';
import { referralStrings, type ReferralStrings } from './referral-i18n';
import { ReferralEarnings } from './ReferralEarnings';
import { ReferralLeaderboard } from './ReferralLeaderboard';
import { ReferralPayoutProfileForm } from './ReferralPayoutProfileForm';
import { ReferralSplitCard } from './ReferralSplitCard';
import { ReferralTierShareCard } from './ReferralTierShareCard';

type Tab = 'program' | 'payout' | 'leaderboard';
const TABS: Tab[] = ['program', 'payout', 'leaderboard'];

type View =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; me: ReferralMe };

/** Where sign-in should bring the member back: the OS window on the home page, otherwise /referral. */
function returnPath(): string {
  return typeof window !== 'undefined' && window.location.pathname === '/' ? '/#referral' : '/referral';
}

/** A member who earned money keeps the earnings and payout views even after their plan lapsed. */
function hasHistory(me: ReferralMe): boolean {
  const b = me.balance;
  return me.code !== null && (me.commissions.length > 0 || me.payouts.length > 0 || b.pending_cents !== 0 || b.approved_cents !== 0 || b.processing_cents !== 0);
}

function SignedOut({ t }: { t: ReferralStrings }) {
  return (
    <section className={card} aria-labelledby="referral-signin-title">
      <h3 id="referral-signin-title" className="text-xl sm:text-2xl font-bold font-serif">{t.signedOut.title}</h3>
      <ol className="mt-3 grid gap-2 text-sm text-stone-800 list-decimal pl-5">
        {t.signedOut.steps.map(step => <li key={step}>{step}</li>)}
      </ol>
      <p className="mt-5"><a className={btnPrimary} href={loginUrl(returnPath())}>{t.signedOut.cta}</a></p>
    </section>
  );
}

function NotEligible({ t }: { t: ReferralStrings }) {
  return (
    <section className={card} aria-labelledby="referral-ineligible-title">
      <h3 id="referral-ineligible-title" className="text-xl sm:text-2xl font-bold font-serif">{t.notEligible.title}</h3>
      <p className="mt-2 text-sm text-stone-700">{t.notEligible.body}</p>
      <p className="mt-5"><a className={btnPrimary} href="/pricing">{t.notEligible.cta}</a></p>
    </section>
  );
}

/**
 * Zuey OS Referral app (also /referral): personal link, tier progress, the referrer's discount split, earnings,
 * payout details and the public monthly leaderboard. All numbers come from the server; nothing is computed
 * here that the server does not also enforce.
 */
export function ReferralApp({ locale, signedIn }: { locale: Locale; signedIn: boolean }) {
  const t = referralStrings(locale);
  const [tab, setTab] = useState<Tab>('program');
  const [view, setView] = useState<View>(signedIn ? { kind: 'loading' } : { kind: 'signedOut' });

  const load = useCallback(async () => {
    if (!signedIn) return;
    setView({ kind: 'loading' });
    const res = await callApi('/api/v1/referrals/me', { cache: 'no-store' });
    const me = res.ok ? parseReferralMe(res.data) : null;
    if (me) setView({ kind: 'ready', me });
    else if (!res.ok && res.status === 401) setView({ kind: 'signedOut' });
    else setView({ kind: 'error', message: res.ok ? t.loadFailed : res.message });
  }, [signedIn, t.loadFailed]);

  useEffect(() => { void load(); }, [load]);

  const onMe = (me: ReferralMe) => setView({ kind: 'ready', me });
  const me = view.kind === 'ready' ? view.me : null;
  const canRefer = me !== null && me.eligible && me.code !== null;
  const showMoney = me !== null && (canRefer || hasHistory(me));

  const memberGate = (content: ReactNode) => {
    if (view.kind === 'signedOut') return <SignedOut t={t} />;
    if (view.kind === 'loading') return <p className={`${card} text-sm text-stone-600`} role="status">{t.loading}</p>;
    if (view.kind === 'error') {
      return (
        <div className={`${card} grid gap-3`}>
          <p className={alertError}>{t.loadFailed} {view.message}</p>
          <p><button type="button" className={btnGhost} onClick={() => void load()}>{t.retry}</button></p>
        </div>
      );
    }
    return content;
  };

  return (
    <div className="grid gap-4 min-w-0">
      <header className="text-center text-stone-100">
        <h2 className="text-2xl sm:text-3xl font-bold font-serif">{t.title}</h2>
        <p className="mt-1 text-sm text-stone-300">{t.intro}</p>
      </header>

      <nav aria-label={t.title} className="mx-auto w-full max-w-[520px] grid grid-cols-3 gap-1 rounded-full bg-[#F5EFEB] p-1 border border-stone-200/90">
        {TABS.map(id => (
          <button
            key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}
            className={`rounded-full px-1 py-2 text-center text-xs sm:text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${tab === id ? 'bg-stone-900 text-amber-50' : 'text-stone-700 hover:bg-white/70'}`}
          >
            {t.tabs[id]}
          </button>
        ))}
      </nav>

      {me?.locked && <p className={alertInfo}>{t.locked}</p>}

      {tab === 'program' && memberGate(me && (
        <>
          {canRefer ? (
            <>
              <ReferralTierShareCard me={me} t={t} locale={locale} />
              <ReferralSplitCard me={me} t={t} onSaved={onMe} />
            </>
          ) : <NotEligible t={t} />}
          {showMoney && <ReferralEarnings me={me} t={t} locale={locale} />}
        </>
      ))}

      {tab === 'payout' && memberGate(me && (showMoney ? <ReferralPayoutProfileForm program={me.program} t={t} /> : <NotEligible t={t} />))}

      {tab === 'leaderboard' && <ReferralLeaderboard t={t} />}
    </div>
  );
}

export default ReferralApp;
