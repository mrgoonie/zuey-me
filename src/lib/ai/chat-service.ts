/**
 * One chat turn: authorization → ownership → configuration → run lock → quota → grounding →
 * Dewee stream → persistence. Shared by the SSE REST route and the non-streaming MCP tool.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Locale } from '../i18n/locales';
import type { Principal } from '../members/policy';
import { aiBudgetCents } from '../members/plans';
import { requireCan } from '../members/policy';
import { randomId, siteUrl } from '../members/runtime';
import { jevConfig } from '../search/jev';
import { extractArtifacts } from './artifacts';
import type { ChatArtifactView } from './chat-store';
import {
  acquireRun, addUsageCost, consumeQuota, finishMessage, getUsage, insertArtifact, insertMessage, isStopRequested,
  refundQuota, releaseRun, requireOwnedSession, setTitleIfEmpty,
} from './chat-store';
import type { ContextRetriever, SourceRef } from './context';
import { buildContextMessage, retrieveContext, toSourceRef } from './context';
import { resolveDeweeConfig, streamChat } from './dewee-client';
import { aiRuntime, costRateUsdPerMTok, estimateCostCents, monthlyRequestLimit, saigonMonth } from './runtime';

/** Longest question a member may send (the grounding envelope is added on top). */
export const MAX_QUESTION_CHARS = 4_000;

export type ChatTurnEvent =
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'delta'; text: string }
  | {
    type: 'done';
    message_id: string;
    content: string;
    cancelled: boolean;
    artifacts: ChatArtifactView[];
    artifact_errors: string[];
    usage: { prompt_tokens: number; completion_tokens: number } | null;
  }
  | { type: 'error'; message_id: string; code: string; message: string; retryable: boolean };

export interface QuotaView {
  month: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  /** Estimated AI cost spent this month and the plan's ceiling, in US cents (budget null for admins). */
  spent_cents: number;
  budget_cents: number | null;
}

/** Chat requires a member account with `ai_chat` (admins included) and, for keys, the chat:write scope. */
export function requireChatUser(p: Principal): string {
  requireCan(p, 'chat:use');
  if (!p.userId) throw new AppError(403, 'member_account_required', 'Zuey AI chats belong to a member account; sign in at /login');
  return p.userId;
}

/**
 * Admins are not metered. Members get AI_MONTHLY_REQUEST_LIMIT requests and their plan's AI budget
 * (estimated token cost) per Asia/Saigon month, whichever runs out first.
 */
export async function quotaFor(d1: D1DatabaseLike, env: RuntimeEnv, p: Principal, userId: string): Promise<QuotaView> {
  const month = saigonMonth(aiRuntime.now());
  const usage = await getUsage(d1, userId, month);
  const spent = usage.est_cost_cents;
  if (p.kind === 'admin') return { month, used: usage.requests, limit: null, remaining: null, spent_cents: spent, budget_cents: null };
  const limit = monthlyRequestLimit(env);
  const budget = aiBudgetCents(p.plans);
  const remaining = spent >= budget ? 0 : Math.max(0, limit - usage.requests);
  return { month, used: usage.requests, limit, remaining, spent_cents: spent, budget_cents: budget };
}

export function parseQuestion(raw: unknown): string {
  if (typeof raw !== 'string') throw new AppError(400, 'invalid_field', 'message must be a string', { field: 'message' });
  const message = raw.trim();
  if (!message) throw new AppError(400, 'invalid_field', 'message must not be empty', { field: 'message' });
  if (message.length > MAX_QUESTION_CHARS) {
    throw new AppError(400, 'invalid_field', `message must be at most ${MAX_QUESTION_CHARS} characters`, { field: 'message' });
  }
  return message;
}

export interface ChatTurnInput {
  d1: D1DatabaseLike;
  env: RuntimeEnv;
  principal: Principal;
  sessionId: string;
  message: unknown;
  locale: Locale;
  /** Aborted when the client disconnects or stops. */
  signal?: AbortSignal;
  retriever?: ContextRetriever;
}

/**
 * Runs every precondition (throwing AppError with the right status) and returns the event stream.
 * The stream always releases the session's run lock when it ends, however it ends.
 */
export async function startChatTurn(input: ChatTurnInput): Promise<AsyncGenerator<ChatTurnEvent, void, undefined>> {
  const { d1, env, principal } = input;
  const userId = requireChatUser(principal);
  const question = parseQuestion(input.message);
  await requireOwnedSession(d1, userId, input.sessionId);
  const config = resolveDeweeConfig(env);

  const runToken = randomId('run');
  if (!(await acquireRun(d1, userId, input.sessionId, runToken))) {
    throw new AppError(409, 'chat_run_in_progress', 'A reply is already being generated in this chat; stop it or wait for it to finish');
  }
  const month = saigonMonth(aiRuntime.now());
  try {
    if (principal.kind !== 'admin') {
      const limit = monthlyRequestLimit(env);
      const budget = aiBudgetCents(principal.plans);
      if (!(await consumeQuota(d1, userId, month, limit, budget))) {
        const usage = await getUsage(d1, userId, month);
        if (usage.requests >= limit) {
          throw new AppError(429, 'ai_quota_exceeded', `You have used all ${limit} Zuey AI requests for ${month}; the quota resets next month (Asia/Saigon)`, {
            limit, month, upgrade_url: '/pricing',
          });
        }
        throw new AppError(429, 'ai_budget_exceeded', `You have used this month's Zuey AI budget ($${(budget / 100).toFixed(2)}) for ${month}; it resets next month (Asia/Saigon)`, {
          budget_cents: budget, spent_cents: usage.est_cost_cents, month, upgrade_url: '/pricing',
        });
      }
    }
  } catch (err) {
    await releaseRun(d1, input.sessionId, runToken);
    throw err;
  }

  let sources: SourceRef[] = [];
  let gatewayMessage: string;
  let assistantId: string;
  try {
    const retriever = input.retriever ?? retrieveContext;
    const context = await retriever(principal, question, input.locale, { d1, siteUrl: siteUrl(env), jev: jevConfig(env) });
    sources = context.map(toSourceRef);
    gatewayMessage = buildContextMessage(context, question);
    await insertMessage(d1, input.sessionId, 'user', question, 'complete');
    await setTitleIfEmpty(d1, input.sessionId, question.replace(/\s+/g, ' ').slice(0, 80));
    assistantId = await insertMessage(d1, input.sessionId, 'assistant', '', 'streaming', sources);
  } catch (err) {
    if (principal.kind !== 'admin') await refundQuota(d1, userId, month);
    await releaseRun(d1, input.sessionId, runToken);
    throw err;
  }

  return runTurn({ ...input, userId, question, runToken, month, sources, gatewayMessage, assistantId, config });
}

interface RunState extends ChatTurnInput {
  userId: string;
  question: string;
  runToken: string;
  month: string;
  sources: SourceRef[];
  gatewayMessage: string;
  assistantId: string;
  config: ReturnType<typeof resolveDeweeConfig>;
}

async function* runTurn(state: RunState): AsyncGenerator<ChatTurnEvent, void, undefined> {
  const { d1, env, principal, userId, runToken, month, assistantId } = state;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (state.signal?.aborted) controller.abort();
  state.signal?.addEventListener('abort', onAbort, { once: true });

  // A stop request may arrive on another request/isolate: poll the session row.
  let polling = false;
  const poll = setInterval(() => {
    if (polling || controller.signal.aborted) return;
    polling = true;
    isStopRequested(d1, state.sessionId, runToken)
      .then(stop => { if (stop) controller.abort(); })
      .catch(() => undefined)
      .finally(() => { polling = false; });
  }, aiRuntime.stopPollMs);

  let content = '';
  let finished = false;
  try {
    yield { type: 'sources', sources: state.sources };
    const stream = streamChat(state.config, {
      userId,
      chatSessionId: state.sessionId,
      message: state.gatewayMessage,
      signal: controller.signal,
      openSocket: aiRuntime.openSocket,
    });
    for await (const event of stream) {
      if (event.type === 'delta') {
        content += event.text;
        yield { type: 'delta', text: event.text };
      } else if (event.type === 'done') {
        const finalContent = event.cancelled ? content : event.content || content;
        const usage = event.usage;
        const cost = estimateCostCents(usage?.totalTokens ?? 0, costRateUsdPerMTok(env));
        await finishMessage(d1, assistantId, {
          content: finalContent,
          status: event.cancelled ? 'cancelled' : 'complete',
          errorCode: null,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          costCents: cost,
        });
        await addUsageCost(d1, userId, month, cost);
        const extracted = event.cancelled ? { blocks: [], errors: [] } : extractArtifacts(finalContent);
        const artifacts: ChatArtifactView[] = [];
        for (const block of extracted.blocks) artifacts.push(await insertArtifact(d1, userId, state.sessionId, assistantId, block));
        finished = true;
        yield {
          type: 'done',
          message_id: assistantId,
          content: finalContent,
          cancelled: event.cancelled,
          artifacts,
          artifact_errors: extracted.errors,
          usage: usage ? { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens } : null,
        };
      } else if (event.type === 'error') {
        await finishMessage(d1, assistantId, { content, status: 'error', errorCode: event.code, promptTokens: 0, completionTokens: 0, costCents: 0 });
        // Nothing was generated: the request does not count against the monthly quota.
        if (!content && principal.kind !== 'admin') await refundQuota(d1, userId, month);
        finished = true;
        yield { type: 'error', message_id: assistantId, code: event.code, message: event.message, retryable: event.retryable };
      }
    }
  } catch (err) {
    if (!finished) {
      finished = true;
      await finishMessage(d1, assistantId, { content, status: 'error', errorCode: 'internal_error', promptTokens: 0, completionTokens: 0, costCents: 0 }).catch(() => undefined);
      yield { type: 'error', message_id: assistantId, code: 'internal_error', message: 'The reply could not be completed', retryable: true };
    }
    console.error('Chat turn failed:', err instanceof Error ? err.message : 'unknown');
  } finally {
    clearInterval(poll);
    state.signal?.removeEventListener('abort', onAbort);
    if (!finished) {
      // Consumer went away before the gateway finished (stream cancelled): keep what arrived.
      controller.abort();
      await finishMessage(d1, assistantId, { content, status: 'cancelled', errorCode: null, promptTokens: 0, completionTokens: 0, costCents: 0 }).catch(() => undefined);
    }
    await releaseRun(d1, state.sessionId, runToken).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Server-Sent Events

const encoder = new TextEncoder();

export function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Streams turn events as SSE (`sources`, `delta`, `done`, `error`) with comment keep-alives
 * during the model's think time. Cancelling the body (client disconnect) aborts the gateway run.
 */
export function chatSseResponse(events: AsyncGenerator<ChatTurnEvent, void, undefined>, abort: AbortController, keepAliveMs = 5_000): Response {
  let ping: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          // stream already closed by the client
        }
      };
      safeEnqueue(encoder.encode(': zuey-ai\n\n'));
      ping = setInterval(() => safeEnqueue(encoder.encode(': ping\n\n')), keepAliveMs);
      void (async () => {
        try {
          for await (const ev of events) {
            const { type, ...data } = ev;
            safeEnqueue(sseFrame(type, data));
          }
        } catch {
          safeEnqueue(sseFrame('error', { code: 'internal_error', message: 'The reply could not be completed', retryable: true }));
        } finally {
          clearInterval(ping);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      })();
    },
    cancel() {
      clearInterval(ping);
      abort.abort();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
