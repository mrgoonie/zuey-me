import type { McpContext, McpToolModule } from '../mcp/types';
import { AppError, getNumber, getString } from '../http';
import { isLocale, resolveLocale } from '../i18n/locales';
import type { Principal } from '../members/policy';
import { resolvePrincipal } from '../members/policy';
import { adminChatList, adminChatRead } from './admin-chat';
import type { ChatTurnEvent } from './chat-service';
import { parseQuestion, quotaFor, requireChatUser, startChatTurn } from './chat-service';
import type { ChatArtifactView } from './chat-store';
import { createSession, listSessions, requireOwnedSession } from './chat-store';
import type { SourceRef } from './context';

async function principalOf(ctx: McpContext): Promise<Principal> {
  const p = ctx.principal ? await ctx.principal() : await resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
  if (p.credentialError) throw new AppError(p.credentialError.status, p.credentialError.code, p.credentialError.message);
  return p;
}

function requireDb(ctx: McpContext): NonNullable<McpContext['d1']> {
  const d1 = ctx.d1 ?? ctx.env.DB;
  if (!d1) throw new AppError(503, 'database_unavailable', 'Zuey AI requires the D1 database binding (DB)');
  return d1;
}

const GATEWAY_STATUS: Record<string, number> = { ai_unavailable: 503, ai_timeout: 504 };

/** Drains a chat turn into the final answer (MCP clients do not stream). */
async function collect(events: AsyncGenerator<ChatTurnEvent, void, undefined>): Promise<{
  message_id: string; text: string; cancelled: boolean; sources: SourceRef[]; artifacts: ChatArtifactView[]; artifact_errors: string[];
}> {
  let sources: SourceRef[] = [];
  for await (const ev of events) {
    if (ev.type === 'sources') sources = ev.sources;
    else if (ev.type === 'done') {
      return { message_id: ev.message_id, text: ev.content, cancelled: ev.cancelled, sources, artifacts: ev.artifacts, artifact_errors: ev.artifact_errors };
    } else if (ev.type === 'error') {
      throw new AppError(GATEWAY_STATUS[ev.code] ?? 502, ev.code, ev.message, { retryable: ev.retryable, message_id: ev.message_id });
    }
  }
  throw new AppError(502, 'ai_connection_closed', 'The AI reply ended unexpectedly');
}

/**
 * Zuey AI tools. Members authenticate with a personal key carrying the chat:write scope and a plan
 * with ai_chat (Zuey AI, Kết hợp, Cộng đồng). Answers are grounded only in what the caller may read.
 */
export const chatMcpModule: McpToolModule = {
  tools: [
    {
      name: 'chat_ask',
      description: 'Member: ask Zuey AI a question grounded in zuey.me articles (scope chat:write, ai_chat entitlement). Non-streaming: returns the final text, cited sources and any interactive artifacts. Omit session_id to start a new chat. AI-only plans see paid articles as preview-only sources.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Question (max 4000 characters)' },
          session_id: { type: 'string', description: 'Existing chat session id; omitted = new session' },
          locale: { type: 'string', enum: ['en', 'vi', 'zh', 'ko', 'ja'] },
        },
        required: ['message'],
      },
    },
    {
      name: 'chat_sessions_list', description: 'Member: your Zuey AI chat sessions (newest first) and this month\'s quota.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } },
    },
    {
      name: 'chat_admin_sessions',
      description: 'Admin: list/search all members\' stored chat sessions with stats, or read one with session_id. reason is required and every call is audited.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why you need access (5–500 characters); written to the audit log' },
          session_id: { type: 'string' }, q: { type: 'string' }, user_id: { type: 'string' },
          limit: { type: 'integer' }, offset: { type: 'integer' },
        },
        required: ['reason'],
      },
    },
  ],

  async call(name, args, ctx) {
    switch (name) {
      case 'chat_ask': {
        const p = await principalOf(ctx);
        const userId = requireChatUser(p);
        const d1 = requireDb(ctx);
        const message = parseQuestion(args.message);
        const existing = getString(args, 'session_id');
        const sessionId = existing ? (await requireOwnedSession(d1, userId, existing)).id : (await createSession(d1, userId, '')).id;
        const locale = isLocale(args.locale) ? args.locale : resolveLocale(ctx.request);
        const events = await startChatTurn({ d1, env: ctx.env, principal: p, sessionId, message, locale, signal: ctx.request.signal });
        return { session_id: sessionId, ...(await collect(events)) };
      }
      case 'chat_sessions_list': {
        const p = await principalOf(ctx);
        const userId = requireChatUser(p);
        const d1 = requireDb(ctx);
        return {
          sessions: await listSessions(d1, userId, getNumber(args, 'limit') ?? 50, getNumber(args, 'offset') ?? 0),
          quota: await quotaFor(d1, ctx.env, p, userId),
        };
      }
      case 'chat_admin_sessions': {
        const p = await principalOf(ctx);
        const d1 = requireDb(ctx);
        const sessionId = getString(args, 'session_id');
        if (sessionId) return adminChatRead(d1, p, sessionId, args.reason);
        return adminChatList(d1, p, {
          reason: args.reason, q: getString(args, 'q'), userId: getString(args, 'user_id'),
          limit: getNumber(args, 'limit'), offset: getNumber(args, 'offset'),
        });
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
