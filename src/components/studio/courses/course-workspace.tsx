import { useCallback, useEffect, useState } from 'react';
import { StatusLine, api, btnCls, dangerCls, tabCls } from '../knowledge-studio-kit';
import type { StatusMsg } from '../knowledge-studio-kit';
import type { AdminCourseDetail } from './courses-admin-api';
import { coursePath, errText, parseCourseDetail, usd } from './courses-admin-api';
import { CourseAssetsManager } from './course-assets-manager';
import { CourseDetailsForm } from './course-details-form';
import { CourseOutlineEditor } from './course-outline-editor';
import { CourseOwnersManager } from './course-owners-manager';
import { LessonEditor } from './lesson-editor';

type Section = 'outline' | 'details' | 'assets' | 'owners';
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'outline', label: 'Outline & lessons' }, { id: 'details', label: 'Details & price' }, { id: 'assets', label: 'Assets' }, { id: 'owners', label: 'Owners' },
];

/** One course in Studio: outline + lesson editor, catalogue fields, media assets and owners. */
export function CourseWorkspace({ courseId, onBack, onListChanged }: { courseId: string; onBack: () => void; onListChanged: () => void }) {
  const [detail, setDetail] = useState<AdminCourseDetail | null>(null);
  const [section, setSection] = useState<Section>('outline');
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMsg | null>(null);

  const load = useCallback(async () => {
    const r = await api(coursePath(courseId));
    const d = r.ok ? parseCourseDetail(r.data) : null;
    if (d) setDetail(d); else setStatus({ text: errText(r) || 'Could not load the course', error: true });
  }, [courseId]);

  useEffect(() => { void load(); }, [load]);

  if (!detail) return <div className="text-xs text-stone-400">{status ? <StatusLine status={status} /> : 'Loading course…'}</div>;
  const { course } = detail;

  const remove = async () => {
    if (!window.confirm(`Delete course "${course.title}"? This is refused while anyone owns it (archive it instead).`)) return;
    const r = await api(coursePath(course.id), { method: 'DELETE' });
    if (!r.ok) { setStatus({ text: errText(r), error: true }); return; }
    onListChanged();
    onBack();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnCls} onClick={onBack}>← All courses</button>
        <h3 className="text-base font-bold text-white">{course.title}</h3>
        <span className="text-[11px] text-stone-500 font-mono">/{course.slug} · {course.status} · {usd(course.price_usd_cents)} · {detail.active_owners} owners</span>
        <a className={`${btnCls} ml-auto`} href={`/courses/${encodeURIComponent(course.slug)}`} target="_blank" rel="noopener noreferrer">View</a>
        <button type="button" className={dangerCls} onClick={() => void remove()}>Delete course</button>
      </div>
      <StatusLine status={status} />
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Course sections">
        {SECTIONS.map(s => (
          <button key={s.id} type="button" role="tab" aria-selected={section === s.id} className={tabCls(section === s.id)}
            onClick={() => { setSection(s.id); setLessonId(null); }}>{s.label}</button>
        ))}
      </div>

      {section === 'outline' && (lessonId ? (
        <LessonEditor courseId={course.id} courseSlug={course.slug} lessonId={lessonId} sections={detail.outline} assets={detail.assets}
          onChanged={() => void load()} onClose={() => setLessonId(null)} />
      ) : (
        <CourseOutlineEditor courseId={course.id} outline={detail.outline} onChanged={load} onOpenLesson={setLessonId} />
      ))}
      {section === 'details' && (
        <CourseDetailsForm key={course.updated_at} course={course} effectiveDiscounts={detail.effective_plan_discounts}
          onSaved={() => { void load(); onListChanged(); }} />
      )}
      {section === 'assets' && <CourseAssetsManager courseId={course.id} assets={detail.assets} onChanged={load} />}
      {section === 'owners' && <CourseOwnersManager courseId={course.id} onChanged={load} />}
    </div>
  );
}
