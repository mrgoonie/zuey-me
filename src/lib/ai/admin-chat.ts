/**
 * Admin operations on stored chats. Every read of member content requires a stated reason and
 * writes admin_access_audit before any data is returned.
 */
import type { D1DatabaseLike } from '../../db/store';
import { getArticle, toSummary, updateArticle } from '../blocks/articles';
import type { ArticleSummary } from '../blocks/articles';
import { validateDocument } from '../blocks/validate';
import { AppError } from '../http';
import type { Principal } from '../members/policy';
import { requireCan } from '../members/policy';
import type { AdminChatStats, AdminSessionRow, ChatSessionDetail } from './chat-store';
import {
  adminLabel, adminListSessions, adminSessionDetail, getArtifact, markArtifactAttached, recordAdminAccess, requireReason,
} from './chat-store';
import { aiRuntime, saigonMonth } from './runtime';

export async function adminChatList(
  d1: D1DatabaseLike,
  p: Principal,
  opts: { reason: unknown; q?: string | null; userId?: string | null; limit?: number; offset?: number },
): Promise<{ sessions: AdminSessionRow[]; stats: AdminChatStats }> {
  requireCan(p, 'admin');
  const reason = requireReason(opts.reason);
  const target = `chat_sessions${opts.userId ? `:user=${opts.userId}` : ''}${opts.q ? `:q=${opts.q.slice(0, 100)}` : ''}`;
  await recordAdminAccess(d1, p, 'chat.sessions.list', target, reason);
  return adminListSessions(d1, { q: opts.q, userId: opts.userId, month: saigonMonth(aiRuntime.now()), limit: opts.limit, offset: opts.offset });
}

export async function adminChatRead(d1: D1DatabaseLike, p: Principal, sessionId: string, rawReason: unknown): Promise<ChatSessionDetail & { user_id: string }> {
  requireCan(p, 'admin');
  const reason = requireReason(rawReason);
  await recordAdminAccess(d1, p, 'chat.session.read', `chat_session:${sessionId}`, reason);
  return adminSessionDetail(d1, sessionId);
}

/**
 * Appends a chat artifact to an article draft (revision-checked). Publishing still goes through the
 * normal article publish flow. Attaching another member's artifact requires a reason and is audited.
 */
export async function attachArtifact(
  d1: D1DatabaseLike,
  p: Principal,
  artifactId: string,
  body: Record<string, unknown>,
): Promise<{ artifact_id: string; article: ArticleSummary; block_id: string }> {
  requireCan(p, 'admin');
  const slug = typeof body.article_slug === 'string' ? body.article_slug.trim() : '';
  if (!slug) throw new AppError(400, 'invalid_field', 'article_slug is required', { field: 'article_slug' });
  const artifact = await getArtifact(d1, artifactId);
  if (!artifact) throw new AppError(404, 'not_found', 'Artifact not found');
  if (artifact.user_id !== p.userId) {
    const reason = requireReason(body.reason);
    await recordAdminAccess(d1, p, 'chat.artifact.attach', `chat_artifact:${artifactId}`, reason);
  }
  const article = await getArticle(d1, slug);
  if (!article) throw new AppError(404, 'not_found', 'Article not found');
  const blockId = `ai_${artifactId.replace(/[^A-Za-z0-9_-]/g, '').slice(-20)}_${crypto.randomUUID().slice(0, 6)}`;
  const draft = { version: 1, blocks: [...article.draft.blocks, { ...artifact.block, id: blockId }] };
  const checked = validateDocument(draft);
  if (!checked.ok) throw new AppError(422, 'invalid_document', 'The draft cannot take this block', { errors: checked.errors });
  const updated = await updateArticle(d1, slug, { document: checked.doc }, body.expected_revision);
  await markArtifactAttached(d1, artifactId, updated.id, adminLabel(p));
  return { artifact_id: artifactId, article: toSummary(updated), block_id: blockId };
}
