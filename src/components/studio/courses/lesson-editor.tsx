import { useCallback, useEffect, useState } from 'react';
import type { AdminLessonView } from '../../../lib/courses/course-admin-views';
import type { OutlineSection } from '../../../lib/courses/course-structure-store';
import type { AssetRecord } from '../../../lib/courses/course-types';
import type { LessonBlock } from '../../../lib/courses/lesson-blocks';
import { validateLessonDocument } from '../../../lib/courses/lesson-blocks';
import { Area, Field, StatusLine, Text, api, btnCls, dangerCls, inputCls, issuesFrom, primaryCls } from '../knowledge-studio-kit';
import type { StatusMsg } from '../knowledge-studio-kit';
import { errText, lessonPath, parseLessonView } from './courses-admin-api';
import { LessonBlockListEditor } from './lesson-block-list-editor';
import { LessonRawJsonEditor } from './lesson-raw-json-editor';

interface Meta { title: string; slug: string; summary: string; duration: string; is_trial: boolean; section_id: string; position: string }
const metaOf = (l: AdminLessonView): Meta => ({
  title: l.title, slug: l.slug, summary: l.summary, duration: String(l.duration_minutes), is_trial: l.is_trial, section_id: l.section_id, position: String(l.position),
});

/** Draft editing for one lesson: metadata, block document, save with revision guard, publish. */
export function LessonEditor({ courseId, courseSlug, lessonId, sections, assets, onChanged, onClose }: {
  courseId: string; courseSlug: string; lessonId: string; sections: OutlineSection[]; assets: AssetRecord[];
  onChanged: () => void; onClose: () => void;
}) {
  const [lesson, setLesson] = useState<AdminLessonView | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [blocks, setBlocks] = useState<LessonBlock[]>([]);
  const [dirty, setDirty] = useState(false);
  const [invalidIds, setInvalidIds] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const [conflict, setConflict] = useState<number | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [editorKey, setEditorKey] = useState(0);

  const adopt = (l: AdminLessonView) => {
    setLesson(l); setMeta(metaOf(l)); setBlocks(l.draft.blocks); setDirty(false); setInvalidIds(new Set()); setIssues([]); setConflict(null);
    setEditorKey(k => k + 1);
  };

  const load = useCallback(async () => {
    const r = await api(lessonPath(courseId, lessonId));
    const l = r.ok ? parseLessonView(r.data) : null;
    if (l) adopt(l); else setStatus({ text: errText(r) || 'Could not load the lesson', error: true });
  }, [courseId, lessonId]);

  useEffect(() => { void load(); }, [load]);

  if (!lesson || !meta) return <div className="text-xs text-stone-400">{status ? <StatusLine status={status} /> : 'Loading lesson…'}</div>;

  const setM = <K extends keyof Meta>(k: K, v: Meta[K]) => { setMeta({ ...meta, [k]: v }); setDirty(true); };
  const setDoc = (b: LessonBlock[]) => { setBlocks(b); setDirty(true); };

  const save = async (expectedRevision: number) => {
    if (invalidIds.size) { setStatus({ text: 'Fix the block JSON errors first.', error: true }); return; }
    const checked = validateLessonDocument({ version: 1, blocks });
    if (!checked.ok) { setIssues(checked.errors); setStatus({ text: 'The lesson document has errors.', error: true }); return; }
    const duration = Number(meta.duration);
    const position = Number(meta.position);
    if (!Number.isInteger(duration) || duration < 0 || duration > 1000) { setStatus({ text: 'Duration must be 0–1000 minutes.', error: true }); return; }
    if (!Number.isInteger(position)) { setStatus({ text: 'Position must be an integer.', error: true }); return; }
    setBusy(true); setStatus(null); setIssues([]);
    const r = await api(lessonPath(courseId, lesson.id), {
      method: 'PATCH',
      body: {
        title: meta.title, slug: meta.slug.trim(), summary: meta.summary, duration_minutes: duration, is_trial: meta.is_trial,
        section_id: meta.section_id, position, doc: checked.doc, expected_revision: expectedRevision,
      },
    });
    setBusy(false);
    if (r.code === 'revision_conflict') {
      setConflict(typeof r.error.revision === 'number' ? r.error.revision : lesson.revision + 1);
      setStatus({ text: 'Not saved: someone else changed this lesson.', error: true });
      return;
    }
    const l = r.ok ? parseLessonView(r.data) : null;
    if (!l) { setIssues(issuesFrom(r.error)); setStatus({ text: errText(r), error: true }); return; }
    adopt(l);
    setStatus({ text: `Saved (revision ${l.revision}).`, error: false });
    onChanged();
  };

  const publish = async (on: boolean) => {
    if (on && dirty) { setStatus({ text: 'Save your changes before publishing.', error: true }); return; }
    if (!on && !window.confirm('Unpublish this lesson? Readers lose access until you publish again (progress is kept).')) return;
    setBusy(true); setStatus(null);
    const r = await api(`${lessonPath(courseId, lesson.id)}/publish`, { method: on ? 'POST' : 'DELETE' });
    setBusy(false);
    const l = r.ok ? parseLessonView(r.data) : null;
    if (!l) { setStatus({ text: errText(r), error: true }); return; }
    adopt(l);
    setStatus({ text: on ? 'Published.' : 'Unpublished.', error: false });
    onChanged();
  };

  const remove = async () => {
    if (!window.confirm(`Delete lesson "${lesson.title}"? Its content and learner progress links are removed.`)) return;
    setBusy(true);
    const r = await api(lessonPath(courseId, lesson.id), { method: 'DELETE' });
    setBusy(false);
    if (!r.ok) { setStatus({ text: errText(r), error: true }); return; }
    onChanged();
    onClose();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnCls} onClick={onClose}>← Outline</button>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${lesson.status === 'published' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-stone-800 text-stone-400'}`}>{lesson.status}</span>
        {lesson.has_unpublished_changes && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-400/15 text-amber-300">has unpublished changes</span>}
        {dirty && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-400/15 text-sky-300">unsaved edits</span>}
        <span className="text-[11px] text-stone-500 font-mono">rev {lesson.revision}</span>
        <a className={`${btnCls} ml-auto`} href={`/courses/${encodeURIComponent(courseSlug)}/${encodeURIComponent(lesson.slug)}`} target="_blank" rel="noopener noreferrer">Preview</a>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Text label="Title" value={meta.title} onChange={v => setM('title', v)} />
        <Text label="Slug" value={meta.slug} onChange={v => setM('slug', v)} />
        <Field label="Section">
          <select className={inputCls} value={meta.section_id} onChange={e => setM('section_id', e.target.value)}>
            {sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Text label="Duration (min)" type="number" value={meta.duration} onChange={v => setM('duration', v)} />
          <Text label="Position" type="number" value={meta.position} onChange={v => setM('position', v)} />
        </div>
      </div>
      <Area label="Summary" value={meta.summary} rows={2} onChange={v => setM('summary', v)} />
      <label className="flex items-center gap-2 text-xs text-stone-200">
        <input type="checkbox" checked={meta.is_trial} onChange={e => setM('is_trial', e.target.checked)} />
        Học thử miễn phí (free trial lesson, readable by everyone)
      </label>

      <div className="flex items-center gap-2">
        <h4 className="text-xs font-bold text-white">Content (draft)</h4>
        <button type="button" className={`${btnCls} ml-auto`} aria-pressed={rawMode} onClick={() => setRawMode(!rawMode)}>{rawMode ? 'Block editor' : 'Raw JSON'}</button>
      </div>
      {rawMode
        ? <LessonRawJsonEditor blocks={blocks} onApply={b => { setDoc(b); setInvalidIds(new Set()); setEditorKey(k => k + 1); setRawMode(false); }} />
        : <LessonBlockListEditor key={editorKey} blocks={blocks} onChange={setDoc} assets={assets} invalidIds={invalidIds} onInvalidIds={setInvalidIds} />}

      {issues.length > 0 && (
        <ul className="rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-[11px] text-rose-200 space-y-0.5" role="alert">
          {issues.map((e, i) => <li key={i}><span className="font-mono">{e.path}</span> {e.message}</li>)}
        </ul>
      )}
      {conflict !== null && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-2" role="alert">
          <p>This lesson was saved elsewhere (now at revision {conflict}, you started from {lesson.revision}). Reload to see their version, or overwrite it with yours.</p>
          <div className="flex gap-2">
            <button type="button" className={btnCls} disabled={busy} onClick={() => { if (!dirty || window.confirm('Discard your unsaved edits and reload?')) void load(); }}>Reload (discard mine)</button>
            <button type="button" className={dangerCls} disabled={busy} onClick={() => { if (window.confirm('Overwrite the other version with yours?')) void save(conflict); }}>Overwrite</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 sticky bottom-0 bg-stone-950/95 py-2">
        <button type="button" className={primaryCls} disabled={busy || !dirty} onClick={() => void save(lesson.revision)}>{busy ? 'Working…' : 'Save draft'}</button>
        <button type="button" className={btnCls} disabled={busy || dirty || (lesson.status === 'published' && !lesson.has_unpublished_changes)} onClick={() => void publish(true)}>Publish</button>
        {lesson.status === 'published' && <button type="button" className={btnCls} disabled={busy} onClick={() => void publish(false)}>Unpublish</button>}
        <button type="button" className={`${dangerCls} ml-auto`} disabled={busy} onClick={() => void remove()}>Delete lesson</button>
        <StatusLine status={status} />
      </div>
    </div>
  );
}
