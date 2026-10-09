import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { num, str, strOrNull } from '../members/runtime';
import { MONTH_RE, saigonMonth, saigonMonthRange } from './saigon-calendar';

/**
 * Public monthly leaderboard (Asia/Saigon month): referrers ranked by referred orders paid in the month,
 * excluding reversed and blocked commissions, referrers who opted out, locked referrers and deleted
 * accounts. Shows a masked name and a count only, never money. Ties share a rank (1, 1, 3) and are
 * listed by who reached the count first.
 */
export const LEADERBOARD_SIZE = 10;

export interface LeaderboardEntry {
  rank: number;
  name: string;
  referrals: number;
}

export interface Leaderboard {
  month: string;
  entries: LeaderboardEntry[];
}

/** "Duy Nguyen" → "Duy N."; one-word names stay; without a name, the email's first letter: "D***". */
export function maskDisplayName(name: string | null, email: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]} ${Array.from(words[words.length - 1])[0].toUpperCase()}.`;
  if (words.length === 1) return words[0];
  const first = Array.from((email ?? '').trim())[0];
  return first ? `${first.toUpperCase()}***` : 'Ẩn danh';
}

/** Validates `?month=YYYY-MM`; defaults to the current local month. */
export function parseLeaderboardMonth(raw: string | null, nowMs: number): string {
  if (raw === null || raw === '') return saigonMonth(nowMs);
  if (!MONTH_RE.test(raw)) throw new AppError(400, 'invalid_month', 'month must be YYYY-MM', { field: 'month' });
  return raw;
}

export async function monthlyLeaderboard(d1: D1DatabaseLike, month: string): Promise<Leaderboard> {
  const range = saigonMonthRange(month);
  if (!range) throw new AppError(400, 'invalid_month', 'month must be YYYY-MM', { field: 'month' });
  const { results } = await d1.prepare(
    `SELECT c.referrer_user_id, COUNT(*) AS referrals, MAX(c.paid_at) AS reached_at, u.name, u.email
     FROM referral_commissions c
     JOIN users u ON u.id = c.referrer_user_id AND u.deleted_at IS NULL
     JOIN referral_profiles p ON p.user_id = c.referrer_user_id AND p.leaderboard_opt_out = 0 AND p.locked_at IS NULL
     WHERE c.paid_at >= ? AND c.paid_at < ? AND c.status NOT IN ('reversed', 'blocked')
     GROUP BY c.referrer_user_id
     ORDER BY referrals DESC, reached_at ASC, c.referrer_user_id ASC
     LIMIT ?`
  ).bind(range.start, range.end, LEADERBOARD_SIZE).all<Row>();
  const entries: LeaderboardEntry[] = [];
  for (const [i, r] of (results ?? []).entries()) {
    const referrals = num(r, 'referrals');
    const prev = entries[i - 1];
    entries.push({
      rank: prev && prev.referrals === referrals ? prev.rank : i + 1,
      name: maskDisplayName(strOrNull(r, 'name'), str(r, 'email')),
      referrals,
    });
  }
  return { month, entries };
}
