import { useId, useState } from 'react';
import { Upload } from 'lucide-react';
import { callApi } from '../members/member-ui';
import { parsePayoutProfile, type PayoutProfile } from './referral-api';
import type { ReferralStrings } from './referral-i18n';
import { ReferralBadge } from './referral-section';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface Props {
  side: 'front' | 'back';
  uploaded: boolean;
  /** Bank details must be saved first: the server rejects images without a VN bank profile. */
  enabled: boolean;
  t: ReferralStrings;
  onUploaded: (profile: PayoutProfile) => void;
  onError: (message: string) => void;
}

/** One side of the national ID: picked file is checked locally, then PUT as the raw request body. */
export function ReferralIdImageUpload({ side, uploaded, enabled, t, onUploaded, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const inputId = useId();

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!TYPES.includes(file.type) || file.size === 0 || file.size > MAX_BYTES) { onError(t.profile.badFile); return; }
    setBusy(true);
    const res = await callApi(`/api/v1/referrals/payout-profile/id-images/${side}`, {
      method: 'PUT', body: file, headers: { 'Content-Type': file.type },
    });
    setBusy(false);
    const profile = res.ok ? parsePayoutProfile(res.data) : null;
    if (profile) onUploaded(profile);
    else onError(res.ok ? t.loadFailed : res.message);
  }

  const label = side === 'front' ? t.profile.front : t.profile.back;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
      <span className="flex items-center gap-2 text-sm font-medium">
        {label}
        <ReferralBadge tone={uploaded ? 'ok' : 'mute'}>{uploaded ? t.profile.uploaded : t.profile.missing}</ReferralBadge>
      </span>
      <label
        htmlFor={inputId}
        className={`inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold focus-within:ring-2 focus-within:ring-amber-500 ${enabled && !busy ? 'cursor-pointer hover:bg-stone-50' : 'opacity-50 cursor-not-allowed'}`}
      >
        <Upload className="w-3.5 h-3.5" aria-hidden />
        {busy ? t.profile.uploading : t.profile.upload}
        <span className="sr-only"> ({label})</span>
        <input
          id={inputId} type="file" accept={TYPES.join(',')} className="sr-only" disabled={!enabled || busy}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void upload(f); }}
        />
      </label>
    </div>
  );
}
