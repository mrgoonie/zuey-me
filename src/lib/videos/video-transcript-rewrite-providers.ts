/**
 * Chat-model providers for the transcript rewrite: OpenRouter (default google/gemma-4-31b-it) and the
 * Workers AI binding. Each provider turns a system + user message into plain text, or throws.
 */
import type { WorkersAiLike } from '../../env';
import type { FetchLike } from '../reads/anymd-client';

export const DEFAULT_WORKERS_AI_REWRITE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const DEFAULT_OPENROUTER_REWRITE_MODEL = 'google/gemma-4-31b-it';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface TranscriptRewriter {
  /** Label stored with the rewrite, e.g. "openrouter:google/gemma-4-31b-it". */
  label: string;
  complete(system: string, user: string, maxTokens: number): Promise<string>;
}

/** Text from a chat result: Workers AI Llama-style `response` or OpenAI-style `choices[0].message.content`. */
export function responseText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  if ('response' in result && typeof result.response === 'string') return result.response;
  if ('choices' in result && Array.isArray(result.choices)) {
    const first: unknown = result.choices[0];
    if (typeof first === 'object' && first !== null && 'message' in first) {
      const message: unknown = first.message;
      if (typeof message === 'object' && message !== null && 'content' in message && typeof message.content === 'string') return message.content;
    }
  }
  return null;
}

function messages(system: string, user: string) {
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function workersAiRewriter(ai: WorkersAiLike, model = DEFAULT_WORKERS_AI_REWRITE_MODEL): TranscriptRewriter {
  return {
    label: `workers-ai:${model}`,
    async complete(system, user, maxTokens) {
      const text = responseText(await ai.run(model, { messages: messages(system, user), max_tokens: maxTokens }));
      if (!text) throw new Error('unexpected Workers AI response shape');
      return text;
    },
  };
}

export function openRouterRewriter(apiKey: string, model = DEFAULT_OPENROUTER_REWRITE_MODEL, fetchImpl: FetchLike = fetch): TranscriptRewriter {
  return {
    label: `openrouter:${model}`,
    async complete(system, user, maxTokens) {
      const res = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://zuey.me', 'X-Title': 'zuey.me' },
        body: JSON.stringify({ model, messages: messages(system, user), max_tokens: maxTokens, temperature: 0.2 }),
      });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) {
        const err = typeof body === 'object' && body !== null && 'error' in body ? body.error : null;
        const message = typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string' ? err.message : res.statusText;
        throw new Error(`OpenRouter ${res.status}: ${message}`);
      }
      const text = responseText(body);
      if (!text) throw new Error('unexpected OpenRouter response shape');
      return text;
    },
  };
}
