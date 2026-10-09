import { useId, useRef, useState } from 'react';
import type { PublicQuizBlock, PublicQuizQuestion } from '../../lib/courses/lesson-blocks';
import type { SubmitLike } from '../members/member-ui';
import { alertError, btnGhost, btnPrimary, isRecord, jsonBody, numOr, records, str, strList, strOrNull } from '../members/member-ui';
import { courseApi, lessonApiBase, widgetCard } from './course-ui';

interface QuestionResult { id: string; correct: boolean; chosen: string[]; correct_options: string[]; explanation: string | null }
interface QuizResult { score: number; total: number; percent: number; passed: boolean; pass_percent: number; xp_awarded: number; preview: boolean; questions: QuestionResult[] }

function parseResult(v: unknown): QuizResult | null {
  if (!isRecord(v) || !Array.isArray(v.questions)) return null;
  return {
    score: numOr(v, 'score'), total: numOr(v, 'total'), percent: numOr(v, 'percent'), passed: v.passed === true,
    pass_percent: numOr(v, 'pass_percent'), xp_awarded: numOr(v, 'xp_awarded'), preview: v.preview === true,
    questions: records(v.questions).map(q => ({
      id: str(q, 'id'), correct: q.correct === true, chosen: strList(q, 'chosen'), correct_options: strList(q, 'correct_options'), explanation: strOrNull(q, 'explanation'),
    })),
  };
}

const KIND_HINT: Record<PublicQuizQuestion['kind'], string> = {
  single: 'Chọn một đáp án',
  multiple: 'Chọn tất cả đáp án đúng',
  true_false: 'Đúng hay sai?',
};

/** Lesson quiz: answers are graded on the server; correct options and explanations appear only after submitting. */
export function QuizWidget({ block, courseSlug, lessonSlug, signedIn }: { block: PublicQuizBlock; courseSlug: string; lessonSlug: string; signedIn: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();
  const resultRef = useRef<HTMLDivElement>(null);
  const unanswered = block.questions.filter(q => (answers[q.id] ?? []).length === 0).length;

  function choose(q: PublicQuizQuestion, optionId: string, checked: boolean) {
    if (result) return;
    setAnswers(prev => {
      const current = prev[q.id] ?? [];
      const next = q.kind === 'multiple' ? (checked ? [...current, optionId] : current.filter(x => x !== optionId)) : [optionId];
      return { ...prev, [q.id]: next };
    });
  }

  async function submit(e: SubmitLike) {
    e.preventDefault();
    if (busy || result) return;
    if (unanswered > 0) { setError(`Bạn còn ${unanswered} câu chưa trả lời.`); return; }
    setBusy(true); setError(null);
    const payload = Object.fromEntries(block.questions.map(q => [q.id, q.kind === 'multiple' ? answers[q.id] ?? [] : (answers[q.id] ?? [])[0] ?? null]));
    const res = await courseApi(`${lessonApiBase(courseSlug, lessonSlug)}/quiz`, { method: 'POST', body: jsonBody({ block_id: block.id, answers: payload }) });
    setBusy(false);
    const parsed = res.ok ? parseResult(res.data) : null;
    if (!parsed) { setError(res.ok ? 'Phản hồi không hợp lệ từ máy chủ.' : res.message); return; }
    setResult(parsed);
    requestAnimationFrame(() => resultRef.current?.focus());
  }

  function retry() { setResult(null); setAnswers({}); setError(null); }

  const byId = new Map(result?.questions.map(q => [q.id, q]) ?? []);

  return (
    <section className={widgetCard} aria-labelledby={`${baseId}-title`}>
      <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">Bài kiểm tra · đạt từ {block.passPercent}%</p>
      <h3 id={`${baseId}-title`} className="mt-1 font-serif text-xl font-bold">{block.title || 'Kiểm tra nhanh'}</h3>
      <form className="mt-4 grid gap-5" onSubmit={submit}>
        {block.questions.map((q, qi) => {
          const graded = byId.get(q.id);
          const chosen = answers[q.id] ?? [];
          return (
            <fieldset key={q.id} className="min-w-0 grid gap-2">
              <legend className="text-[15px] font-semibold break-words">
                <span className="tabular-nums">{qi + 1}.</span> {q.prompt}
                <span className="block text-xs font-normal text-stone-500">{KIND_HINT[q.kind]}</span>
              </legend>
              {q.options.map(o => {
                const isChosen = chosen.includes(o.id);
                const isCorrect = graded?.correct_options.includes(o.id) ?? false;
                const tone = !graded ? (isChosen ? 'border-stone-900 bg-white' : 'border-stone-300 bg-white/60')
                  : isCorrect ? 'border-emerald-500 bg-emerald-50' : isChosen ? 'border-rose-400 bg-rose-50' : 'border-stone-200 bg-white/50';
                return (
                  <label key={o.id} className={`flex min-h-[44px] items-start gap-3 rounded-xl border px-3 py-2.5 text-sm focus-within:ring-2 focus-within:ring-amber-500 ${graded ? '' : 'cursor-pointer'} ${tone}`}>
                    <input
                      type={q.kind === 'multiple' ? 'checkbox' : 'radio'} name={`${baseId}-${q.id}`} value={o.id} checked={isChosen} disabled={Boolean(result)}
                      onChange={e => choose(q, o.id, e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-stone-900"
                    />
                    <span className="min-w-0 flex-1 break-words">{o.label}</span>
                    {graded && isCorrect && <span className="shrink-0 text-xs font-bold text-emerald-800">Đáp án đúng</span>}
                    {graded && isChosen && !isCorrect && <span className="shrink-0 text-xs font-bold text-rose-800">Bạn chọn</span>}
                  </label>
                );
              })}
              {graded && (
                <p className={`text-sm font-semibold ${graded.correct ? 'text-emerald-800' : 'text-rose-800'}`}>
                  {graded.correct ? '✓ Chính xác' : '✗ Chưa đúng'}
                  {graded.explanation && <span className="mt-1 block font-normal text-stone-700 whitespace-pre-line">{graded.explanation}</span>}
                </p>
              )}
            </fieldset>
          );
        })}

        <div ref={resultRef} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" className="grid gap-2 empty:hidden focus:outline-none">
          {error && <p className={alertError}>{error}</p>}
          {result && (
            <p className={`rounded-xl border p-3 text-sm ${result.passed ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-200 text-stone-900'}`}>
              <strong>{result.passed ? 'Đạt!' : 'Chưa đạt.'}</strong> Đúng {result.score}/{result.total} câu ({result.percent}%, cần {result.pass_percent}%).
              {result.xp_awarded > 0 && <> Bạn nhận <strong>+{result.xp_awarded} XP</strong>.</>}
              {result.passed && result.xp_awarded === 0 && signedIn && !result.preview && ' XP của bài kiểm tra này đã được cộng trước đó.'}
              {!signedIn && ' Đăng nhập để lưu kết quả và nhận XP.'}
            </p>
          )}
        </div>

        <p className="flex flex-wrap gap-2">
          {!result && <button type="submit" className={`${btnPrimary} min-h-[44px]`} disabled={busy}>{busy ? 'Đang chấm…' : 'Nộp bài'}</button>}
          {result && <button type="button" className={`${btnGhost} min-h-[44px]`} onClick={retry}>Làm lại</button>}
        </p>
      </form>
    </section>
  );
}
