import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { QuizBlock, QuizKind, QuizQuestion } from '../../../lib/courses/lesson-blocks';
import { QUIZ_KINDS, QUIZ_LIMITS, TRUE_FALSE_OPTIONS } from '../../../lib/courses/lesson-blocks';
import { Area, Field, btnCls, dangerCls, inputCls } from '../knowledge-studio-kit';
import { localId } from './courses-admin-api';

const KIND_LABELS: Record<QuizKind, string> = { single: 'One answer', multiple: 'Several answers', true_false: 'True / false' };

export function newQuestion(): QuizQuestion {
  return { id: localId('q_'), kind: 'single', prompt: '', options: [{ id: localId('o_'), label: '' }, { id: localId('o_'), label: '' }], correct: [] };
}

export function newQuizBlock(): QuizBlock {
  return { id: localId('b_'), type: 'quiz', title: '', passPercent: 70, questions: [newQuestion()] };
}

/** Changing the kind keeps what still makes sense: true/false gets the fixed Đúng/Sai options. */
function withKind(q: QuizQuestion, kind: QuizKind): QuizQuestion {
  if (kind === 'true_false') return { ...q, kind, options: TRUE_FALSE_OPTIONS.map(o => ({ ...o })), correct: ['true'] };
  const options = q.kind === 'true_false' ? newQuestion().options : q.options;
  const known = new Set(options.map(o => o.id));
  const correct = q.correct.filter(c => known.has(c));
  return { ...q, kind, options, correct: kind === 'single' ? correct.slice(0, 1) : correct };
}

function QuestionEditor({ q, index, onChange }: { q: QuizQuestion; index: number; onChange: (q: QuizQuestion) => void }) {
  const fixed = q.kind === 'true_false';
  const toggleCorrect = (id: string) => {
    if (q.kind !== 'multiple') { onChange({ ...q, correct: [id] }); return; }
    onChange({ ...q, correct: q.correct.includes(id) ? q.correct.filter(c => c !== id) : [...q.correct, id] });
  };
  const group = `${q.id}-correct`;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-2">
        <Area label={`Question ${index + 1}`} value={q.prompt} onChange={prompt => onChange({ ...q, prompt })} rows={2} />
        <Field label="Kind">
          <select className={inputCls} value={q.kind} onChange={e => { const k = QUIZ_KINDS.find(x => x === e.target.value); if (k) onChange(withKind(q, k)); }}>
            {QUIZ_KINDS.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </Field>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-[10px] uppercase tracking-widest text-stone-500 font-mono mb-1">Options (mark the correct {q.kind === 'multiple' ? 'ones' : 'one'})</legend>
        {q.options.map((o, i) => (
          <div key={o.id} className="flex items-center gap-2">
            <input
              type={q.kind === 'multiple' ? 'checkbox' : 'radio'} name={group} checked={q.correct.includes(o.id)}
              onChange={() => toggleCorrect(o.id)} aria-label={`Option ${i + 1} is correct`}
            />
            <input
              className={inputCls} value={o.label} disabled={fixed} maxLength={QUIZ_LIMITS.option} aria-label={`Option ${i + 1}`}
              onChange={e => onChange({ ...q, options: q.options.map(x => (x.id === o.id ? { ...x, label: e.target.value } : x)) })}
            />
            {!fixed && (
              <button type="button" className={dangerCls} disabled={q.options.length <= 2} aria-label={`Remove option ${i + 1}`}
                onClick={() => onChange({ ...q, options: q.options.filter(x => x.id !== o.id), correct: q.correct.filter(c => c !== o.id) })}>
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
        {!fixed && q.options.length < QUIZ_LIMITS.options && (
          <button type="button" className={btnCls} onClick={() => onChange({ ...q, options: [...q.options, { id: localId('o_'), label: '' }] })}>
            <Plus size={12} className="inline" /> Option
          </button>
        )}
      </fieldset>
      <Area label="Explanation (shown after grading, optional)" value={q.explanation ?? ''} rows={2}
        onChange={explanation => onChange({ ...q, explanation: explanation || undefined })} />
    </div>
  );
}

/** Form-based quiz builder: title, pass mark, questions with options, correct answers and explanations. */
export function QuizWidgetForm({ block, onChange }: { block: QuizBlock; onChange: (b: QuizBlock) => void }) {
  const setQuestions = (questions: QuizQuestion[]) => onChange({ ...block, questions });
  const move = (i: number, dir: -1 | 1) => {
    const next = [...block.questions];
    const [q] = next.splice(i, 1);
    next.splice(i + dir, 0, q);
    setQuestions(next);
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2">
        <Field label="Quiz title (optional)">
          <input className={inputCls} value={block.title ?? ''} onChange={e => onChange({ ...block, title: e.target.value || undefined })} />
        </Field>
        <Field label="Pass mark %">
          <input className={inputCls} type="number" min={0} max={100} value={block.passPercent}
            onChange={e => onChange({ ...block, passPercent: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) })} />
        </Field>
      </div>
      {block.questions.map((q, i) => (
        <div key={q.id} className="rounded-lg border border-stone-800 p-2.5 space-y-2">
          <div className="flex items-center gap-1 justify-end">
            <button type="button" className={btnCls} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move question ${i + 1} up`}><ArrowUp size={12} /></button>
            <button type="button" className={btnCls} disabled={i === block.questions.length - 1} onClick={() => move(i, 1)} aria-label={`Move question ${i + 1} down`}><ArrowDown size={12} /></button>
            <button type="button" className={dangerCls} disabled={block.questions.length <= 1} aria-label={`Delete question ${i + 1}`}
              onClick={() => { if (window.confirm(`Delete question ${i + 1}?`)) setQuestions(block.questions.filter(x => x.id !== q.id)); }}>
              <Trash2 size={12} />
            </button>
          </div>
          <QuestionEditor q={q} index={i} onChange={nq => setQuestions(block.questions.map(x => (x.id === q.id ? nq : x)))} />
        </div>
      ))}
      {block.questions.length < QUIZ_LIMITS.questions && (
        <button type="button" className={btnCls} onClick={() => setQuestions([...block.questions, newQuestion()])}>
          <Plus size={12} className="inline" /> Question
        </button>
      )}
    </div>
  );
}
