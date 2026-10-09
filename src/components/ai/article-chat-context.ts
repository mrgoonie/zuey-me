/**
 * Client helpers for asking Zuey AI about a passage of an article:
 * composing the quoted question, remembering one chat session per article, and keeping a
 * selected passage across a sign-in (magic links open in another tab, so this uses localStorage
 * with an expiry rather than sessionStorage). Every storage access is guarded: private windows refuse it.
 */

/** Matches MAX_QUESTION_CHARS in src/lib/ai/chat-service.ts (the chat API rejects longer messages). */
export const MAX_CHAT_MESSAGE_CHARS = 4000;
/** Characters of the composer kept free for the quote and its source line. */
export const QUOTE_RESERVED_CHARS = 600;
/** Selections outside this range get no "Ask Zuey AI" tooltip. */
export const MIN_SELECTION_CHARS = 3;
export const MAX_SELECTION_CHARS = 4000;
/** A passage waiting for sign-in is offered again for this long. */
export const PENDING_QUOTE_TTL_MS = 30 * 60 * 1000;

const SESSIONS_KEY = 'zuey.ai.articleSessions';
const PENDING_KEY = 'zuey.ai.pendingQuote';
const MAX_REMEMBERED_SESSIONS = 100;

/** Article the panel is opened from, plus the passage attached to the next question. */
export interface ArticleChatContext {
  slug: string;
  title: string;
  url: string;
  quote: string | null;
  /** Changes every time a new passage is attached, so the panel re-attaches and refocuses. */
  quoteNonce: number;
  /** Called when the attached passage is removed or sent (null) or replaced. */
  onQuoteChange?: (quote: string | null) => void;
}

/** Collapses runs of spaces and blank lines that selections across blocks produce. */
export function normalizeQuote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

const blockquote = (text: string) => text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');

/**
 * The message sent to Zuey AI: the passage as a Markdown blockquote, a line naming its article, then
 * the reader's question. The passage is shortened (with an ellipsis) so the whole message fits `max`.
 */
export function composeQuotedQuestion(quote: string, question: string, source: string, max = MAX_CHAT_MESSAGE_CHARS): string {
  const q = question.trim();
  const tail = `\n\n${source}\n\n${q}`;
  let text = normalizeQuote(quote);
  if (!text) return q;
  let quoted = blockquote(text);
  while (quoted.length + tail.length > max && text.length > 0) {
    const over = quoted.length + tail.length - max;
    text = text.slice(0, Math.max(0, text.length - over - 1)).trimEnd();
    quoted = blockquote(`${text}…`);
  }
  if (!text) return q.slice(0, max);
  return `${quoted}${tail}`;
}

/** Short preview of the passage for the quote card. */
export function quotePreview(quote: string, max = 220): string {
  const flat = normalizeQuote(quote).replace(/\n+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the feature still works, it just forgets across page loads.
  }
}

function readSessionMap(): Record<string, string> {
  const raw = readJson(SESSIONS_KEY);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [slug, id] of Object.entries(raw)) if (typeof id === 'string') out[slug] = id;
  return out;
}

/** Chat session previously used for this article, if any. */
export function sessionForArticle(slug: string): string | null {
  return readSessionMap()[slug] ?? null;
}

/** Remembers (or with null, forgets) the article's chat session; keeps the most recent entries only. */
export function rememberArticleSession(slug: string, sessionId: string | null): void {
  const map = readSessionMap();
  delete map[slug];
  if (sessionId) map[slug] = sessionId;
  const entries = Object.entries(map).slice(-MAX_REMEMBERED_SESSIONS);
  writeJson(SESSIONS_KEY, Object.fromEntries(entries));
}

interface PendingQuote { slug: string; quote: string; at: number }

/** Keeps the passage while the reader signs in (or forgets it with null). */
export function savePendingQuote(slug: string, quote: string | null, now = Date.now()): void {
  writeJson(PENDING_KEY, quote ? { slug, quote, at: now } : null);
}

/** The passage saved for this article within the last 30 minutes, if any. */
export function readPendingQuote(slug: string, now = Date.now()): string | null {
  const raw = readJson(PENDING_KEY);
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Partial<PendingQuote>;
  if (typeof p.quote !== 'string' || typeof p.at !== 'number' || p.slug !== slug) return null;
  if (now - p.at > PENDING_QUOTE_TTL_MS || now < p.at) {
    writeJson(PENDING_KEY, null);
    return null;
  }
  return p.quote;
}
