import { useState } from 'react';
import { CommissionReviewPanel } from './referrals/CommissionReviewPanel';
import { KycReviewPanel } from './referrals/KycReviewPanel';
import { PayoutsPanel } from './referrals/PayoutsPanel';
import { ReferralSettingsPanel } from './referrals/ReferralSettingsPanel';
import { ReferrersPanel } from './referrals/ReferrersPanel';

type Section = 'review' | 'kyc' | 'payouts' | 'referrers' | 'settings';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'review', label: 'Review queue' },
  { id: 'kyc', label: 'KYC' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'referrers', label: 'Referrers' },
  { id: 'settings', label: 'Settings' },
];

/** Studio admin for the referral program: fraud review, KYC, monthly payouts, referrers and settings. */
export function ReferralsTab() {
  const [section, setSection] = useState<Section>('review');
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-stone-800">
        <div>
          <h2 className="text-lg font-bold text-white font-serif">Referrals</h2>
          <p className="text-xs text-stone-400">Commissions flagged for review, payout details, the day-1 payout close, referrer overrides and program settings.</p>
        </div>
        <nav aria-label="Referral sections" className="flex items-center gap-1 bg-stone-950/80 p-1 rounded-xl border border-stone-800 text-xs overflow-x-auto max-w-full">
          {SECTIONS.map(({ id, label }) => (
            <button
              key={id} type="button" onClick={() => setSection(id)} aria-current={section === id ? 'page' : undefined}
              className={`shrink-0 px-3 py-1.5 rounded-lg font-medium transition-all ${section === id ? 'bg-amber-400 text-stone-950 font-bold' : 'text-stone-400 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      {section === 'review' && <CommissionReviewPanel />}
      {section === 'kyc' && <KycReviewPanel />}
      {section === 'payouts' && <PayoutsPanel />}
      {section === 'referrers' && <ReferrersPanel />}
      {section === 'settings' && <ReferralSettingsPanel />}
    </div>
  );
}
