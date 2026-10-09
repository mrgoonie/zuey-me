import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { Block, BlockType } from '../../../lib/blocks/schema';
import type { AssetRecord } from '../../../lib/courses/course-types';
import type { LessonBlock } from '../../../lib/courses/lesson-blocks';
import { isCourseWidget } from '../../../lib/courses/lesson-blocks';
import { editorInternals } from '../ArticleEditor';
import { btnCls, dangerCls, inputCls } from '../knowledge-studio-kit';
import { localId } from './courses-admin-api';
import { ArticleBlockFields, CourseMediaFields, GithubRepoFields } from './lesson-block-field-editors';
import { QuizWidgetForm, newQuizBlock } from './quiz-widget-form';

const WIDGET_LABELS: Record<string, string> = { quiz: 'Quiz', course_media: 'Course media', github_repo: 'GitHub repo' };

/**
 * Ordered list of lesson blocks: article blocks and course widgets, each with its own editor,
 * plus insert helpers. `invalidIds` holds article blocks whose JSON does not currently parse.
 */
export function LessonBlockListEditor({ blocks, onChange, assets, invalidIds, onInvalidIds }: {
  blocks: LessonBlock[];
  onChange: (blocks: LessonBlock[]) => void;
  assets: AssetRecord[];
  invalidIds: Set<string>;
  onInvalidIds: (ids: Set<string>) => void;
}) {
  const [articleType, setArticleType] = useState<BlockType>('paragraph');

  const replace = (id: string, b: LessonBlock) => onChange(blocks.map(x => (x.id === id ? b : x)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...blocks];
    const [b] = next.splice(i, 1);
    next.splice(i + dir, 0, b);
    onChange(next);
  };
  const remove = (b: LessonBlock, i: number) => {
    if (!window.confirm(`Delete block ${i + 1} (${WIDGET_LABELS[b.type] ?? b.type})?`)) return;
    onChange(blocks.filter(x => x.id !== b.id));
    if (invalidIds.has(b.id)) { const s = new Set(invalidIds); s.delete(b.id); onInvalidIds(s); }
  };
  const setValidity = (id: string, ok: boolean) => {
    if (ok === !invalidIds.has(id)) return;
    const s = new Set(invalidIds);
    if (ok) s.delete(id); else s.add(id);
    onInvalidIds(s);
  };
  const addArticle = () => {
    const b = editorInternals.newBlock(articleType);
    if (b) onChange([...blocks, b]);
  };
  const addMedia = () => onChange([...blocks, { id: localId('b_'), type: 'course_media', assetId: assets[0]?.id ?? '' }]);
  const addRepo = () => onChange([...blocks, { id: localId('b_'), type: 'github_repo', repo: '' }]);

  return (
    <div className="space-y-3">
      {blocks.length === 0 && <p className="text-xs text-stone-500">No content yet. Add blocks below.</p>}
      {blocks.map((b, i) => (
        <div key={b.id} className={`rounded-xl border p-3 space-y-2 ${isCourseWidget(b) ? 'border-amber-400/30 bg-amber-400/5' : 'border-stone-800 bg-stone-950/60'}`}>
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-widest font-mono text-stone-400">{i + 1}. {WIDGET_LABELS[b.type] ?? b.type}</span>
            <span className="ml-auto" />
            <button type="button" className={btnCls} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move block ${i + 1} up`}><ArrowUp size={12} /></button>
            <button type="button" className={btnCls} disabled={i === blocks.length - 1} onClick={() => move(i, 1)} aria-label={`Move block ${i + 1} down`}><ArrowDown size={12} /></button>
            <button type="button" className={dangerCls} onClick={() => remove(b, i)} aria-label={`Delete block ${i + 1}`}><Trash2 size={12} /></button>
          </div>
          {b.type === 'quiz' ? <QuizWidgetForm block={b} onChange={nb => replace(b.id, nb)} />
            : b.type === 'course_media' ? <CourseMediaFields block={b} assets={assets} onChange={nb => replace(b.id, nb)} />
              : b.type === 'github_repo' ? <GithubRepoFields block={b} onChange={nb => replace(b.id, nb)} />
                : <ArticleBlockFields block={b as Block} onChange={nb => replace(b.id, nb)} onValidity={ok => setValidity(b.id, ok)} />}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-stone-700 p-3">
        <select className={`${inputCls} w-auto`} value={articleType} aria-label="Article block type"
          onChange={e => { const t = editorInternals.CREATABLE.find(x => x === e.target.value); if (t) setArticleType(t); }}>
          {editorInternals.CREATABLE.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button type="button" className={btnCls} onClick={addArticle}>+ Article block</button>
        <span className="text-stone-600">|</span>
        <button type="button" className={btnCls} onClick={() => onChange([...blocks, newQuizBlock()])}>+ Quiz</button>
        <button type="button" className={btnCls} onClick={addMedia}>+ Course media</button>
        <button type="button" className={btnCls} onClick={addRepo}>+ GitHub repo</button>
      </div>
    </div>
  );
}
