/**
 * XP, badges, learning streaks and the leaderboard. XP lives in an append-only ledger keyed by an
 * idempotency key, so retries never double-award and future reward redemptions can debit it.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { DAY_MS, iso, membersRuntime, randomId, str, strOrNull } from '../members/runtime';

export const XP_RULES = {
  lesson_completed: 10,
  quiz_passed: 20,
  quiz_perfect: 10,
  course_completed: 100,
  streak_7: 50,
  streak_30: 200,
} as const;
export type XpReason = keyof typeof XP_RULES;

export const BADGES: Record<string, { name: string; description: string }> = {
  first_lesson: { name: 'Bước đầu tiên', description: 'Hoàn thành bài học đầu tiên' },
  first_quiz: { name: 'Qua bài kiểm tra', description: 'Vượt qua quiz đầu tiên' },
  perfect_quiz: { name: 'Điểm tuyệt đối', description: 'Trả lời đúng mọi câu của một quiz' },
  course_complete: { name: 'Về đích', description: 'Hoàn thành trọn một khoá học' },
  streak_7: { name: 'Bền bỉ 7 ngày', description: 'Học 7 ngày liên tiếp' },
  streak_30: { name: 'Bền bỉ 30 ngày', description: 'Học 30 ngày liên tiếp' },
  xp_1000: { name: '1000 XP', description: 'Tích luỹ 1000 điểm kinh nghiệm' },
};

export function saigonDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** Records an XP award once per key; true when it was new. */
export async function awardXp(d1: D1DatabaseLike, userId: string, reason: XpReason, ref: string | null, key: string): Promise<boolean> {
  const res = await d1.prepare(
    'INSERT INTO xp_ledger (id, user_id, delta, reason, ref, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING'
  ).bind(randomId('xp'), userId, XP_RULES[reason], reason, ref, key, iso(membersRuntime.now())).run();
  const added = (res.meta?.changes ?? 0) > 0;
  if (added && (await totalXp(d1, userId)) >= 1000) await awardBadge(d1, userId, 'xp_1000');
  return added;
}

export async function awardBadge(d1: D1DatabaseLike, userId: string, badge: string): Promise<boolean> {
  if (!BADGES[badge]) return false;
  const res = await d1.prepare('INSERT INTO user_badges (user_id, badge, awarded_at) VALUES (?, ?, ?) ON CONFLICT (user_id, badge) DO NOTHING')
    .bind(userId, badge, iso(membersRuntime.now())).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function totalXp(d1: D1DatabaseLike, userId: string): Promise<number> {
  const row = await d1.prepare('SELECT COALESCE(SUM(delta), 0) AS xp FROM xp_ledger WHERE user_id = ?').bind(userId).first<Row>();
  return Number(row?.xp ?? 0);
}

/** Counts today (Vietnam time) as a learning day and extends or resets the streak. */
export async function touchStreak(d1: D1DatabaseLike, userId: string): Promise<number> {
  const nowMs = membersRuntime.now();
  const today = saigonDay(nowMs);
  const yesterday = saigonDay(nowMs - DAY_MS);
  const row = await d1.prepare('SELECT * FROM learner_profiles WHERE user_id = ?').bind(userId).first<Row>();
  const last = row ? strOrNull(row, 'last_active_day') : null;
  if (last === today) return Number(row?.current_streak ?? 1);
  const current = last === yesterday ? Number(row?.current_streak ?? 0) + 1 : 1;
  const longest = Math.max(current, Number(row?.longest_streak ?? 0));
  await d1.prepare(
    `INSERT INTO learner_profiles (user_id, current_streak, longest_streak, last_active_day, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET current_streak = excluded.current_streak, longest_streak = excluded.longest_streak,
       last_active_day = excluded.last_active_day, updated_at = excluded.updated_at`
  ).bind(userId, current, longest, today, iso(nowMs)).run();
  if (current >= 7 && (await awardBadge(d1, userId, 'streak_7'))) await awardXp(d1, userId, 'streak_7', null, `streak7:${userId}`);
  if (current >= 30 && (await awardBadge(d1, userId, 'streak_30'))) await awardXp(d1, userId, 'streak_30', null, `streak30:${userId}`);
  return current;
}

export interface LearnerSummary {
  xp: number;
  current_streak: number;
  longest_streak: number;
  last_active_day: string | null;
  leaderboard_opt_out: boolean;
  badges: Array<{ id: string; name: string; description: string; awarded_at: string }>;
}

export async function learnerSummary(d1: D1DatabaseLike, userId: string): Promise<LearnerSummary> {
  const [xp, profile, badges] = await Promise.all([
    totalXp(d1, userId),
    d1.prepare('SELECT * FROM learner_profiles WHERE user_id = ?').bind(userId).first<Row>(),
    d1.prepare('SELECT badge, awarded_at FROM user_badges WHERE user_id = ? ORDER BY awarded_at').bind(userId).all<Row>(),
  ]);
  // A streak is only current if the learner was active today or yesterday.
  const last = profile ? strOrNull(profile, 'last_active_day') : null;
  const nowMs = membersRuntime.now();
  const live = last === saigonDay(nowMs) || last === saigonDay(nowMs - DAY_MS);
  return {
    xp,
    current_streak: live ? Number(profile?.current_streak ?? 0) : 0,
    longest_streak: Number(profile?.longest_streak ?? 0),
    last_active_day: last,
    leaderboard_opt_out: Number(profile?.leaderboard_opt_out ?? 0) === 1,
    badges: (badges.results ?? []).flatMap(r => {
      const id = str(r, 'badge');
      const meta = BADGES[id];
      return meta ? [{ id, ...meta, awarded_at: str(r, 'awarded_at') }] : [];
    }),
  };
}

export async function setLeaderboardOptOut(d1: D1DatabaseLike, userId: string, optOut: unknown): Promise<boolean> {
  if (typeof optOut !== 'boolean') throw new AppError(400, 'invalid_field', 'leaderboard_opt_out must be a boolean', { field: 'leaderboard_opt_out' });
  await d1.prepare(
    `INSERT INTO learner_profiles (user_id, leaderboard_opt_out, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET leaderboard_opt_out = excluded.leaderboard_opt_out, updated_at = excluded.updated_at`
  ).bind(userId, optOut ? 1 : 0, iso(membersRuntime.now())).run();
  return optOut;
}

/** "Nguyễn Văn An" → "Nguyễn A."; email-only accounts → "an***". Never exposes a full identity. */
export function maskLearnerName(name: string | null, email: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
  if (parts.length === 1) return parts[0].length <= 2 ? `${parts[0]}***` : `${parts[0].slice(0, 2)}***`;
  const local = (email ?? '').split('@')[0] ?? '';
  return local ? `${local.slice(0, 2)}***` : 'Ẩn danh';
}

export interface LeaderboardEntry { rank: number; name: string; xp: number; is_me: boolean }

/** Start of the current month in Vietnam time, as a UTC ISO instant. */
export function monthStartIso(nowMs: number): string {
  const [y, m] = saigonDay(nowMs).split('-');
  return new Date(Date.parse(`${y}-${m}-01T00:00:00+07:00`)).toISOString();
}

/** Top learners by XP earned this month (or all time), excluding those who opted out. */
export async function leaderboard(d1: D1DatabaseLike, period: 'month' | 'all', viewerId: string | null, limit = 20): Promise<LeaderboardEntry[]> {
  const since = period === 'month' ? monthStartIso(membersRuntime.now()) : '0000';
  const { results } = await d1.prepare(
    `SELECT x.user_id, SUM(x.delta) AS xp, u.name, u.email FROM xp_ledger x
     JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL
     LEFT JOIN learner_profiles p ON p.user_id = x.user_id
     WHERE x.created_at >= ? AND x.delta > 0 AND COALESCE(p.leaderboard_opt_out, 0) = 0
     GROUP BY x.user_id ORDER BY xp DESC, MIN(x.created_at) ASC LIMIT ?`
  ).bind(since, Math.min(100, limit)).all<Row>();
  return (results ?? []).map((r, i) => ({
    rank: i + 1,
    name: maskLearnerName(strOrNull(r, 'name'), strOrNull(r, 'email')),
    xp: Number(r.xp ?? 0),
    is_me: viewerId !== null && str(r, 'user_id') === viewerId,
  }));
}
