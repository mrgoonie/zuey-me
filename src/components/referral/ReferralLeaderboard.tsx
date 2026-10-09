import { useEffect, useId, useMemo, useState } from 'react';
import { alertError, callApi, input } from '../members/member-ui';
import { parseLeaderboard, recentMonths, type LeaderboardRow } from './referral-api';
import { fill, type ReferralStrings } from './referral-i18n';
import { ReferralSection } from './referral-section';

const MONTHS_SHOWN = 12;
const MEDALS: Record<number, string> = { 1: 'bg-amber-400 text-stone-950', 2: 'bg-stone-300 text-stone-900', 3: 'bg-orange-300 text-stone-950' };

/** Public monthly top 10 (masked names, counts only), with a month picker over the last year. */
export function ReferralLeaderboard({ t }: { t: ReferralStrings }) {
  const months = useMemo(() => recentMonths(Date.now(), MONTHS_SHOWN), []);
  const [month, setMonth] = useState(months[0]);
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();

  useEffect(() => {
    let live = true;
    setRows(null); setError(null);
    void callApi(`/api/v1/referrals/leaderboard?month=${encodeURIComponent(month)}`).then(res => {
      if (!live) return;
      const parsed = res.ok ? parseLeaderboard(res.data) : null;
      if (parsed) setRows(parsed); else setError(res.ok ? t.loadFailed : res.message);
    });
    return () => { live = false; };
  }, [month, t.loadFailed]);

  return (
    <ReferralSection
      id="referral-leaderboard" title={t.leaderboard.title}
      aside={(
        <label htmlFor={selectId} className="flex items-center gap-2 text-xs font-semibold text-stone-600">{t.leaderboard.month}
          <select id={selectId} className={`${input} w-auto py-1.5`} value={month} onChange={e => setMonth(e.target.value)}>
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
    >
      <div role="status" aria-live="polite" className="empty:hidden">
        {error && <p className={alertError}>{error}</p>}
        {rows === null && !error && <p className="text-sm text-stone-600">{t.loading}</p>}
        {rows !== null && rows.length === 0 && <p className="text-sm text-stone-600">{t.leaderboard.empty}</p>}
      </div>
      {rows !== null && rows.length > 0 && (
        <ol className="grid gap-1.5">
          {rows.map((r, i) => (
            <li key={`${r.rank}-${i}`} className="flex items-center gap-3 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 text-sm min-w-0">
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums ${MEDALS[r.rank] ?? 'bg-stone-200 text-stone-700'}`} aria-label={`#${r.rank}`}>{r.rank}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <span className="shrink-0 tabular-nums text-stone-700">{fill(t.leaderboard.count, { n: r.referrals })}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-stone-600">{t.leaderboard.note}</p>
    </ReferralSection>
  );
}
