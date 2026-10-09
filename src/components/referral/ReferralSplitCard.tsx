import { useEffect, useId, useState } from 'react';
import { bookingSplit } from '../../lib/referrals/rates';
import { btnPrimary, callApi, jsonBody } from '../members/member-ui';
import { parseReferralMe, type ReferralMe } from './referral-api';
import { fill, type ReferralStrings } from './referral-i18n';
import { ReferralNotice, ReferralSection } from './referral-section';

interface Props {
  me: ReferralMe;
  t: ReferralStrings;
  onSaved: (me: ReferralMe) => void;
}

/**
 * The referrer's split of R: discount d (0..R) for friends, R − d commission. The booking preview uses the
 * same pure split the server applies (booking rate shared in the d/R ratio). Also the leaderboard opt-out.
 */
export function ReferralSplitCard({ me, t, onSaved }: Props) {
  const [discount, setDiscount] = useState(me.membership_split.discount);
  const [busy, setBusy] = useState<'split' | 'optout' | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sliderId = useId();
  const optOutId = useId();
  useEffect(() => setDiscount(me.membership_split.discount), [me.membership_split.discount]);

  const r = me.rate;
  const booking = bookingSplit(discount, r, me.program.booking_rate);
  const dirty = discount !== me.discount_percent;

  async function patch(body: Record<string, unknown>, kind: 'split' | 'optout', done: string) {
    setBusy(kind); setOk(null); setError(null);
    const res = await callApi('/api/v1/referrals/me', { method: 'PATCH', body: jsonBody(body) });
    setBusy(null);
    const next = res.ok ? parseReferralMe(res.data) : null;
    if (next) { onSaved(next); setOk(done); } else setError(res.ok ? t.loadFailed : res.message);
  }

  return (
    <ReferralSection id="referral-split" title={fill(t.split.title, { rate: r })}>
      <label htmlFor={sliderId} className="block text-base font-semibold tabular-nums">
        {fill(t.split.label, { mine: r - discount, theirs: discount })}
      </label>
      <input
        id={sliderId} type="range" min={0} max={r} step={1} value={discount} disabled={r === 0 || busy !== null}
        onChange={e => setDiscount(Number(e.target.value))}
        aria-valuetext={fill(t.split.label, { mine: r - discount, theirs: discount })}
        className="mt-3 w-full accent-stone-900"
      />
      <div className="flex justify-between text-[11px] text-stone-500 tabular-nums" aria-hidden="true"><span>0%</span><span>{r}%</span></div>
      <p className="mt-2 text-xs text-stone-600">{t.split.hint}</p>
      <p className="mt-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 text-xs text-stone-800 tabular-nums">
        {fill(t.split.booking, { total: me.program.booking_rate, theirs: booking.discountPercent, mine: booking.commissionPercent })}
      </p>
      <p className="mt-4">
        <button type="button" className={btnPrimary} disabled={!dirty || busy !== null} onClick={() => void patch({ discount_percent: discount }, 'split', t.split.saved)}>
          {busy === 'split' ? t.split.saving : t.split.save}
        </button>
      </p>

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-stone-300 bg-white/70 px-3 py-2.5">
        <input
          id={optOutId} type="checkbox" role="switch" className="mt-0.5 h-4 w-4 accent-stone-900"
          checked={me.leaderboard_opt_out} disabled={busy !== null}
          onChange={e => void patch({ leaderboard_opt_out: e.target.checked }, 'optout', t.optOut.saved)}
        />
        <label htmlFor={optOutId} className="text-sm">{t.optOut.label}</label>
      </div>
      <div className="mt-3"><ReferralNotice ok={ok} error={error} /></div>
    </ReferralSection>
  );
}
