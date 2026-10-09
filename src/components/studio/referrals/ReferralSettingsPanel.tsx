import { useCallback, useEffect, useState } from 'react';
import { Flash, adminApi, btn, btnPrimary, field, list, n, panel, s, when, type FlashMessage } from './referral-admin-kit';

interface TierRow { min: string; rate: string }

const SCALARS = [
  ['hold_days', 'Hold (days)', 'Commission hold before approval (booking: after the slot ends).'],
  ['booking_rate', 'Booking rate (%)', 'Total % of a consultation shared in the referrer’s d/R ratio.'],
  ['payout_threshold_cents', 'Payout threshold (cents)', 'Minimum balance paid at the day-1 close (5000 = $50).'],
  ['vn_deduction_bp', 'VN bank deduction (bp)', '“Thuế TNCN”: 1000 bp = 10%.'],
  ['paypal_deduction_bp', 'PayPal deduction (bp)', '“Phí xử lý & thuế”: 1800 bp = 18%.'],
  ['cookie_days', 'Link cookie (days)', 'How long a /r/ visit stays attributable before sign-up.'],
] as const;

type ScalarKey = (typeof SCALARS)[number][0];

/** Program settings: the tier table (90-day successes → rate) and the scalar knobs, saved as one PATCH. */
export function ReferralSettingsPanel() {
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [values, setValues] = useState<Record<ScalarKey, string>>({ hold_days: '', booking_rate: '', payout_threshold_cents: '', vn_deduction_bp: '', paypal_deduction_bp: '', cookie_days: '' });
  const [updatedAt, setUpdatedAt] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<FlashMessage>(null);

  const apply = (d: Record<string, unknown>) => {
    setTiers(list(d.tiers).map(t => ({ min: String(n(t, 'min')), rate: String(n(t, 'rate')) })));
    setValues({
      hold_days: String(n(d, 'hold_days')), booking_rate: String(n(d, 'booking_rate')), payout_threshold_cents: String(n(d, 'payout_threshold_cents')),
      vn_deduction_bp: String(n(d, 'vn_deduction_bp')), paypal_deduction_bp: String(n(d, 'paypal_deduction_bp')), cookie_days: String(n(d, 'cookie_days')),
    });
    setUpdatedAt(s(d, 'updated_at'));
  };

  const load = useCallback(async () => {
    setBusy(true);
    const r = await adminApi('/api/v1/admin/referrals/settings');
    setBusy(false);
    if (r.ok) apply(r.data); else setMessage({ kind: 'error', text: r.message });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const toInt = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));
    const body: Record<string, unknown> = { tiers: tiers.map(t => ({ min: toInt(t.min), rate: toInt(t.rate) })) };
    for (const [key] of SCALARS) body[key] = toInt(values[key]);
    if (Object.values(body).some(v => typeof v === 'number' && !Number.isInteger(v)) || tiers.some(t => !Number.isInteger(toInt(t.min)) || !Number.isInteger(toInt(t.rate)))) {
      setMessage({ kind: 'error', text: 'Every value must be a whole number.' });
      return;
    }
    setBusy(true); setMessage(null);
    const r = await adminApi('/api/v1/admin/referrals/settings', { method: 'PATCH', body });
    setBusy(false);
    if (r.ok) { apply(r.data); setMessage({ kind: 'ok', text: 'Settings saved.' }); } else setMessage({ kind: 'error', text: r.message });
  };

  const setTier = (i: number, key: keyof TierRow, v: string) => setTiers(tiers.map((t, j) => (j === i ? { ...t, [key]: v } : t)));

  return (
    <section aria-labelledby="ref-settings" className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="ref-settings" className="font-bold text-white text-sm">Program settings</h3>
        <span className="text-[11px] text-stone-500">Updated {when(updatedAt || null)}</span>
      </div>
      <Flash message={message} />
      <div>
        <h4 className="text-xs font-semibold text-stone-300 mb-2">Tiers (successful referrals in 90 days → rate %, max 50; first row starts at 0)</h4>
        <table className="w-full text-xs text-stone-300">
          <thead><tr className="text-left text-stone-500"><th className="font-medium pb-1">Min referrals</th><th className="font-medium pb-1">Rate %</th><th className="sr-only">Remove</th></tr></thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i}>
                <td className="pr-2 pb-1.5"><input aria-label={`Tier ${i + 1} minimum`} className={`${field} w-24`} inputMode="numeric" value={t.min} disabled={busy || i === 0} onChange={e => setTier(i, 'min', e.target.value)} /></td>
                <td className="pr-2 pb-1.5"><input aria-label={`Tier ${i + 1} rate`} className={`${field} w-20`} inputMode="numeric" value={t.rate} disabled={busy} onChange={e => setTier(i, 'rate', e.target.value)} /></td>
                <td className="pb-1.5 text-right">{i > 0 && <button type="button" className={btn} disabled={busy} onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className={`${btn} mt-1`} disabled={busy || tiers.length >= 20} onClick={() => setTiers([...tiers, { min: '', rate: '' }])}>Add tier</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SCALARS.map(([key, label, hint]) => (
          <label key={key} className="grid gap-1 text-xs text-stone-300">
            <span className="font-semibold">{label}</span>
            <input className={field} inputMode="numeric" value={values[key]} disabled={busy} onChange={e => setValues({ ...values, [key]: e.target.value })} />
            <span className="text-[11px] text-stone-500">{hint}</span>
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>{busy ? 'Working…' : 'Save settings'}</button>
        <button type="button" className={btn} disabled={busy} onClick={() => void load()}>Reload</button>
      </div>
    </section>
  );
}
