import { useState } from 'react';
import type { FormEvent } from 'react';
import type { CourseLevel, CourseLocale, CourseRecord, CourseStatus } from '../../../lib/courses/course-types';
import { Area, Field, Select, StatusLine, Text, api, inputCls, isObj, primaryCls } from '../knowledge-studio-kit';
import type { StatusMsg } from '../knowledge-studio-kit';
import type { PlanDiscounts, PlanId } from './courses-admin-api';
import {
  ADMIN_COURSES, COURSE_LEVELS, COURSE_LOCALES, COURSE_STATUSES, PLAN_IDS, coursePath, dollarsToCents, errText, parseCourse,
} from './courses-admin-api';

/** Form state: everything as the admin types it; converted to the API body on submit. */
interface CourseDraft {
  title: string; slug: string; status: CourseStatus; price: string; level: CourseLevel; locale: CourseLocale;
  subtitle: string; summary: string; cover_url: string; outcomes: string; github_repos: string; release_note: string;
  position: string; overrideDiscounts: boolean; discounts: Partial<Record<PlanId, string>>;
}

function draftOf(c: CourseRecord | null): CourseDraft {
  const discounts: Partial<Record<PlanId, string>> = {};
  for (const p of PLAN_IDS) if (typeof c?.plan_discounts?.[p] === 'number') discounts[p] = String(c.plan_discounts[p]);
  return {
    title: c?.title ?? '', slug: c?.slug ?? '', status: c?.status ?? 'draft',
    price: c ? (c.price_usd_cents / 100).toString() : '0', level: c?.level ?? 'beginner', locale: c?.locale ?? 'vi',
    subtitle: c?.subtitle ?? '', summary: c?.summary ?? '', cover_url: c?.cover_url ?? '',
    outcomes: (c?.outcomes ?? []).join('\n'), github_repos: (c?.github_repos ?? []).join('\n'), release_note: c?.release_note ?? '',
    position: String(c?.position ?? 0), overrideDiscounts: c?.plan_discounts !== null && c?.plan_discounts !== undefined, discounts,
  };
}

const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean);

/** Builds the request body or returns a human error for fields the browser can check. */
function bodyOf(d: CourseDraft): { body: Record<string, unknown> } | { error: string } {
  const price = dollarsToCents(d.price);
  if (price === null) return { error: 'Price must be a dollar amount like 49 or 49.99' };
  const position = Number(d.position);
  if (!Number.isInteger(position)) return { error: 'Position must be an integer' };
  let planDiscounts: PlanDiscounts | null = null;
  if (d.overrideDiscounts) {
    planDiscounts = {};
    for (const p of PLAN_IDS) {
      const raw = d.discounts[p]?.trim();
      if (!raw) continue;
      const pct = Number(raw);
      if (!Number.isInteger(pct) || pct < 0 || pct > 90) return { error: `${p} discount must be an integer 0–90` };
      planDiscounts[p] = pct;
    }
  }
  return {
    body: {
      title: d.title, slug: d.slug.trim(), status: d.status, price_usd_cents: price, level: d.level, locale: d.locale,
      subtitle: d.subtitle, summary: d.summary, cover_url: d.cover_url.trim(), outcomes: lines(d.outcomes),
      github_repos: lines(d.github_repos), release_note: d.release_note, position, plan_discounts: planDiscounts,
    },
  };
}

/** Create (course = null) or edit a course's catalogue fields, price and discount override. */
export function CourseDetailsForm({ course, onSaved, effectiveDiscounts }: {
  course: CourseRecord | null;
  onSaved: (c: CourseRecord) => void;
  effectiveDiscounts?: PlanDiscounts;
}) {
  const [d, setD] = useState<CourseDraft>(() => draftOf(course));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const set = <K extends keyof CourseDraft>(k: K, v: CourseDraft[K]) => setD(prev => ({ ...prev, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = bodyOf(d);
    if ('error' in built) { setStatus({ text: built.error, error: true }); return; }
    setBusy(true);
    setStatus(null);
    const r = await api(course ? coursePath(course.id) : ADMIN_COURSES, { method: course ? 'PATCH' : 'POST', body: built.body });
    setBusy(false);
    if (!r.ok || !isObj(r.data)) { setStatus({ text: errText(r), error: true }); return; }
    const saved = parseCourse(r.data);
    setStatus({ text: course ? 'Saved.' : 'Course created.', error: false });
    if (!course) setD(draftOf(null));
    onSaved(saved);
  };

  return (
    <form onSubmit={e => void submit(e)} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Text label="Title" value={d.title} onChange={v => set('title', v)} />
        <Text label="Slug (a-z, 0-9, -)" value={d.slug} onChange={v => set('slug', v)} placeholder="ai-cho-nguoi-moi" />
        <Select label="Status" value={d.status} options={COURSE_STATUSES} onChange={v => set('status', v)} />
        <Text label="Price (USD)" value={d.price} onChange={v => set('price', v)} placeholder="49" />
        <Select label="Level" value={d.level} options={COURSE_LEVELS} onChange={v => set('level', v)} />
        <Select label="Locale" value={d.locale} options={COURSE_LOCALES} onChange={v => set('locale', v)} />
        <Text label="Cover URL (https://)" value={d.cover_url} onChange={v => set('cover_url', v)} />
        <Text label="Position" type="number" value={d.position} onChange={v => set('position', v)} />
      </div>
      <Text label="Subtitle" value={d.subtitle} onChange={v => set('subtitle', v)} />
      <Area label="Summary" value={d.summary} onChange={v => set('summary', v)} rows={4} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Area label="Outcomes (one per line)" value={d.outcomes} onChange={v => set('outcomes', v)} rows={4} />
        <Area label="GitHub repos (owner/repo, one per line)" value={d.github_repos} onChange={v => set('github_repos', v)} rows={4} mono />
      </div>
      <Text label="Release note" value={d.release_note} onChange={v => set('release_note', v)} placeholder="e.g. New chapter on agents" />

      <fieldset className="rounded-xl border border-stone-800 p-3 space-y-2">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-stone-500 font-mono">Subscriber discount</legend>
        <label className="flex items-center gap-2 text-xs text-stone-300">
          <input type="checkbox" checked={d.overrideDiscounts} onChange={e => set('overrideDiscounts', e.target.checked)} />
          Override the global plan discount table for this course (blank plan = global value)
        </label>
        {d.overrideDiscounts && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PLAN_IDS.map(p => (
              <Field key={p} label={`${p} %`}>
                <input className={inputCls} type="number" min={0} max={90} value={d.discounts[p] ?? ''}
                  placeholder={effectiveDiscounts?.[p] !== undefined ? String(effectiveDiscounts[p]) : ''}
                  onChange={e => set('discounts', { ...d.discounts, [p]: e.target.value })} />
              </Field>
            ))}
          </div>
        )}
        {effectiveDiscounts && (
          <p className="text-[11px] text-stone-500">
            Effective now: {PLAN_IDS.map(p => `${p} ${effectiveDiscounts[p] ?? 0}%`).join(' · ')}
          </p>
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" className={primaryCls} disabled={busy}>{busy ? 'Saving…' : course ? 'Save course' : 'Create course'}</button>
        <StatusLine status={status} />
      </div>
    </form>
  );
}
