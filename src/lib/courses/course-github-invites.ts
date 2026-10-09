/**
 * Private GitHub repositories of a course. Owners are added as read collaborators of every repo
 * listed on the course; revocation removes them. Work is queued in `github_invites` and processed
 * by the scheduler with exponential backoff, so a GitHub outage never blocks a payment.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, num, randomId, str, strOrNull } from '../members/runtime';
import type { CourseRecord } from './course-types';

const GITHUB_API = 'https://api.github.com';
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export type GithubAction = 'invite' | 'remove';

export interface GithubInviteView {
  repo: string;
  action: GithubAction;
  status: 'queued' | 'done' | 'failed' | 'skipped';
  github_login: string | null;
  last_error: string | null;
  updated_at: string;
}

/** Queues invite (or removal) of one user for every repo of the course; replaces earlier queued work. */
export async function enqueueGithubSync(d1: D1DatabaseLike, userId: string, course: Pick<CourseRecord, 'id' | 'github_repos'>, action: GithubAction): Promise<number> {
  const now = iso(membersRuntime.now());
  for (const repo of course.github_repos) {
    await d1.prepare(
      `INSERT INTO github_invites (id, user_id, course_id, repo, action, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
       ON CONFLICT (user_id, course_id, repo) DO UPDATE SET action = excluded.action, status = 'queued', attempts = 0,
         last_error = NULL, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`
    ).bind(randomId('ghi'), userId, course.id, repo, action, now, now, now).run();
  }
  return course.github_repos.length;
}

/** Re-queues skipped/failed invites of a user (after they link GitHub in /account). */
export async function requeueGithubInvites(d1: D1DatabaseLike, userId: string): Promise<number> {
  const now = iso(membersRuntime.now());
  const res = await d1.prepare(
    "UPDATE github_invites SET status = 'queued', attempts = 0, last_error = NULL, next_attempt_at = ?, updated_at = ? WHERE user_id = ? AND action = 'invite' AND status IN ('skipped', 'failed')"
  ).bind(now, now, userId).run();
  return res.meta?.changes ?? 0;
}

export async function listGithubInvites(d1: D1DatabaseLike, userId: string, courseId: string): Promise<GithubInviteView[]> {
  const { results } = await d1.prepare('SELECT * FROM github_invites WHERE user_id = ? AND course_id = ? ORDER BY repo').bind(userId, courseId).all<Row>();
  return (results ?? []).map(r => ({
    repo: str(r, 'repo'),
    action: str(r, 'action') === 'remove' ? 'remove' : 'invite',
    status: (['queued', 'done', 'failed', 'skipped'] as const).find(s => s === r.status) ?? 'queued',
    github_login: strOrNull(r, 'github_login'),
    last_error: strOrNull(r, 'last_error'),
    updated_at: str(r, 'updated_at'),
  }));
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'zuey.me-courses',
  };
}

/** Current login of the user's linked GitHub account (identity subject is the numeric GitHub id). */
async function resolveGithubLogin(d1: D1DatabaseLike, token: string, userId: string): Promise<string | null> {
  const identity = await d1.prepare("SELECT subject FROM user_identities WHERE user_id = ? AND provider = 'github' ORDER BY created_at LIMIT 1").bind(userId).first<Row>();
  const subject = identity ? str(identity, 'subject') : '';
  if (!/^\d+$/.test(subject)) return null;
  const res = await membersRuntime.fetch(`${GITHUB_API}/user/${subject}`, { headers: githubHeaders(token) });
  if (!res.ok) throw new Error(`GitHub user lookup failed (HTTP ${res.status})`);
  const body: unknown = await res.json().catch(() => null);
  const login = body && typeof body === 'object' && 'login' in body ? (body as { login: unknown }).login : null;
  return typeof login === 'string' && login ? login : null;
}

async function applyOne(token: string, repo: string, login: string, action: GithubAction): Promise<void> {
  const url = `${GITHUB_API}/repos/${repo}/collaborators/${encodeURIComponent(login)}`;
  const res = action === 'invite'
    ? await membersRuntime.fetch(url, { method: 'PUT', headers: { ...githubHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ permission: 'pull' }) })
    : await membersRuntime.fetch(url, { method: 'DELETE', headers: githubHeaders(token) });
  // 201 invitation created, 204 already a collaborator / removed, 404 on remove = nothing to remove.
  if (res.status === 201 || res.status === 204 || (action === 'remove' && res.status === 404)) return;
  const text = await res.text().catch(() => '');
  throw new Error(`GitHub ${action} on ${repo} failed (HTTP ${res.status}) ${text.slice(0, 200)}`.trim());
}

export interface GithubProcessResult { processed: number; done: number; skipped: number; retrying: number; failed: number }

/** Processes due queue rows (scheduler job). Without GITHUB_COURSES_TOKEN the queue simply waits. */
export async function processGithubInvites(d1: D1DatabaseLike, env: RuntimeEnv, limit = 20): Promise<GithubProcessResult> {
  const out: GithubProcessResult = { processed: 0, done: 0, skipped: 0, retrying: 0, failed: 0 };
  const token = env.GITHUB_COURSES_TOKEN;
  if (!token) return out;
  const nowMs = membersRuntime.now();
  const { results } = await d1.prepare("SELECT * FROM github_invites WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
    .bind(iso(nowMs), limit).all<Row>();
  const logins = new Map<string, string | null>();
  for (const row of results ?? []) {
    out.processed += 1;
    const id = str(row, 'id');
    const userId = str(row, 'user_id');
    const action: GithubAction = str(row, 'action') === 'remove' ? 'remove' : 'invite';
    try {
      let login = strOrNull(row, 'github_login');
      if (!login || action === 'invite') {
        if (!logins.has(userId)) logins.set(userId, await resolveGithubLogin(d1, token, userId));
        login = logins.get(userId) ?? login;
      }
      if (!login) {
        await d1.prepare("UPDATE github_invites SET status = 'skipped', last_error = 'no_github_identity', updated_at = ? WHERE id = ?").bind(iso(nowMs), id).run();
        out.skipped += 1;
        continue;
      }
      await applyOne(token, str(row, 'repo'), login, action);
      await d1.prepare("UPDATE github_invites SET status = 'done', github_login = ?, last_error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .bind(login, iso(nowMs), id).run();
      out.done += 1;
    } catch (err) {
      const attempts = num(row, 'attempts') + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
      await d1.prepare('UPDATE github_invites SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?')
        .bind(failed ? 'failed' : 'queued', attempts, (err instanceof Error ? err.message : 'unknown').slice(0, 500), iso(nowMs + delay), iso(nowMs), id).run();
      if (failed) out.failed += 1;
      else out.retrying += 1;
    }
  }
  return out;
}
