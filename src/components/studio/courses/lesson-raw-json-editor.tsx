import { useState } from 'react';
import type { LessonBlock } from '../../../lib/courses/lesson-blocks';
import { validateLessonDocument } from '../../../lib/courses/lesson-blocks';
import { btnCls, inputCls } from '../knowledge-studio-kit';

/**
 * Whole-document JSON view ({version: 1, blocks: [...]}) for pasting or bulk edits. The text is
 * validated with the same lesson validator the API uses before it replaces the draft blocks.
 */
export function LessonRawJsonEditor({ blocks, onApply }: { blocks: LessonBlock[]; onApply: (blocks: LessonBlock[]) => void }) {
  const [text, setText] = useState(() => JSON.stringify({ version: 1, blocks }, null, 2));
  const [errors, setErrors] = useState<Array<{ path: string; message: string }>>([]);

  const apply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErrors([{ path: '$', message: e instanceof Error ? e.message : 'Invalid JSON' }]);
      return;
    }
    const result = validateLessonDocument(parsed);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors([]);
    onApply(result.doc.blocks);
  };

  return (
    <div className="space-y-2">
      <textarea className={`${inputCls} font-mono`} rows={24} value={text} spellCheck={false} aria-label="Lesson document JSON"
        aria-invalid={errors.length > 0} onChange={e => setText(e.target.value)} />
      {errors.length > 0 && (
        <ul className="rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-[11px] text-rose-200 space-y-0.5" role="alert">
          {errors.map((e, i) => <li key={i}><span className="font-mono">{e.path}</span> {e.message}</li>)}
        </ul>
      )}
      <button type="button" className={btnCls} onClick={apply}>Apply JSON to draft</button>
    </div>
  );
}
