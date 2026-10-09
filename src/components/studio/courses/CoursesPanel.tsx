import { useCallback, useEffect, useState } from 'react';
import type { CourseRecord } from '../../../lib/courses/course-types';
import { StatusLine, api, btnCls, objArr, tabCls } from '../knowledge-studio-kit';
import type { StatusMsg } from '../knowledge-studio-kit';
import { ADMIN_COURSES, errText, parseCourse, usd } from './courses-admin-api';
import { CourseAbuseReview } from './course-abuse-review';
import { CourseDetailsForm } from './course-details-form';
import { CourseDiscountSettings } from './course-discount-settings';
import { CourseOrdersReview } from './course-orders-review';
import { CourseWorkspace } from './course-workspace';

type View = 'courses' | 'orders' | 'abuse' | 'settings';
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'courses', label: 'Courses' }, { id: 'orders', label: 'Orders' }, { id: 'abuse', label: 'Abuse review' }, { id: 'settings', label: 'Discounts' },
];

const STATUS_STYLE: Record<CourseRecord['status'], string> = {
  draft: 'bg-stone-800 text-stone-400', published: 'bg-emerald-400/15 text-emerald-300', archived: 'bg-rose-500/15 text-rose-300',
};

function CourseList({ onOpen }: { onOpen: (id: string) => void }) {
  const [courses, setCourses] = useState<CourseRecord[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);

  const load = useCallback(async () => {
    const r = await api(ADMIN_COURSES);
    if (!r.ok) { setStatus({ text: errText(r), error: true }); setCourses([]); return; }
    setCourses(objArr(r.data).map(parseCourse));
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button type="button" className={btnCls} aria-expanded={creating} onClick={() => setCreating(!creating)}>{creating ? 'Close' : '+ New course'}</button>
        <StatusLine status={status} />
      </div>
      {creating && (
        <div className="rounded-xl border border-stone-800 p-3">
          <CourseDetailsForm course={null} onSaved={c => { setCreating(false); void load(); onOpen(c.id); }} />
        </div>
      )}
      {courses === null ? <p className="text-xs text-stone-400">Loading…</p> : courses.length === 0 ? <p className="text-xs text-stone-500">No courses yet.</p> : (
        <ul className="divide-y divide-stone-800">
          {courses.map(c => (
            <li key={c.id}>
              <button type="button" className="w-full text-left py-2.5 flex flex-wrap items-center gap-2 hover:bg-stone-900/60 rounded-lg px-2" onClick={() => onOpen(c.id)}>
                <span className="text-sm font-semibold text-white">{c.title}</span>
                <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${STATUS_STYLE[c.status]}`}>{c.status}</span>
                <span className="text-[11px] text-stone-500 font-mono">/{c.slug} · {c.locale} · {c.level} · #{c.position}</span>
                <span className="ml-auto text-xs text-amber-300 font-semibold">{usd(c.price_usd_cents)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Studio "Courses" tab: course authoring, course orders, anti-abuse review and the discount table. */
export function CoursesPanel() {
  const [view, setView] = useState<View>('courses');
  const [courseId, setCourseId] = useState<string | null>(null);
  const [listKey, setListKey] = useState(0);

  return (
    <section className="bg-stone-950/80 border border-stone-800 rounded-3xl p-5 sm:p-6 text-stone-100 space-y-4">
      <div>
        <h2 className="text-lg font-bold font-serif text-white">Courses</h2>
        <p className="text-xs text-stone-400 mt-1">One-time paid courses: sections, lessons (draft → publish), private media, owners and orders.</p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Courses areas">
        {VIEWS.map(v => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={tabCls(view === v.id)} onClick={() => setView(v.id)}>{v.label}</button>
        ))}
      </div>
      {view === 'courses' && (courseId
        ? <CourseWorkspace courseId={courseId} onBack={() => setCourseId(null)} onListChanged={() => setListKey(k => k + 1)} />
        : <CourseList key={listKey} onOpen={setCourseId} />)}
      {view === 'orders' && <CourseOrdersReview />}
      {view === 'abuse' && <CourseAbuseReview />}
      {view === 'settings' && <CourseDiscountSettings />}
    </section>
  );
}

export default CoursesPanel;
