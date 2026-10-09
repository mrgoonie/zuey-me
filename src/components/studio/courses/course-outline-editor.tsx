import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { OutlineLesson, OutlineSection } from '../../../lib/courses/course-structure-store';
import { StatusLine, api, btnCls, dangerCls, inputCls, primaryCls } from '../knowledge-studio-kit';
import type { ApiResult, StatusMsg } from '../knowledge-studio-kit';
import { coursePath, errText, lessonPath } from './courses-admin-api';

type Positioned = { id: string; position: number };
type Run = (fn: () => Promise<ApiResult>, done?: string) => void;

/** Swaps two neighbours' positions (nudging when equal) so the order is explicit and stable. */
async function swap(a: Positioned, b: Positioned, dir: -1 | 1, url: (id: string) => string): Promise<ApiResult> {
  const r = await api(url(a.id), { method: 'PATCH', body: { position: a.position === b.position ? b.position + dir : b.position } });
  if (!r.ok) return r;
  return api(url(b.id), { method: 'PATCH', body: { position: a.position } });
}

function LessonRow({ lesson, index, siblings, section, sections, courseId, busy, run, onOpen }: {
  lesson: OutlineLesson; index: number; siblings: OutlineLesson[]; section: OutlineSection; sections: OutlineSection[];
  courseId: string; busy: boolean; run: Run; onOpen: (id: string) => void;
}) {
  const url = (id: string) => lessonPath(courseId, id);
  const move = (dir: -1 | 1) => { const other = siblings[index + dir]; if (other) run(() => swap(lesson, other, dir, url)); };
  return (
    <li className="flex flex-wrap items-center gap-1.5 py-1">
      <button type="button" className="text-left text-xs text-white hover:text-amber-300 flex-1 min-w-0 truncate" onClick={() => onOpen(lesson.id)}>
        {lesson.title} <span className="text-stone-500 font-mono">/{lesson.slug}</span>
      </button>
      {lesson.is_trial && <span className="px-1.5 py-0.5 rounded-md text-[10px] bg-sky-400/15 text-sky-300">học thử</span>}
      <span className={`px-1.5 py-0.5 rounded-md text-[10px] ${lesson.status === 'published' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-stone-800 text-stone-400'}`}>{lesson.status}</span>
      <button type="button" className={btnCls} disabled={busy || index === 0} onClick={() => move(-1)} aria-label={`Move ${lesson.title} up`}><ArrowUp size={12} /></button>
      <button type="button" className={btnCls} disabled={busy || index === siblings.length - 1} onClick={() => move(1)} aria-label={`Move ${lesson.title} down`}><ArrowDown size={12} /></button>
      <select className={`${inputCls} w-auto`} value={section.id} disabled={busy} aria-label={`Move ${lesson.title} to section`}
        onChange={e => run(() => api(url(lesson.id), { method: 'PATCH', body: { section_id: e.target.value } }), 'Lesson moved.')}>
        {sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
      </select>
    </li>
  );
}

function SectionCard({ section, index, sections, courseId, busy, run, onOpen }: {
  section: OutlineSection; index: number; sections: OutlineSection[]; courseId: string; busy: boolean; run: Run; onOpen: (id: string) => void;
}) {
  const [title, setTitle] = useState(section.title);
  const [newLesson, setNewLesson] = useState('');
  const [trial, setTrial] = useState(false);
  const url = (id: string) => `${coursePath(courseId)}/sections/${encodeURIComponent(id)}`;
  const move = (dir: -1 | 1) => { const other = sections[index + dir]; if (other) run(() => swap(section, other, dir, url)); };
  const lessons = [...section.lessons].sort((a, b) => a.position - b.position);

  const addLesson = (e: FormEvent) => {
    e.preventDefault();
    if (!newLesson.trim()) return;
    run(() => api(`${coursePath(courseId)}/lessons`, { method: 'POST', body: { section_id: section.id, title: newLesson.trim(), is_trial: trial } }), 'Lesson created.');
    setNewLesson('');
    setTrial(false);
  };

  return (
    <div className="rounded-xl border border-stone-800 bg-stone-950/60 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-mono text-stone-500">{index + 1}.</span>
        <input className={`${inputCls} flex-1`} value={title} onChange={e => setTitle(e.target.value)} aria-label={`Section ${index + 1} title`} />
        <button type="button" className={btnCls} disabled={busy || !title.trim() || title.trim() === section.title}
          onClick={() => run(() => api(url(section.id), { method: 'PATCH', body: { title: title.trim() } }), 'Section renamed.')}>Rename</button>
        <button type="button" className={btnCls} disabled={busy || index === 0} onClick={() => move(-1)} aria-label={`Move section ${index + 1} up`}><ArrowUp size={12} /></button>
        <button type="button" className={btnCls} disabled={busy || index === sections.length - 1} onClick={() => move(1)} aria-label={`Move section ${index + 1} down`}><ArrowDown size={12} /></button>
        <button type="button" className={dangerCls} disabled={busy || lessons.length > 0} aria-label={`Delete section ${index + 1}`}
          title={lessons.length ? 'Move or delete its lessons first' : 'Delete section'}
          onClick={() => { if (window.confirm(`Delete empty section "${section.title}"?`)) run(() => api(url(section.id), { method: 'DELETE' }), 'Section deleted.'); }}>
          <Trash2 size={12} />
        </button>
      </div>
      <ul className="pl-4 divide-y divide-stone-900">
        {lessons.map((l, i) => (
          <LessonRow key={l.id} lesson={l} index={i} siblings={lessons} section={section} sections={sections} courseId={courseId} busy={busy} run={run} onOpen={onOpen} />
        ))}
      </ul>
      <form onSubmit={addLesson} className="pl-4 flex flex-wrap items-center gap-1.5">
        <input className={`${inputCls} flex-1`} value={newLesson} onChange={e => setNewLesson(e.target.value)} placeholder="New lesson title" aria-label={`New lesson in ${section.title}`} />
        <label className="flex items-center gap-1 text-[11px] text-stone-300"><input type="checkbox" checked={trial} onChange={e => setTrial(e.target.checked)} />Học thử miễn phí</label>
        <button type="submit" className={btnCls} disabled={busy || !newLesson.trim()}>+ Lesson</button>
      </form>
    </div>
  );
}

/** Sections and lessons of a course: create, rename, reorder, move, delete empty sections. */
export function CourseOutlineEditor({ courseId, outline, onChanged, onOpenLesson }: {
  courseId: string; outline: OutlineSection[]; onChanged: () => Promise<void>; onOpenLesson: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [newSection, setNewSection] = useState('');
  const sections = [...outline].sort((a, b) => a.position - b.position);

  const run: Run = (fn, done) => {
    setBusy(true);
    setStatus(null);
    void fn().then(async r => {
      setStatus(r.ok ? (done ? { text: done, error: false } : null) : { text: errText(r), error: true });
      await onChanged();
      setBusy(false);
    });
  };

  const addSection = (e: FormEvent) => {
    e.preventDefault();
    if (!newSection.trim()) return;
    run(() => api(`${coursePath(courseId)}/sections`, { method: 'POST', body: { title: newSection.trim() } }), 'Section created.');
    setNewSection('');
  };

  return (
    <div className="space-y-3">
      {sections.length === 0 && <p className="text-xs text-stone-500">No sections yet. Lessons live inside sections: create one first.</p>}
      {sections.map((s, i) => (
        <SectionCard key={`${s.id}:${s.title}`} section={s} index={i} sections={sections} courseId={courseId} busy={busy} run={run} onOpen={onOpenLesson} />
      ))}
      <form onSubmit={addSection} className="flex items-center gap-2">
        <input className={`${inputCls} flex-1`} value={newSection} onChange={e => setNewSection(e.target.value)} placeholder="New section title" aria-label="New section title" />
        <button type="submit" className={primaryCls} disabled={busy || !newSection.trim()}>+ Section</button>
      </form>
      <StatusLine status={status} />
    </div>
  );
}
