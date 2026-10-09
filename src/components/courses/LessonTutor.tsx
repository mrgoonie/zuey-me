import { useEffect, useId, useRef, useState } from 'react';
import type { SubmitLike } from '../members/member-ui';
import { btnGhost, btnPrimary, callApi, input, isRecord, jsonBody, loginUrl, str } from '../members/member-ui';
import { readSse, tutorErrorCopy } from './course-sse';

interface Msg { id: string; role: 'user' | 'assistant'; content: string; status: 'streaming' | 'complete' | 'error' }
interface Props { courseSlug: string; lessonSlug: string; lessonTitle: string; signedIn: boolean }

const MAX_QUESTION = 2_000;

/**
 * "Hỏi Zuey AI về bài này": a collapsible tutor that streams answers grounded in the lesson
 * (`course_lesson` on the chat API). One chat session per lesson per browser tab; normal AI quota applies.
 */
export function LessonTutor({ courseSlug, lessonSlug, lessonTitle, signedIn }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; upgrade: boolean } | null>(null);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelId = useId();
  const fieldId = useId();
  const storageKey = `zuey-tutor:${courseSlug}/${lessonSlug}`;

  useEffect(() => {
    try { sessionRef.current = window.sessionStorage.getItem(storageKey); } catch { sessionRef.current = null; }
    return () => abortRef.current?.abort();
  }, [storageKey]);

  async function ensureSession(): Promise<string | null> {
    if (sessionRef.current) return sessionRef.current;
    const res = await callApi('/api/v1/chat/sessions', { method: 'POST', body: jsonBody({ title: `Bài học: ${lessonTitle}`.slice(0, 80) }) });
    if (!res.ok || !isRecord(res.data) || !str(res.data, 'id')) { setProblem(tutorErrorCopy(res.ok ? 'generic' : res.code)); return null; }
    sessionRef.current = str(res.data, 'id');
    try { window.sessionStorage.setItem(storageKey, sessionRef.current); } catch { /* storage unavailable: session lives in memory */ }
    return sessionRef.current;
  }

  const patchLast = (patch: (m: Msg) => Msg) => setMessages(prev => prev.map((m, i) => (i === prev.length - 1 ? patch(m) : m)));

  async function ask(e: SubmitLike) {
    e.preventDefault();
    const text = question.trim().slice(0, MAX_QUESTION);
    if (!text || busy) return;
    setBusy(true); setProblem(null);
    let sessionId = await ensureSession();
    if (!sessionId) { setBusy(false); return; }
    const stamp = Date.now();
    setMessages(prev => [...prev, { id: `u${stamp}`, role: 'user', content: text, status: 'complete' }, { id: `a${stamp}`, role: 'assistant', content: '', status: 'streaming' }]);
    setQuestion('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const post = (id: string) => fetch(`/api/v1/chat/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST', credentials: 'same-origin', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message: text, locale: 'vi', course_lesson: { course: courseSlug, lesson: lessonSlug } }),
    });
    try {
      let res = await post(sessionId);
      if (res.status === 404) {
        // The remembered session was deleted elsewhere: start a fresh one once.
        sessionRef.current = null;
        sessionId = await ensureSession();
        if (!sessionId) { setMessages(prev => prev.slice(0, -2)); setQuestion(text); return; }
        res = await post(sessionId);
      }
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const body: unknown = await res.json().catch(() => null);
        const code = isRecord(body) && isRecord(body.error) ? str(body.error, 'code') : '';
        setMessages(prev => prev.slice(0, -2));
        setQuestion(text);
        if (code === 'unauthorized' || code === 'member_account_required') { window.location.assign(loginUrl(`/courses/${courseSlug}/${lessonSlug}`)); return; }
        setProblem(tutorErrorCopy(code || `http_${res.status}`));
        return;
      }
      for await (const ev of readSse(res)) {
        const data = isRecord(ev.data) ? ev.data : {};
        if (ev.event === 'delta') patchLast(m => ({ ...m, content: m.content + str(data, 'text') }));
        else if (ev.event === 'done') patchLast(m => ({ ...m, content: str(data, 'content') || m.content, status: 'complete' }));
        else if (ev.event === 'error') { patchLast(m => ({ ...m, status: 'error' })); setProblem(tutorErrorCopy(str(data, 'code'))); }
      }
      patchLast(m => (m.status === 'streaming' ? { ...m, status: 'complete' } : m));
    } catch {
      patchLast(m => ({ ...m, status: m.status === 'streaming' && ctrl.signal.aborted ? 'complete' : 'error' }));
      if (!ctrl.signal.aborted) setProblem(tutorErrorCopy('network_error'));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-stone-300 bg-white/70 text-stone-900" aria-label="Zuey AI trợ giảng">
      <button
        type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(o => !o)}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-2xl px-4 py-3 text-left text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <span>Hỏi Zuey AI về bài này</span><span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      <div id={panelId} hidden={!open} className="grid gap-3 px-4 pb-4">
        {!signedIn ? (
          <p className="text-sm"><a className="font-semibold underline" href={loginUrl(`/courses/${courseSlug}/${lessonSlug}`)}>Đăng nhập</a> để hỏi Zuey AI về bài học (cần gói có Zuey AI).</p>
        ) : (
          <>
            <p className="text-xs text-stone-600">Zuey AI trả lời dựa trên nội dung bài học này trước tiên. Mỗi câu hỏi dùng một lượt Zuey AI của gói.</p>
            {messages.length > 0 && (
              <ol className="grid max-h-[420px] gap-2 overflow-y-auto" aria-live="polite" aria-busy={busy}>
                {messages.map(m => (
                  <li key={m.id} className={`rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${m.role === 'user' ? 'ml-6 bg-stone-900 text-amber-50' : 'mr-6 bg-[#F5EFEB] border border-stone-200'}`}>
                    <span className="sr-only">{m.role === 'user' ? 'Bạn: ' : 'Zuey AI: '}</span>
                    {m.content || (m.status === 'streaming' ? 'Đang suy nghĩ…' : m.status === 'error' ? 'Không nhận được câu trả lời.' : '')}
                  </li>
                ))}
              </ol>
            )}
            {problem && (
              <p className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm" role="alert">
                {problem.text} {problem.upgrade && <a className="font-semibold underline" href="/pricing">Xem các gói</a>}
              </p>
            )}
            <form className="grid gap-2" onSubmit={ask}>
              <label htmlFor={fieldId} className="sr-only">Câu hỏi về bài học</label>
              <textarea
                id={fieldId} className={`${input} min-h-[88px]`} value={question} maxLength={MAX_QUESTION} placeholder="Ví dụ: Giải thích lại phần này bằng ví dụ đơn giản hơn?"
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(e); } }}
              />
              <p className="flex flex-wrap gap-2">
                <button type="submit" className={`${btnPrimary} min-h-[44px]`} disabled={busy || question.trim() === ''}>{busy ? 'Đang trả lời…' : 'Hỏi'}</button>
                {busy && <button type="button" className={`${btnGhost} min-h-[44px]`} onClick={() => abortRef.current?.abort()}>Dừng</button>}
              </p>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
