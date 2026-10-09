import { useState } from 'react';
import { Check, Copy, QrCode } from 'lucide-react';
import type { Locale } from '../../lib/i18n/locales';
import { QrCodeModal } from '../QrCodeModal';
import { btnGhost, btnPrimary, input } from '../members/member-ui';
import { tierProgress, type ReferralMe } from './referral-api';
import { fill, type ReferralStrings } from './referral-i18n';
import { ReferralSection } from './referral-section';

interface Props {
  me: ReferralMe;
  t: ReferralStrings;
  locale: Locale;
}

/** Current rate R with 90-day progress to the next tier, and the personal link with copy + QR. */
export function ReferralTierShareCard({ me, t, locale }: Props) {
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const progress = tierProgress(me.tier.count_90d, me.program.tiers);
  const overrideActive = me.admin_rate_override !== null && me.admin_rate_override > me.tier.rate;
  const link = me.link ?? '';

  const copy = () => {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }, () => setCopied(false));
  };

  return (
    <ReferralSection id="referral-tier" title={t.tier.title} aside={<span className="text-4xl font-bold font-serif tabular-nums">{me.rate}%</span>}>
      <p className="text-sm text-stone-700">{fill(t.tier.count, { n: me.tier.count_90d, days: me.tier.window_days })}</p>
      <div
        className="mt-3 h-2.5 w-full rounded-full bg-stone-200 overflow-hidden"
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
        aria-label={me.tier.next ? fill(t.tier.next, { n: me.tier.next.remaining, rate: me.tier.next.rate }) : t.tier.top}
      >
        <div className="h-full rounded-full bg-amber-500 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <p className="mt-2 text-xs font-semibold text-stone-700">
        {me.tier.next ? fill(t.tier.next, { n: me.tier.next.remaining, rate: me.tier.next.rate }) : t.tier.top}
      </p>
      {overrideActive && <p className="mt-1 text-xs text-emerald-800">{fill(t.tier.override, { rate: me.admin_rate_override ?? 0 })}</p>}
      <p className="mt-3 text-[11px] text-stone-600">
        <span className="font-semibold">{t.tier.ladder}: </span>
        {me.program.tiers.map((tier, i) => (
          <span key={tier.min} className={tier.rate === me.tier.rate && tier.min <= me.tier.count_90d ? 'font-bold text-stone-900' : ''}>
            {i > 0 && ' · '}{tier.min}+ → {tier.rate}%
          </span>
        ))}
      </p>

      <h4 className="mt-6 text-sm font-semibold">{t.share.title}</h4>
      <div className="mt-2 flex flex-col sm:flex-row gap-2 min-w-0">
        <label htmlFor="referral-link" className="sr-only">{t.share.title}</label>
        <input id="referral-link" className={`${input} font-mono`} readOnly value={link} onFocus={e => e.currentTarget.select()} />
        <div className="flex gap-2 shrink-0">
          <button type="button" className={`${btnPrimary} flex-1 sm:flex-none`} onClick={copy} disabled={!link}>
            {copied ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
            <span aria-live="polite">{copied ? t.share.copied : t.share.copy}</span>
          </button>
          <button type="button" className={btnGhost} onClick={() => setQrOpen(true)} disabled={!link}>
            <QrCode className="w-4 h-4" aria-hidden />{t.share.qr}
          </button>
        </div>
      </div>
      <QrCodeModal
        isOpen={qrOpen} onClose={() => setQrOpen(false)} url={link} lang={locale === 'vi' ? 'vi' : 'en'}
        title={t.share.qrTitle} hint={t.share.qrHint} fileName={`zuey-referral-${me.code ?? 'link'}.png`}
      />
    </ReferralSection>
  );
}
