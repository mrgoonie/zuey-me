import { useCallback, useEffect, useId, useState } from 'react';
import { alertError, btnGhost, btnPrimary, callApi, input, jsonBody, type SubmitLike } from '../members/member-ui';
import { fmtBp, parsePayoutProfile, type PayoutProfile, type ReferralProgram } from './referral-api';
import { fill, type ReferralStrings } from './referral-i18n';
import { ReferralIdImageUpload } from './ReferralIdImageUpload';
import { ReferralBadge, ReferralNotice, ReferralSection, statusTone } from './referral-section';

type Method = 'vn_bank' | 'paypal';
type Fields = Pick<PayoutProfile, 'full_name' | 'bank_name' | 'bank_account' | 'national_id' | 'address' | 'paypal_email'>;

const EMPTY: Fields = { full_name: '', bank_name: '', bank_account: '', national_id: '', address: '', paypal_email: '' };

function fieldsOf(p: PayoutProfile | null): Fields {
  return p ? { full_name: p.full_name, bank_name: p.bank_name, bank_account: p.bank_account, national_id: p.national_id, address: p.address, paypal_email: p.paypal_email } : EMPTY;
}

/**
 * Payout details: Vietnamese bank (with both national-ID images, reviewed by Zuey) or PayPal. Deduction
 * labels come from the program settings. Saving is browser-session only on the server.
 */
export function ReferralPayoutProfileForm({ program, t }: { program: ReferralProgram; t: ReferralStrings }) {
  const [profile, setProfile] = useState<PayoutProfile | null>(null);
  const [loaded, setLoaded] = useState<'loading' | 'ready' | 'error'>('loading');
  const [method, setMethod] = useState<Method>('vn_bank');
  const [form, setForm] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();

  const apply = (p: PayoutProfile | null) => {
    setProfile(p);
    setForm(fieldsOf(p));
    if (p) setMethod(p.method);
  };

  const load = useCallback(async () => {
    setLoaded('loading');
    const res = await callApi('/api/v1/referrals/payout-profile', { cache: 'no-store' });
    if (!res.ok) { setLoaded('error'); setError(res.message); return; }
    apply(parsePayoutProfile(res.data));
    setLoaded('ready');
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(e: SubmitLike) {
    e.preventDefault();
    setBusy(true); setOk(null); setError(null);
    const body = method === 'paypal'
      ? { method, paypal_email: form.paypal_email.trim() }
      : { method, full_name: form.full_name.trim(), bank_name: form.bank_name.trim(), bank_account: form.bank_account.replace(/\s+/g, ''), national_id: form.national_id.replace(/\s+/g, ''), address: form.address.trim() };
    const res = await callApi('/api/v1/referrals/payout-profile', { method: 'PUT', body: jsonBody(body) });
    setBusy(false);
    const next = res.ok ? parsePayoutProfile(res.data) : null;
    if (next) { apply(next); setOk(t.profile.saved); } else setError(res.ok ? t.loadFailed : res.code === 'session_required' ? t.profile.sessionOnly : res.message);
  }

  const status = profile?.status ?? 'none';
  const deduction = method === 'paypal'
    ? fill(t.profile.deductionPaypal, { pct: fmtBp(program.paypal_deduction_bp) })
    : fill(t.profile.deductionVn, { pct: fmtBp(program.vn_deduction_bp) });
  const vnSaved = profile?.method === 'vn_bank';
  const text = (key: keyof Fields, label: string, extra: { maxLength: number; inputMode?: 'numeric' | 'email'; autoComplete?: string; type?: string }) => (
    <label className="grid gap-1 text-sm font-medium" htmlFor={`${baseId}-${key}`}>{label}
      <input
        id={`${baseId}-${key}`} className={input} required value={form[key]} disabled={busy}
        maxLength={extra.maxLength} inputMode={extra.inputMode} autoComplete={extra.autoComplete} type={extra.type ?? 'text'}
        onChange={e => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <ReferralSection id="referral-payout" title={t.profile.title} aside={<ReferralBadge tone={statusTone(status)}>{t.profile.statuses[status] ?? status}</ReferralBadge>}>
      <p className="text-sm text-stone-700">{t.profile.intro}</p>
      {profile?.status === 'rejected' && profile.reject_reason && <p className={`mt-3 ${alertError}`}>{fill(t.profile.rejected, { reason: profile.reject_reason })}</p>}
      {loaded === 'loading' && <p className="mt-3 text-sm text-stone-600" role="status">{t.loading}</p>}
      {loaded === 'error' && <p className="mt-3"><button type="button" className={btnGhost} onClick={() => void load()}>{t.retry}</button></p>}

      {loaded === 'ready' && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-1 rounded-full bg-white/70 p-1 border border-stone-300" role="radiogroup" aria-label={t.profile.title}>
            {(['vn_bank', 'paypal'] as const).map(m => (
              <button
                key={m} type="button" role="radio" aria-checked={method === m} onClick={() => { setMethod(m); setOk(null); setError(null); }}
                className={`rounded-full px-2 py-2 text-xs sm:text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${method === m ? 'bg-stone-900 text-amber-50' : 'text-stone-700 hover:bg-white'}`}
              >
                {t.profile.methods[m]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs font-semibold text-stone-700">{deduction}</p>

          <form className="mt-4 grid gap-3" onSubmit={save}>
            {method === 'paypal' ? text('paypal_email', t.profile.paypalEmail, { maxLength: 254, inputMode: 'email', autoComplete: 'email', type: 'email' }) : (
              <>
                {text('full_name', t.profile.fullName, { maxLength: 100, autoComplete: 'name' })}
                {text('bank_name', t.profile.bankName, { maxLength: 100 })}
                <div className="grid gap-3 sm:grid-cols-2">
                  {text('bank_account', t.profile.bankAccount, { maxLength: 24, inputMode: 'numeric' })}
                  {text('national_id', t.profile.nationalId, { maxLength: 14, inputMode: 'numeric' })}
                </div>
                {text('address', t.profile.address, { maxLength: 300, autoComplete: 'street-address' })}
              </>
            )}
            <ReferralNotice ok={ok} error={error} />
            <p><button type="submit" className={btnPrimary} disabled={busy}>{busy ? t.profile.saving : t.profile.save}</button></p>
          </form>

          {method === 'vn_bank' && (
            <div className="mt-6 grid gap-2">
              <h4 className="text-sm font-semibold">{t.profile.idTitle}</h4>
              <p className="text-xs text-stone-600">{vnSaved ? t.profile.idPrivacy : t.profile.idNeedsSave}</p>
              {(['front', 'back'] as const).map(side => (
                <ReferralIdImageUpload
                  key={side} side={side} t={t} enabled={vnSaved && !busy}
                  uploaded={side === 'front' ? profile?.has_id_front === true : profile?.has_id_back === true}
                  onUploaded={p => { apply(p); setError(null); setOk(t.profile.uploaded); }}
                  onError={m => { setOk(null); setError(m); }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </ReferralSection>
  );
}
