/**
 * D1 persistence for Zuey AI chat. Every member-facing read is scoped by user id, so another
 * member's session or artifact id behaves exactly like a missing one (404).
 */
import type { D1DatabaseLike } from '../../db/store';
import type { InteractiveBlock } from '../blocks/schema';
import { AppError } from '../http';
import type { Principal } from '../members/policy';
import { randomId } from '../members/runtime';
import type { SourceRef } from './context';
import { validateInteractiveBlock } from './artifacts';
import { aiRuntime, nowIso } from './runtime';

type Row = Record<string, unknown>;

/** A run whose lock is older than this is treated as dead (gateway total timeout is 180 s). */
export const RUN_LOCK_STALE_MS = 4 * 60 * 1000;
export const TITLE_MAX = 120;
export const MAX_SESSIONS_PAGE = 100;

export interface ChatSessionView {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  running: boolean;
}

export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: SourceRef[];
  status: 'complete' | 'streaming' | 'cancelled' | 'error';
  error_code: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  est_cost_cents: number;
  created_at: string;
}

export interface ChatArtifactView {
  id: string;
  session_id: string;
  message_id: string | null;
  status: 'private' | 'attached';
  article_id: string | null;
  attached_at: string | null;
  created_at: string;
  block: InteractiveBlock;
}

export interface ChatSessionDetail {
  session: ChatSessionView;
  messages: ChatMessageView[];
  artifacts: ChatArtifactView[];
}

function str(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

function num(row: Row, key: string): number {
  const v = row[key];
  return typeof v === 'number' ? v : Number(v) || 0;
}

function isRunning(row: Row): boolean {
  const started = strOrNull(row, 'run_started_at');
  return strOrNull(row, 'run_id') !== null && started !== null && Date.parse(started) > aiRuntime.now() - RUN_LOCK_STALE_MS;
}

function toSession(row: Row): ChatSessionView {
  return { id: str(row, 'id'), title: str(row, 'title'), created_at: str(row, 'created_at'), updated_at: str(row, 'updated_at'), running: isRunning(row) };
}

function parseSources(raw: string): SourceRef[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: SourceRef[] = [];
    for (const item of v) {
      if (typeof item !== 'object' || item === null) continue;
      const r: Row = Object.fromEntries(Object.entries(item));
      out.push({
        id: str(r, 'id'), slug: str(r, 'slug'), title: str(r, 'title'), url: str(r, 'url'),
        access: r.access === 'paid' ? 'paid' : 'free', scope: r.scope === 'preview' ? 'preview' : 'full',
      });
    }
    return out;
  } catch {
    return [];
  }
}

function toMessage(row: Row): ChatMessageView {
  const status = str(row, 'status');
  return {
    id: str(row, 'id'),
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: str(row, 'content'),
    sources: parseSources(str(row, 'sources')),
    status: status === 'streaming' || status === 'cancelled' || status === 'error' ? status : 'complete',
    error_code: strOrNull(row, 'error_code'),
    prompt_tokens: num(row, 'prompt_tokens'),
    completion_tokens: num(row, 'completion_tokens'),
    est_cost_cents: num(row, 'est_cost_cents'),
    created_at: str(row, 'created_at'),
  };
}

function toArtifact(row: Row): ChatArtifactView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(str(row, 'block'));
  } catch {
    return null;
  }
  const res = validateInteractiveBlock(parsed);
  if (!res.ok) return null;
  return {
    id: str(row, 'id'),
    session_id: str(row, 'session_id'),
    message_id: strOrNull(row, 'message_id'),
    status: row.status === 'attached' ? 'attached' : 'private',
    article_id: strOrNull(row, 'article_id'),
    attached_at: strOrNull(row, 'attached_at'),
    created_at: str(row, 'created_at'),
    block: { ...res.block, id: str(row, 'id') },
  };
}

export function normalizeTitle(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new AppError(400, 'invalid_field', 'title must be a string', { field: 'title' });
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.length > TITLE_MAX) throw new AppError(400, 'invalid_field', `title must be at most ${TITLE_MAX} characters`, { field: 'title' });
  return title;
}

export async function createSession(d1: D1DatabaseLike, userId: string, title: string): Promise<ChatSessionView> {
  const now = nowIso();
  const id = randomId('chs');
  await d1.prepare('INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, title, now, now).run();
  return { id, title, created_at: now, updated_at: now, running: false };
}

export async function listSessions(d1: D1DatabaseLike, userId: string, limit = 50, offset = 0): Promise<ChatSessionView[]> {
  const lim = Math.max(1, Math.min(MAX_SESSIONS_PAGE, Math.floor(limit) || 50));
  const off = Math.max(0, Math.floor(offset) || 0);
  const { results } = await d1.prepare(
    `SELECT * FROM chat_sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${lim} OFFSET ${off}`
  ).bind(userId).all<Row>();
  return (results ?? []).map(toSession);
}

/** Own live session or 404 (another member's id is indistinguishable from a missing one). */
export async function requireOwnedSession(d1: D1DatabaseLike, userId: string, sessionId: string): Promise<ChatSessionView> {
  const row = await d1.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(sessionId, userId).first<Row>();
  if (!row) throw new AppError(404, 'not_found', 'Chat session not found');
  return toSession(row);
}

export async function sessionDetail(d1: D1DatabaseLike, session: ChatSessionView): Promise<ChatSessionDetail> {
  const messages = await d1.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid').bind(session.id).all<Row>();
  const artifacts = await d1.prepare('SELECT * FROM chat_artifacts WHERE session_id = ? ORDER BY created_at, rowid').bind(session.id).all<Row>();
  return {
    session,
    messages: (messages.results ?? []).map(toMessage),
    artifacts: (artifacts.results ?? []).map(toArtifact).filter((a): a is ChatArtifactView => a !== null),
  };
}

export async function renameSession(d1: D1DatabaseLike, userId: string, sessionId: string, title: string): Promise<ChatSessionView> {
  await requireOwnedSession(d1, userId, sessionId);
  await d1.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(title, nowIso(), sessionId, userId).run();
  return requireOwnedSession(d1, userId, sessionId);
}

/** Deletes the conversation content (messages, artifacts) and tombstones the session row. */
export async function deleteSession(d1: D1DatabaseLike, userId: string, sessionId: string): Promise<void> {
  const session = await requireOwnedSession(d1, userId, sessionId);
  if (session.running) throw new AppError(409, 'chat_run_in_progress', 'Stop the current reply before deleting this chat');
  await d1.prepare('DELETE FROM chat_messages WHERE session_id = ?').bind(sessionId).run();
  await d1.prepare('DELETE FROM chat_artifacts WHERE session_id = ? AND user_id = ?').bind(sessionId, userId).run();
  const now = nowIso();
  await d1.prepare("UPDATE chat_sessions SET title = '', deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(now, now, sessionId, userId).run();
}

export async function setTitleIfEmpty(d1: D1DatabaseLike, sessionId: string, title: string): Promise<void> {
  await d1.prepare("UPDATE chat_sessions SET title = ? WHERE id = ? AND title = ''").bind(title.slice(0, TITLE_MAX), sessionId).run();
}

// ---------------------------------------------------------------------------
// One in-flight run per session

export async function acquireRun(d1: D1DatabaseLike, userId: string, sessionId: string, runToken: string): Promise<boolean> {
  const now = aiRuntime.now();
  const res = await d1.prepare(
    `UPDATE chat_sessions SET run_id = ?, run_started_at = ?, cancel_requested_at = NULL, updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND (run_id IS NULL OR run_started_at IS NULL OR run_started_at < ?)`
  ).bind(runToken, new Date(now).toISOString(), new Date(now).toISOString(), sessionId, userId, new Date(now - RUN_LOCK_STALE_MS).toISOString()).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function releaseRun(d1: D1DatabaseLike, sessionId: string, runToken: string): Promise<void> {
  await d1.prepare('UPDATE chat_sessions SET run_id = NULL, run_started_at = NULL, cancel_requested_at = NULL, updated_at = ? WHERE id = ? AND run_id = ?')
    .bind(nowIso(), sessionId, runToken).run();
}

/** Asks the streaming worker (possibly another isolate) to abort. Returns whether a run was live. */
export async function requestStop(d1: D1DatabaseLike, userId: string, sessionId: string): Promise<boolean> {
  await requireOwnedSession(d1, userId, sessionId);
  const res = await d1.prepare('UPDATE chat_sessions SET cancel_requested_at = ? WHERE id = ? AND user_id = ? AND run_id IS NOT NULL')
    .bind(nowIso(), sessionId, userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function isStopRequested(d1: D1DatabaseLike, sessionId: string, runToken: string): Promise<boolean> {
  const row = await d1.prepare('SELECT cancel_requested_at FROM chat_sessions WHERE id = ? AND run_id = ?').bind(sessionId, runToken).first<Row>();
  return row !== null && strOrNull(row, 'cancel_requested_at') !== null;
}

// ---------------------------------------------------------------------------
// Monthly quota

export interface UsageView {
  month: string;
  requests: number;
  est_cost_cents: number;
}

export async function getUsage(d1: D1DatabaseLike, userId: string, month: string): Promise<UsageView> {
  const row = await d1.prepare('SELECT requests, est_cost_cents FROM ai_usage WHERE user_id = ? AND month = ?').bind(userId, month).first<Row>();
  return { month, requests: row ? num(row, 'requests') : 0, est_cost_cents: row ? num(row, 'est_cost_cents') : 0 };
}

/** Atomically counts one request unless the user already reached `limit` this month. */
export async function consumeQuota(d1: D1DatabaseLike, userId: string, month: string, limit: number): Promise<boolean> {
  const now = nowIso();
  const res = await d1.prepare(
    `INSERT INTO ai_usage (user_id, month, requests, est_cost_cents, updated_at) VALUES (?, ?, 1, 0, ?)
     ON CONFLICT (user_id, month) DO UPDATE SET requests = requests + 1, updated_at = excluded.updated_at WHERE requests < ?`
  ).bind(userId, month, now, limit).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Gives a request back when the gateway never produced an answer. */
export async function refundQuota(d1: D1DatabaseLike, userId: string, month: string): Promise<void> {
  await d1.prepare('UPDATE ai_usage SET requests = requests - 1, updated_at = ? WHERE user_id = ? AND month = ? AND requests > 0')
    .bind(nowIso(), userId, month).run();
}

export async function addUsageCost(d1: D1DatabaseLike, userId: string, month: string, cents: number): Promise<void> {
  if (cents <= 0) return;
  await d1.prepare(
    `INSERT INTO ai_usage (user_id, month, requests, est_cost_cents, updated_at) VALUES (?, ?, 0, ?, ?)
     ON CONFLICT (user_id, month) DO UPDATE SET est_cost_cents = est_cost_cents + excluded.est_cost_cents, updated_at = excluded.updated_at`
  ).bind(userId, month, cents, nowIso()).run();
}

// ---------------------------------------------------------------------------
// Messages and artifacts

export async function insertMessage(
  d1: D1DatabaseLike,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  status: ChatMessageView['status'],
  sources: SourceRef[] = [],
): Promise<string> {
  const id = randomId('msg');
  await d1.prepare('INSERT INTO chat_messages (id, session_id, role, content, sources, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, sessionId, role, content, JSON.stringify(sources), status, nowIso()).run();
  return id;
}

export async function finishMessage(
  d1: D1DatabaseLike,
  messageId: string,
  fields: { content: string; status: ChatMessageView['status']; errorCode: string | null; promptTokens: number; completionTokens: number; costCents: number },
): Promise<void> {
  await d1.prepare(
    'UPDATE chat_messages SET content = ?, status = ?, error_code = ?, prompt_tokens = ?, completion_tokens = ?, est_cost_cents = ? WHERE id = ?'
  ).bind(fields.content, fields.status, fields.errorCode, fields.promptTokens, fields.completionTokens, fields.costCents, messageId).run();
}

export async function insertArtifact(d1: D1DatabaseLike, userId: string, sessionId: string, messageId: string, block: InteractiveBlock): Promise<ChatArtifactView> {
  const id = randomId('art');
  const now = nowIso();
  const { id: _blockId, ...stored } = block;
  await d1.prepare("INSERT INTO chat_artifacts (id, user_id, session_id, message_id, block, status, created_at) VALUES (?, ?, ?, ?, ?, 'private', ?)")
    .bind(id, userId, sessionId, messageId, JSON.stringify(stored), now).run();
  return { id, session_id: sessionId, message_id: messageId, status: 'private', article_id: null, attached_at: null, created_at: now, block: { ...block, id } };
}

export interface ArtifactRecord extends ChatArtifactView {
  user_id: string;
}

export async function getArtifact(d1: D1DatabaseLike, artifactId: string): Promise<ArtifactRecord | null> {
  const row = await d1.prepare(
    'SELECT a.* FROM chat_artifacts a JOIN chat_sessions s ON s.id = a.session_id WHERE a.id = ? AND s.deleted_at IS NULL'
  ).bind(artifactId).first<Row>();
  if (!row) return null;
  const view = toArtifact(row);
  return view ? { ...view, user_id: str(row, 'user_id') } : null;
}

export async function markArtifactAttached(d1: D1DatabaseLike, artifactId: string, articleId: string, attachedBy: string): Promise<void> {
  await d1.prepare("UPDATE chat_artifacts SET status = 'attached', article_id = ?, attached_by = ?, attached_at = ? WHERE id = ?")
    .bind(articleId, attachedBy, nowIso(), artifactId).run();
}

/** Everything stored about the member's chats, for the self-service JSON export. */
export async function exportSessions(d1: D1DatabaseLike, userId: string): Promise<{ exported_at: string; sessions: ChatSessionDetail[]; usage: UsageView[] }> {
  const { results } = await d1.prepare('SELECT * FROM chat_sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(userId).all<Row>();
  const sessions: ChatSessionDetail[] = [];
  for (const row of results ?? []) sessions.push(await sessionDetail(d1, toSession(row)));
  const usage = await d1.prepare('SELECT month, requests, est_cost_cents FROM ai_usage WHERE user_id = ? ORDER BY month').bind(userId).all<Row>();
  return {
    exported_at: nowIso(),
    sessions,
    usage: (usage.results ?? []).map(r => ({ month: str(r, 'month'), requests: num(r, 'requests'), est_cost_cents: num(r, 'est_cost_cents') })),
  };
}

// ---------------------------------------------------------------------------
// Admin access (always audited with a reason)

export const REASON_MIN = 5;
export const REASON_MAX = 500;

export function requireReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    throw new AppError(400, 'reason_required', `Admin access to stored chats requires a reason of ${REASON_MIN}–${REASON_MAX} characters`, { field: 'reason' });
  }
  return reason;
}

export function adminLabel(p: Principal): string {
  return p.email ?? p.via;
}

export async function recordAdminAccess(d1: D1DatabaseLike, p: Principal, action: string, target: string, reason: string): Promise<void> {
  await d1.prepare('INSERT INTO admin_access_audit (admin, admin_user_id, action, target, reason, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(adminLabel(p), p.userId, action, target, reason, nowIso()).run();
}

export interface AdminSessionRow extends ChatSessionView {
  user_id: string;
  user_email: string | null;
  message_count: number;
  last_message_at: string | null;
}

export interface AdminChatStats {
  sessions: number;
  messages: number;
  month: string;
  active_users_month: number;
  requests_month: number;
  est_cost_cents_month: number;
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
}

/** Admin list/search across every member's stored sessions plus aggregate stats. */
export async function adminListSessions(
  d1: D1DatabaseLike,
  opts: { q?: string | null; userId?: string | null; month: string; limit?: number; offset?: number },
): Promise<{ sessions: AdminSessionRow[]; stats: AdminChatStats }> {
  const lim = Math.max(1, Math.min(MAX_SESSIONS_PAGE, Math.floor(opts.limit ?? 50) || 50));
  const off = Math.max(0, Math.floor(opts.offset ?? 0) || 0);
  const where: string[] = ['s.deleted_at IS NULL'];
  const binds: unknown[] = [];
  if (opts.userId) { where.push('s.user_id = ?'); binds.push(opts.userId); }
  const q = (opts.q ?? '').trim().slice(0, 200);
  if (q) {
    where.push(`(s.title LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM chat_messages m2 WHERE m2.session_id = s.id AND m2.content LIKE ? ESCAPE '\\'))`);
    const pattern = likePattern(q.toLowerCase());
    binds.push(pattern, pattern, pattern);
  }
  const { results } = await d1.prepare(
    `SELECT s.*, u.email AS user_email,
       (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
       (SELECT MAX(created_at) FROM chat_messages m WHERE m.session_id = s.id) AS last_message_at
     FROM chat_sessions s LEFT JOIN users u ON u.id = s.user_id
     WHERE ${where.join(' AND ')} ORDER BY s.updated_at DESC LIMIT ${lim} OFFSET ${off}`
  ).bind(...binds).all<Row>();
  const totals = await d1.prepare(
    `SELECT (SELECT COUNT(*) FROM chat_sessions WHERE deleted_at IS NULL) AS sessions,
       (SELECT COUNT(*) FROM chat_messages) AS messages,
       (SELECT COUNT(*) FROM ai_usage WHERE month = ? AND requests > 0) AS active_users,
       (SELECT COALESCE(SUM(requests), 0) FROM ai_usage WHERE month = ?) AS requests,
       (SELECT COALESCE(SUM(est_cost_cents), 0) FROM ai_usage WHERE month = ?) AS cost`
  ).bind(opts.month, opts.month, opts.month).first<Row>();
  return {
    sessions: (results ?? []).map(r => ({
      ...toSession(r),
      user_id: str(r, 'user_id'),
      user_email: strOrNull(r, 'user_email'),
      message_count: num(r, 'message_count'),
      last_message_at: strOrNull(r, 'last_message_at'),
    })),
    stats: {
      sessions: totals ? num(totals, 'sessions') : 0,
      messages: totals ? num(totals, 'messages') : 0,
      month: opts.month,
      active_users_month: totals ? num(totals, 'active_users') : 0,
      requests_month: totals ? num(totals, 'requests') : 0,
      est_cost_cents_month: totals ? num(totals, 'cost') : 0,
    },
  };
}

/** Admin read of any live session (caller must audit first). */
export async function adminSessionDetail(d1: D1DatabaseLike, sessionId: string): Promise<ChatSessionDetail & { user_id: string }> {
  const row = await d1.prepare('SELECT * FROM chat_sessions WHERE id = ? AND deleted_at IS NULL').bind(sessionId).first<Row>();
  if (!row) throw new AppError(404, 'not_found', 'Chat session not found');
  return { ...(await sessionDetail(d1, toSession(row))), user_id: str(row, 'user_id') };
}
