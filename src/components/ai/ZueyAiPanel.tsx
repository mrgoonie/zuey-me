import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ArrowRight, ChevronDown, Download, ExternalLink, Lock, MessageSquare, Pencil, Plus, Quote, ShieldCheck, Sparkles, Square, Trash2, X } from 'lucide-react';
import './zuey-ai.css';
import type { InteractiveBlock } from '../../lib/blocks/schema';
import { parseInline } from '../../lib/blocks/inline';
import type { InlineNode } from '../../lib/blocks/inline';
import { validateInteractiveBlock } from '../../lib/ai/artifacts';
import type { Locale } from '../../lib/i18n/locales';
import { callApi, isRecord, numOr, records, str, strOrNull } from '../members/member-ui';
import type { AiCopy } from './copy';
import { AI_COPY, errorCopy } from './copy';
import { InteractiveFrame } from './InteractiveFrame';
import type { ArticleChatContext } from './article-chat-context';
import { MAX_CHAT_MESSAGE_CHARS, QUOTE_RESERVED_CHARS, composeQuotedQuestion, quotePreview, rememberArticleSession, sessionForArticle } from './article-chat-context';
import { trackEvent } from '../../lib/posthog';

// ---------------------------------------------------------------------------
// Data shapes (validated from untrusted JSON)

type Phase = 'loading' | 'signed_out' | 'no_entitlement' | 'unconfigured' | 'ready' | 'load_error';

interface Quota { month: string; used: number; limit: number | null; remaining: number | null; spentCents: number; budgetCents: number | null }
interface Source { id: string; title: string; url: string; access: 'free' | 'paid'; scope: 'full' | 'preview' }
interface Msg { id: string; role: 'user' | 'assistant'; content: string; sources: Source[]; status: 'complete' | 'streaming' | 'cancelled' | 'error'; errorCode: string | null }
interface Artifact { id: string; messageId: string | null; block: InteractiveBlock }
interface Session { id: string; title: string; updatedAt: string; running: boolean }
type Run = { phase: 'idle' } | { phase: 'thinking'; startedAt: number } | { phase: 'streaming' };
interface Banner { kind: 'error' | 'warn'; code: string; text: string; retry: boolean }

function parseQuota(v: unknown): Quota | null {
  if (!isRecord(v)) return null;
  const limit = typeof v.limit === 'number' ? v.limit : null;
  const remaining = typeof v.remaining === 'number' ? v.remaining : null;
  const budgetCents = typeof v.budget_cents === 'number' ? v.budget_cents : null;
  return { month: str(v, 'month'), used: numOr(v, 'used'), limit, remaining, spentCents: numOr(v, 'spent_cents'), budgetCents };
}

function parseSources(v: unknown): Source[] {
  return records(v).map((r): Source => ({
    id: str(r, 'id'), title: str(r, 'title'), url: str(r, 'url'),
    access: r.access === 'paid' ? 'paid' : 'free', scope: r.scope === 'preview' ? 'preview' : 'full',
  })).filter(s => /^https?:\/\//.test(s.url));
}

function parseMessage(r: Record<string, unknown>): Msg {
  const status = str(r, 'status');
  return {
    id: str(r, 'id'),
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: str(r, 'content'),
    sources: parseSources(r.sources),
    status: status === 'streaming' || status === 'cancelled' || status === 'error' ? status : 'complete',
    errorCode: strOrNull(r, 'error_code'),
  };
}

function parseArtifact(r: Record<string, unknown>): Artifact | null {
  const res = validateInteractiveBlock(r.block);
  if (!res.ok) return null;
  const id = str(r, 'id');
  return { id, messageId: strOrNull(r, 'message_id'), block: { ...res.block, id } };
}

function parseSession(r: Record<string, unknown>): Session {
  return { id: str(r, 'id'), title: str(r, 'title'), updatedAt: str(r, 'updated_at'), running: r.running === true };
}

/** Minimal SSE reader: yields {event, data} for each complete frame; comment lines are ignored. */
async function* readSse(res: Response): AsyncGenerator<{ event: string; data: unknown }, void, undefined> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data.join('\n'));
        } catch {
          parsed = null;
        }
        yield { event, data: parsed };
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers

function renderInline(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text': return n.value;
      case 'code': return <code key={i}>{n.value}</code>;
      case 'bold': return <strong key={i}>{renderInline(n.children)}</strong>;
      case 'italic': return <em key={i}>{renderInline(n.children)}</em>;
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">{renderInline(n.children)}</a>;
    }
  });
}

function InlineText({ text }: { text: string }) {
  return <>{renderInline(parseInline(text))}</>;
}

const BULLET_RE = /^\s*[-*•]\s+/;
const NUMBERED_RE = /^\s*\d+[.)]\s+/;

/** Escaped Markdown-lite: paragraphs, lists, headings, fenced code; interactive fences become a chip. */
function RichText({ content, t }: { content: string; t: AiCopy }) {
  const out: ReactNode[] = [];
  const parts = content.split(/(```[\s\S]*?(?:```|$))/g);
  parts.forEach((part, pi) => {
    if (!part) return;
    if (part.startsWith('```')) {
      const firstNl = part.indexOf('\n');
      const lang = (firstNl >= 0 ? part.slice(3, firstNl) : part.slice(3)).trim();
      if (lang === 'zuey-interactive') {
        out.push(<p key={pi} className="zai-artifact-chip"><Sparkles size={14} aria-hidden="true" />{t.artifact}</p>);
        return;
      }
      const body = firstNl >= 0 ? part.slice(firstNl + 1).replace(/```$/, '') : '';
      out.push(<pre key={pi}><code>{body.replace(/\n$/, '')}</code></pre>);
      return;
    }
    part.split(/\n{2,}/).forEach((para, j) => {
      const lines = para.split('\n').filter(l => l.trim() !== '');
      // Group consecutive lines into runs so "Intro:\n- a\n- b" becomes a paragraph and a list.
      const runs: { kind: 'ul' | 'ol' | 'p'; lines: string[] }[] = [];
      for (const line of lines) {
        const kind = BULLET_RE.test(line) ? 'ul' : NUMBERED_RE.test(line) ? 'ol' : 'p';
        const last = runs[runs.length - 1];
        if (last && last.kind === kind) last.lines.push(line);
        else runs.push({ kind, lines: [line] });
      }
      runs.forEach((run, r) => {
        const key = `${pi}-${j}-${r}`;
        if (run.kind === 'ul') {
          out.push(<ul key={key}>{run.lines.map((l, k) => <li key={k}><InlineText text={l.replace(BULLET_RE, '')} /></li>)}</ul>);
        } else if (run.kind === 'ol') {
          out.push(<ol key={key}>{run.lines.map((l, k) => <li key={k}><InlineText text={l.replace(NUMBERED_RE, '')} /></li>)}</ol>);
        } else {
          out.push(
            <p key={key}>
              {run.lines.map((l, k) => {
                const heading = /^#{1,6}\s+(.*)$/.exec(l);
                return <span key={k}>{k > 0 && <br />}{heading ? <strong><InlineText text={heading[1]} /></strong> : <InlineText text={l} />}</span>;
              })}
            </p>,
          );
        }
      });
    });
  });
  return <>{out}</>;
}

function formatTime(iso: string, locale: Locale): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

// ---------------------------------------------------------------------------

interface PanelProps {
  locale: Locale;
  /** Opened from an article: one chat session per article, and an optional quoted passage. */
  context?: ArticleChatContext;
  /** Shows a close button (the article drawer). */
  onClose?: () => void;
}

export function ZueyAiPanel({ locale, context, onClose }: PanelProps) {
  const t = AI_COPY[locale];
  const uid = useId();
  const [phase, setPhase] = useState<Phase>('loading');
  const [isAdmin, setIsAdmin] = useState(false);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [input, setInput] = useState('');
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [live, setLive] = useState('');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [isChatPage, setIsChatPage] = useState(false);
  const [nextPath, setNextPath] = useState('/chat');
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [quote, setQuote] = useState<string | null>(context?.quote ?? null);
  const articleSlug = context?.slug ?? null;
  const onQuoteChange = context?.onQuoteChange;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const newChatRef = useRef<HTMLButtonElement | null>(null);
  const renameDialogRef = useRef<HTMLDialogElement | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const liveBuffer = useRef('');
  const lastQuestion = useRef('');
  const stickToBottom = useRef(true);

  const busy = run.phase !== 'idle';
  const quotaExceeded = quota !== null && quota.remaining !== null && quota.remaining <= 0;

  const announce = useCallback((text: string) => setLive(text), []);

  const loadSession = useCallback(async (id: string) => {
    const res = await callApi(`/api/v1/chat/sessions/${encodeURIComponent(id)}`);
    if (!res.ok || !isRecord(res.data)) {
      setBanner({ kind: 'error', code: res.ok ? 'generic' : res.code, text: t.loadFailed, retry: false });
      return;
    }
    setActiveId(id);
    setMessages(records(res.data.messages).map(parseMessage));
    setArtifacts(records(res.data.artifacts).map(parseArtifact).filter((a): a is Artifact => a !== null));
    stickToBottom.current = true;
  }, [t]);

  const loadSessions = useCallback(async (selectFirst: boolean) => {
    const res = await callApi('/api/v1/chat/sessions?limit=50');
    if (!res.ok || !isRecord(res.data)) return;
    const list = records(res.data.sessions).map(parseSession);
    setSessions(list);
    setQuota(parseQuota(res.data.quota));
    if (!selectFirst) return;
    if (articleSlug) {
      // From an article: continue that article's session; the first question creates it.
      const remembered = sessionForArticle(articleSlug);
      if (remembered && list.some(s => s.id === remembered)) await loadSession(remembered);
      else if (remembered) rememberArticleSession(articleSlug, null);
      return;
    }
    if (list[0]) await loadSession(list[0].id);
  }, [loadSession, articleSlug]);

  const loadStatus = useCallback(async () => {
    const res = await callApi('/api/v1/chat/status');
    if (!res.ok || !isRecord(res.data)) {
      setPhase('load_error');
      return;
    }
    const d = res.data;
    setIsAdmin(d.is_admin === true);
    setQuota(parseQuota(d.quota));
    if (d.signed_in !== true) setPhase('signed_out');
    else if (d.entitled !== true) setPhase('no_entitlement');
    else if (d.configured !== true) setPhase('unconfigured');
    else {
      setPhase('ready');
      await loadSessions(true);
    }
  }, [loadSessions]);

  useEffect(() => {
    setIsChatPage(window.location.pathname.replace(/\/+$/, '') === '/chat');
    setNextPath(context ? `${window.location.pathname}${window.location.search}` : window.location.pathname || '/chat');
    void loadStatus();
  }, [loadStatus]);

  // Elapsed seconds while waiting for the first token.
  useEffect(() => {
    if (run.phase !== 'thinking') return;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - run.startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [run]);

  // Keep the log pinned to the newest text unless the reader scrolled up.
  useEffect(() => {
    const log = logRef.current;
    if (log && stickToBottom.current) log.scrollTop = log.scrollHeight;
  }, [messages, run, artifacts]);

  useEffect(() => {
    const d = renameDialogRef.current;
    if (!d) return;
    if (renameTarget && !d.open) d.showModal();
    if (!renameTarget && d.open) d.close();
  }, [renameTarget]);

  useEffect(() => {
    const d = deleteDialogRef.current;
    if (!d) return;
    if (deleteTarget && !d.open) d.showModal();
    if (!deleteTarget && d.open) d.close();
  }, [deleteTarget]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // A newly attached passage (each tooltip click bumps the nonce): show it and wait for the question.
  const quoteNonce = context?.quoteNonce;
  const contextQuote = context?.quote ?? null;
  useEffect(() => {
    if (quoteNonce === undefined) return;
    setQuote(contextQuote);
    textareaRef.current?.focus();
  }, [quoteNonce, contextQuote]);

  // The composer only exists once the panel is ready; focus it then when a passage is waiting.
  useEffect(() => {
    if (phase === 'ready' && quote) textareaRef.current?.focus();
  }, [phase, quote]);

  const changeQuote = (next: string | null) => {
    setQuote(next);
    onQuoteChange?.(next);
  };

  const flushLive = (force: boolean) => {
    const buf = liveBuffer.current;
    if (!buf) return;
    if (force || /[.!?。！？\n]\s*$/.test(buf) || buf.length > 160) {
      announce(buf.trim());
      liveBuffer.current = '';
    }
  };

  const updateAssistant = (localId: string, patch: (m: Msg) => Msg) => {
    setMessages(prev => prev.map(m => (m.id === localId ? patch(m) : m)));
  };

  const handlePreStreamError = (code: string, extra: Record<string, unknown>) => {
    switch (code) {
      case 'ai_quota_exceeded':
        setQuota(q => ({ month: typeof extra.month === 'string' ? extra.month : q?.month ?? '', used: q?.used ?? 0, limit: typeof extra.limit === 'number' ? extra.limit : q?.limit ?? 0, remaining: 0, spentCents: q?.spentCents ?? 0, budgetCents: q?.budgetCents ?? null }));
        announce(t.quotaTitle);
        return;
      case 'ai_budget_exceeded':
        setQuota(q => ({
          month: typeof extra.month === 'string' ? extra.month : q?.month ?? '', used: q?.used ?? 0, limit: q?.limit ?? 0, remaining: 0,
          spentCents: typeof extra.spent_cents === 'number' ? extra.spent_cents : q?.spentCents ?? 0,
          budgetCents: typeof extra.budget_cents === 'number' ? extra.budget_cents : q?.budgetCents ?? 0,
        }));
        announce(t.quotaTitle);
        return;
      case 'ai_unconfigured': setPhase('unconfigured'); return;
      case 'entitlement_required': case 'insufficient_scope': setPhase('no_entitlement'); return;
      case 'unauthorized': case 'member_account_required': setPhase('signed_out'); return;
      default: {
        const text = errorCopy(t, code);
        setBanner({ kind: 'error', code, text, retry: code !== 'chat_run_in_progress' });
        announce(text);
      }
    }
  };

  /** `composed`: `raw` is a message sent before (retry), already carrying its quote. */
  const send = async (raw: string, composed = false) => {
    const typed = raw.trim();
    if (!typed || busy || phase !== 'ready' || quotaExceeded) return;
    // An attached passage goes first, as a blockquote naming its article; the API takes one string.
    const sentQuote = !composed && context && quote ? quote : null;
    const question = sentQuote && context ? composeQuotedQuestion(sentQuote, typed, t.quoteSource(context.title, context.url)) : typed;
    setBanner(null);
    let sessionId = activeId;
    if (!sessionId) {
      const title = context ? context.title.slice(0, 120) : undefined;
      const created = await callApi('/api/v1/chat/sessions', { method: 'POST', body: JSON.stringify(title ? { title } : {}) });
      if (!created.ok || !isRecord(created.data)) {
        handlePreStreamError(created.ok ? 'generic' : created.code, {});
        return;
      }
      const session = parseSession(created.data);
      sessionId = session.id;
      setSessions(prev => [session, ...prev]);
      setActiveId(session.id);
      if (articleSlug) rememberArticleSession(articleSlug, session.id);
    }
    const stamp = Date.now();
    const userLocal: Msg = { id: `local-u-${stamp}`, role: 'user', content: question, sources: [], status: 'complete', errorCode: null };
    const aiLocal: Msg = { id: `local-a-${stamp}`, role: 'assistant', content: '', sources: [], status: 'streaming', errorCode: null };
    setMessages(prev => [...prev, userLocal, aiLocal]);
    setInput('');
    if (sentQuote) changeQuote(null);
    if (articleSlug) trackEvent('article_ask_ai_sent', { slug: articleSlug, quoted: Boolean(sentQuote) });
    lastQuestion.current = question;
    liveBuffer.current = '';
    stickToBottom.current = true;
    setRun({ phase: 'thinking', startedAt: Date.now() });
    announce(t.thinking);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let aiId = aiLocal.id;
    try {
      const res = await fetch(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: question, locale }),
        signal: ctrl.signal,
      });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const body: unknown = await res.json().catch(() => null);
        const err = isRecord(body) && isRecord(body.error) ? body.error : {};
        setMessages(prev => prev.filter(m => m.id !== userLocal.id && m.id !== aiLocal.id));
        setInput(sentQuote ? typed : question);
        if (sentQuote) changeQuote(sentQuote);
        handlePreStreamError(typeof err.code === 'string' ? err.code : `http_${res.status}`, err);
        return;
      }
      for await (const ev of readSse(res)) {
        const data = isRecord(ev.data) ? ev.data : {};
        if (ev.event === 'sources') {
          const sources = parseSources(data.sources);
          updateAssistant(aiId, m => ({ ...m, sources }));
        } else if (ev.event === 'delta') {
          const text = str(data, 'text');
          if (!text) continue;
          setRun(r => (r.phase === 'thinking' ? { phase: 'streaming' } : r));
          updateAssistant(aiId, m => ({ ...m, content: m.content + text }));
          liveBuffer.current += text;
          flushLive(false);
        } else if (ev.event === 'done') {
          const serverId = str(data, 'message_id') || aiId;
          const cancelled = data.cancelled === true;
          const content = str(data, 'content');
          updateAssistant(aiId, m => ({ ...m, id: serverId, content: content || m.content, status: cancelled ? 'cancelled' : 'complete' }));
          aiId = serverId;
          const newArtifacts = records(data.artifacts).map(parseArtifact).filter((a): a is Artifact => a !== null);
          if (newArtifacts.length) setArtifacts(prev => [...prev, ...newArtifacts]);
          if (Array.isArray(data.artifact_errors) && data.artifact_errors.length > 0) {
            setBanner({ kind: 'warn', code: 'artifact_rejected', text: t.artifactRejected, retry: false });
          }
          flushLive(true);
          if (cancelled) announce(t.stopped);
        } else if (ev.event === 'error') {
          const code = str(data, 'code') || 'generic';
          const serverId = str(data, 'message_id') || aiId;
          updateAssistant(aiId, m => ({ ...m, id: serverId, status: 'error', errorCode: code }));
          aiId = serverId;
          const text = errorCopy(t, code);
          setBanner({ kind: 'error', code, text, retry: data.retryable !== false });
          flushLive(true);
          announce(text);
        }
      }
    } catch {
      if (ctrl.signal.aborted) {
        updateAssistant(aiId, m => ({ ...m, status: m.status === 'streaming' ? 'cancelled' : m.status }));
        flushLive(true);
        announce(t.stopped);
      } else {
        updateAssistant(aiId, m => ({ ...m, status: 'error', errorCode: 'network_error' }));
        setBanner({ kind: 'error', code: 'network_error', text: errorCopy(t, 'network_error'), retry: true });
        announce(errorCopy(t, 'network_error'));
      }
    } finally {
      abortRef.current = null;
      setRun({ phase: 'idle' });
      void loadSessions(false);
      textareaRef.current?.focus();
    }
  };

  const stop = () => {
    if (!busy) return;
    const id = activeId;
    abortRef.current?.abort();
    // Also stop server-side (covers proxies that keep the upstream request alive).
    if (id) void callApi(`/api/v1/chat/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({}) });
    textareaRef.current?.focus();
  };

  const retry = () => {
    const q = lastQuestion.current;
    if (!q) return;
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && last.status === 'error') {
        const before = prev[prev.length - 2];
        return prev.slice(0, before && before.role === 'user' && before.content === q ? -2 : -1);
      }
      return prev;
    });
    void send(q, true);
  };

  const newChat = () => {
    if (busy) return;
    setActiveId(null);
    setMessages([]);
    setArtifacts([]);
    setBanner(null);
    setSessionsOpen(false);
    textareaRef.current?.focus();
  };

  const selectSession = async (id: string) => {
    if (busy || id === activeId) return;
    setBanner(null);
    await loadSession(id);
    setSessionsOpen(false);
    textareaRef.current?.focus();
  };

  const submitRename = async () => {
    const target = renameTarget;
    const title = renameValue.trim();
    if (!target || !title) return;
    const res = await callApi(`/api/v1/chat/sessions/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    if (res.ok) setSessions(prev => prev.map(s => (s.id === target.id ? { ...s, title } : s)));
    else setBanner({ kind: 'error', code: res.code, text: errorCopy(t, res.code), retry: false });
    setRenameTarget(null);
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    const res = await callApi(`/api/v1/chat/sessions/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
    setDeleteTarget(null);
    if (!res.ok) {
      setBanner({ kind: 'error', code: res.code, text: errorCopy(t, res.code), retry: false });
      return;
    }
    setSessions(prev => prev.filter(s => s.id !== target.id));
    if (articleSlug && sessionForArticle(articleSlug) === target.id) rememberArticleSession(articleSlug, null);
    if (target.id === activeId) {
      setActiveId(null);
      setMessages([]);
      setArtifacts([]);
    }
    announce(t.deleted);
    newChatRef.current?.focus();
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const onRootKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      stop();
    }
  };

  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  };

  const titleId = `${uid}-title`;
  const inputId = `${uid}-input`;
  const hintId = `${uid}-hint`;
  const sessionsId = `${uid}-sessions`;
  const quoteId = `${uid}-quote`;
  const loginHref = `/login?next=${encodeURIComponent(nextPath)}`;

  const quotaPill = quota && (
    <span className="zai-pill" title={quota.month}>
      {quota.limit === null ? t.unlimited : t.quotaLeft(quota.remaining ?? 0, quota.limit)}
    </span>
  );

  const gate = (title: string, body: string, actions: ReactNode, icon: ReactNode) => (
    <div className="zai-banner zai-banner-warn" role="status">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>{icon}{title}</h3>
      <p>{body}</p>
      <div className="zai-banner-actions">{actions}</div>
    </div>
  );

  let content: ReactNode;
  if (phase === 'loading') {
    content = <p className="zai-status-line" role="status">{t.loading}</p>;
  } else if (phase === 'load_error') {
    content = (
      <div className="zai-banner zai-banner-error" role="alert">
        <p>{t.loadFailed}</p>
        <div className="zai-banner-actions"><button type="button" className="zai-btn zai-btn-ghost" onClick={() => { setPhase('loading'); void loadStatus(); }}>{t.retry}</button></div>
      </div>
    );
  } else if (phase === 'signed_out') {
    content = gate(t.signedOutTitle, t.signedOutBody, (
      <>
        <a className="zai-btn zai-btn-primary" href={loginHref}>{t.login}<ArrowRight size={16} aria-hidden="true" /></a>
        <a className="zai-btn zai-btn-ghost" href="/pricing?plan=ai">{t.seePlans}</a>
      </>
    ), <Lock size={16} aria-hidden="true" />);
  } else if (phase === 'no_entitlement') {
    content = gate(t.noEntitlementTitle, t.noEntitlementBody, (
      <a className="zai-btn zai-btn-primary" href="/pricing?plan=ai">{t.upgrade}<ArrowRight size={16} aria-hidden="true" /></a>
    ), <Sparkles size={16} aria-hidden="true" />);
  } else if (phase === 'unconfigured') {
    content = gate(t.unconfiguredTitle, t.unconfiguredBody, null, <Sparkles size={16} aria-hidden="true" />);
  } else {
    const thinkingPct = run.phase === 'thinking' ? Math.min(92, Math.round((elapsed / 11) * 88) + 4) : 0;
    content = (
      <div className="zai-body">
        <nav className="zai-sessions" id={sessionsId} data-collapsed={sessionsOpen ? 'false' : 'true'} aria-label={t.sessions}>
          <button type="button" ref={newChatRef} className="zai-btn zai-btn-ghost" onClick={newChat} disabled={busy}>
            <Plus size={16} aria-hidden="true" />{t.newChat}
          </button>
          {sessions.length === 0 ? (
            <p className="zai-hint">{t.emptySessions}</p>
          ) : (
            <ul className="zai-session-list">
              {sessions.map(s => (
                <li key={s.id} className="zai-session" aria-current={s.id === activeId ? 'true' : undefined}>
                  <button type="button" className="zai-session-open" onClick={() => void selectSession(s.id)} disabled={busy && s.id !== activeId}>
                    <span className="zai-session-title">{s.title || t.untitled}</span>
                    <span className="zai-session-time">{formatTime(s.updatedAt, locale)}</span>
                  </button>
                  <button type="button" className="zai-icon-btn" aria-label={`${t.rename}: ${s.title || t.untitled}`} onClick={() => { setRenameValue(s.title); setRenameTarget(s); }}>
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <button type="button" className="zai-icon-btn" aria-label={`${t.delete}: ${s.title || t.untitled}`} disabled={busy && s.id === activeId} onClick={() => setDeleteTarget(s)}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <a className="zai-hint" href="/api/v1/chat/export" download style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <Download size={13} aria-hidden="true" />{t.exportAll}
          </a>
        </nav>

        <div className="zai-main">
          <button
            type="button"
            className="zai-btn zai-btn-ghost zai-sessions-toggle"
            aria-expanded={sessionsOpen}
            aria-controls={sessionsId}
            onClick={() => setSessionsOpen(o => !o)}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}><MessageSquare size={15} aria-hidden="true" />{t.sessions} ({sessions.length})</span>
            <ChevronDown size={16} aria-hidden="true" style={{ transform: sessionsOpen ? 'rotate(180deg)' : undefined, transition: 'transform 160ms ease' }} />
          </button>

          <div
            className="zai-log"
            ref={logRef}
            role="log"
            aria-label={t.sessions}
            aria-live="off"
            tabIndex={0}
            onScroll={e => {
              const el = e.currentTarget;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            {messages.length === 0 && (
              <div className="zai-msg zai-msg-ai">
                <div className="zai-msg-who">Zuey AI</div>
                <p>{t.greeting}</p>
              </div>
            )}
            {messages.map(m => {
              if (m.role === 'user') {
                return (
                  <div key={m.id} className="zai-msg zai-msg-user">
                    <span className="zai-sr">{t.you}: </span>{m.content}
                  </div>
                );
              }
              const own = artifacts.filter(a => a.messageId === m.id);
              const streamingThis = m.status === 'streaming' && run.phase === 'streaming';
              if (m.status === 'streaming' && !m.content) return null;
              return (
                <div key={m.id} className="zai-msg zai-msg-ai">
                  <div className="zai-msg-who">Zuey AI</div>
                  <div className={streamingThis ? 'zai-caret' : undefined}><RichText content={m.content} t={t} /></div>
                  {m.status === 'cancelled' && <p className="zai-hint">{t.stopped}</p>}
                  {m.status === 'error' && <p className="zai-hint" style={{ color: '#9f1239' }}>{errorCopy(t, m.errorCode ?? 'generic')}</p>}
                  {own.map(a => <InteractiveFrame key={a.id} block={a.block} autoRun locale={locale} />)}
                  {m.sources.length > 0 && (
                    <div className="zai-sources">
                      <h4>{t.sources}</h4>
                      <ol>
                        {m.sources.map(s => (
                          <li key={s.id || s.url}>
                            <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
                            {s.access === 'paid' && (
                              <span className="zai-source-tag"><Lock size={11} aria-hidden="true" />{s.scope === 'preview' ? t.paidPreview : t.paid}</span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              );
            })}
            {run.phase === 'thinking' && (
              <div className="zai-thinking" role="status">
                <span className="zai-thinking-row"><span className="zai-dots" aria-hidden="true"><span /><span /><span /></span>{t.thinking}</span>
                <span className="zai-progress" aria-hidden="true"><span style={{ width: `${thinkingPct}%` }} /></span>
                <small>{t.thinkingHint(elapsed)}</small>
              </div>
            )}
          </div>

          {messages.length === 0 && !busy && !quote && (
            <div className="zai-suggestions">
              {t.suggestions.map(sug => (
                <button key={sug} type="button" className="zai-suggestion" disabled={quotaExceeded} onClick={() => void send(sug)}>{sug}</button>
              ))}
            </div>
          )}

          {quotaExceeded && quota && quota.limit !== null && (
            <div className="zai-banner zai-banner-warn" role="status">
              <h3>{t.quotaTitle}</h3>
              <p>{quota.budgetCents !== null && quota.spentCents >= quota.budgetCents ? t.budgetBody(quota.budgetCents / 100, quota.month) : t.quotaBody(quota.limit, quota.month)}</p>
              <div className="zai-banner-actions"><a className="zai-btn zai-btn-ghost" href="/pricing">{t.seePlans}</a></div>
            </div>
          )}

          {banner && (
            <div className={`zai-banner ${banner.kind === 'error' ? 'zai-banner-error' : 'zai-banner-warn'}`} role={banner.kind === 'error' ? 'alert' : 'status'}>
              {banner.kind === 'error' && <h3>{t.errorTitle}</h3>}
              <p>{banner.text}</p>
              <div className="zai-banner-actions">
                {banner.retry && <button type="button" className="zai-btn zai-btn-primary" onClick={retry} disabled={busy}>{t.retry}</button>}
                <button type="button" className="zai-btn zai-btn-ghost" onClick={() => setBanner(null)}><X size={14} aria-hidden="true" />{t.close}</button>
              </div>
            </div>
          )}

          <form className="zai-composer" onSubmit={e => { e.preventDefault(); void send(input); }}>
            <label htmlFor={inputId}>{t.inputLabel}</label>
            {context && quote && (
              <div className="zai-quote" id={quoteId}>
                <Quote size={14} aria-hidden="true" className="zai-quote-icon" />
                <div className="zai-quote-body">
                  <span className="zai-quote-from">{t.quoteFrom(context.title)}</span>
                  <blockquote className="zai-quote-text">{quotePreview(quote)}</blockquote>
                </div>
                <button type="button" className="zai-icon-btn" aria-label={t.removeQuote} title={t.removeQuote}
                  onClick={() => { changeQuote(null); textareaRef.current?.focus(); }}>
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            )}
            <textarea
              id={inputId}
              ref={textareaRef}
              className="zai-textarea"
              rows={2}
              maxLength={context && quote ? MAX_CHAT_MESSAGE_CHARS - QUOTE_RESERVED_CHARS : MAX_CHAT_MESSAGE_CHARS}
              value={input}
              placeholder={context && quote ? t.quotePlaceholder : t.placeholder}
              aria-describedby={context && quote ? `${quoteId} ${hintId}` : hintId}
              disabled={quotaExceeded}
              onChange={e => { setInput(e.target.value); autosize(e.target); }}
              onKeyDown={onComposerKey}
            />
            <div className="zai-composer-foot">
              <span className="zai-hint" id={hintId}>{t.hint}</span>
              {busy ? (
                <button type="button" className="zai-btn zai-btn-primary zai-btn-stop" onClick={stop}>
                  <Square size={14} aria-hidden="true" fill="currentColor" />{t.stop}
                </button>
              ) : (
                <button type="submit" className="zai-btn zai-btn-primary" disabled={!input.trim() || quotaExceeded}>
                  {t.send}<ArrowRight size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </form>
          <p className="zai-privacy"><ShieldCheck size={14} aria-hidden="true" style={{ flex: 'none', marginTop: '0.1rem' }} />{t.privacy}</p>
        </div>
      </div>
    );
  }

  return (
    <section className={`zai${isChatPage ? ' zai-page' : ''}`} aria-labelledby={titleId} onKeyDown={onRootKey}>
      <div className="zai-head">
        <div style={{ minWidth: 0 }}>
          <div className="zai-eyebrow">{t.eyebrow}</div>
          <h2 className="zai-title" id={titleId}>Zuey AI</h2>
          <p className="zai-intro">{t.intro}</p>
        </div>
        {onClose ? (
          <button type="button" className="zai-icon-btn zai-close" onClick={onClose} aria-label={t.closeDrawer} title={t.closeDrawer}>
            <X size={18} aria-hidden="true" />
          </button>
        ) : (
          <span className="zai-mark" aria-hidden="true">/z/</span>
        )}
      </div>
      {(phase === 'ready' && (quotaPill || !isChatPage)) && (
        <div className="zai-meta">
          {quotaPill}
          {isAdmin && quota?.limit !== null && <span className="zai-pill">admin</span>}
          {!isChatPage && (
            <a href="/chat" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>{t.openChatPage}<ExternalLink size={12} aria-hidden="true" /></a>
          )}
          {run.phase === 'streaming' && <span>{t.streaming}</span>}
        </div>
      )}
      {content}
      <div className="zai-sr" aria-live="polite" aria-atomic="true">{live}</div>

      <dialog ref={renameDialogRef} className="zai-dialog" aria-labelledby={`${uid}-rename`} onClose={() => setRenameTarget(null)}>
        <form onSubmit={e => { e.preventDefault(); void submitRename(); }}>
          <h3 id={`${uid}-rename`}>{t.renameTitle}</h3>
          <label className="zai-sr" htmlFor={`${uid}-rename-input`}>{t.renameTitle}</label>
          <input id={`${uid}-rename-input`} value={renameValue} maxLength={120} onChange={e => setRenameValue(e.target.value)} autoFocus />
          <div className="zai-dialog-actions">
            <button type="button" className="zai-btn zai-btn-ghost" onClick={() => setRenameTarget(null)}>{t.cancel}</button>
            <button type="submit" className="zai-btn zai-btn-primary" disabled={!renameValue.trim()}>{t.save}</button>
          </div>
        </form>
      </dialog>

      <dialog ref={deleteDialogRef} className="zai-dialog" aria-labelledby={`${uid}-delete`} aria-describedby={`${uid}-delete-body`} onClose={() => setDeleteTarget(null)}>
        <h3 id={`${uid}-delete`}>{t.deleteTitle}</h3>
        <p id={`${uid}-delete-body`}>{deleteTarget ? `“${deleteTarget.title || t.untitled}” — ` : ''}{t.deleteBody}</p>
        <div className="zai-dialog-actions">
          <button type="button" className="zai-btn zai-btn-ghost" onClick={() => setDeleteTarget(null)} autoFocus>{t.cancel}</button>
          <button type="button" className="zai-btn zai-btn-primary zai-btn-stop" onClick={() => void confirmDelete()}>{t.delete}</button>
        </div>
      </dialog>
    </section>
  );
}

export default ZueyAiPanel;
