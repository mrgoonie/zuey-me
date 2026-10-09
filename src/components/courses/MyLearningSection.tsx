import { useEffect, useId, useState } from 'react';
import { alertError, btnGhost, fmtDate, isRecord, jsonBody, numOr, records, str, strOrNull } from '../members/member-ui';
import { courseApi } from './course-ui';

interface MyCourse { slug: string; title: string; cover_url: string | null; percent: number; completed: number; total: number }
interface Badge { id: string; name: string; description: string; awarded_at: string }
interface Cert { code: string; course_title: string; issued_at: string; revoked: boolean }
interface Learning { courses: MyCourse[]; xp: number; streak: number; longest: number; optOut: boolean; badges: Badge[]; certificates: Cert[] }

function parseLearning(v: unknown): Learning | null {
  if (!isRecord(v) || !Array.isArray(v.courses) || !isRecord(v.learner)) return null;
  const l = v.learner;
  return {
    courses: records(v.courses).map(c => {
      const p = isRecord(c.progress) ? c.progress : {};
      return { slug: str(c, 'slug'), title: str(c, 'title'), cover_url: strOrNull(c, 'cover_url'), percent: numOr(p, 'percent'), completed: numOr(p, 'completed_lessons'), total: numOr(p, 'total_lessons') };
    }),
    xp: numOr(l, 'xp'), streak: numOr(l, 'current_streak'), longest: numOr(l, 'longest_streak'), optOut: l.leaderboard_opt_out === true,
    badges: records(l.badges).map(b => ({ id: str(b, 'id'), name: str(b, 'name'), description: str(b, 'description'), awarded_at: str(b, 'awarded_at') })),
    certificates: records(v.certificates).map(c => ({ code: str(c, 'code'), course_title: str(c, 'course_title'), issued_at: str(c, 'issued_at'), revoked: c.revoked === true })),
  };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="text-lg font-bold tabular-nums">{value}</dd>
    </div>
  );
}

/** "Khoá học của tôi" in /account: owned courses with progress, XP, streak, badges, certificates and the leaderboard opt-out. */
export function MyLearningSection() {
  const [data, setData] = useState<Learning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const optId = useId();

  useEffect(() => {
    void courseApi('/api/v1/me/learning', { cache: 'no-store' }).then(res => {
      const parsed = res.ok ? parseLearning(res.data) : null;
      if (parsed) setData(parsed); else setError(res.ok ? 'Phản hồi không hợp lệ.' : res.message);
    });
  }, []);

  async function toggleOptOut(optOut: boolean) {
    if (!data) return;
    setSaving(true); setError(null);
    const res = await courseApi('/api/v1/me/learning', { method: 'PATCH', body: jsonBody({ leaderboard_opt_out: optOut }) });
    setSaving(false);
    if (res.ok && isRecord(res.data) && typeof res.data.leaderboard_opt_out === 'boolean') {
      const saved = res.data.leaderboard_opt_out;
      setData(d => (d ? { ...d, optOut: saved } : d));
    } else setError(res.ok ? 'Phản hồi không hợp lệ.' : res.message);
  }

  if (!data) {
    return <div role="status" aria-live="polite">{error ? <p className={alertError}>{error}</p> : <p className="text-sm text-stone-600">Đang tải…</p>}</div>;
  }

  return (
    <div className="grid gap-5">
      <dl className="grid grid-cols-3 gap-2">
        <Stat label="Tổng XP" value={data.xp.toLocaleString('vi-VN')} />
        <Stat label="Chuỗi hiện tại" value={`${data.streak} ngày`} />
        <Stat label="Chuỗi dài nhất" value={`${data.longest} ngày`} />
      </dl>

      {data.courses.length === 0 ? (
        <p className="text-sm text-stone-700">Bạn chưa sở hữu khoá học nào. <a className="font-semibold underline" href="/courses">Xem các khoá học</a></p>
      ) : (
        <ul className="grid gap-2">
          {data.courses.map(c => (
            <li key={c.slug}>
              <a href={`/courses/${c.slug}`} className="flex min-h-[44px] items-center gap-3 rounded-xl border border-stone-300 bg-white/70 px-3 py-2.5 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 min-w-0">
                {c.cover_url && <img src={c.cover_url} alt="" width={64} height={36} className="h-9 w-16 shrink-0 rounded-md object-cover bg-stone-900" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold break-words">{c.title}</span>
                  <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-stone-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.percent} aria-label={`Tiến độ ${c.title}`}>
                    <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${c.percent}%` }} />
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-stone-600">{c.completed}/{c.total}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {data.certificates.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Chứng chỉ</h3>
          <ul className="mt-2 grid gap-2 text-sm">
            {data.certificates.map(c => (
              <li key={c.code} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white/70 px-3 py-2 min-w-0">
                <span className="min-w-0 break-words">{c.course_title} <span className="text-stone-500">· {fmtDate(c.issued_at)}</span>{c.revoked && <span className="ml-1 font-semibold text-rose-700">(đã thu hồi)</span>}</span>
                <a className={`${btnGhost} min-h-[44px]`} href={`/certificates/${encodeURIComponent(c.code)}`}>Xem chứng chỉ</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.badges.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Huy hiệu</h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {data.badges.map(b => (
              <li key={b.id} className="rounded-full bg-amber-200 px-3 py-1 text-xs font-semibold" title={`${b.description} · ${fmtDate(b.awarded_at)}`}>
                {b.name}<span className="sr-only">: {b.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-2">
        <label htmlFor={optId} className="flex min-h-[44px] cursor-pointer items-start gap-3 text-sm">
          <input id={optId} type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-stone-900" checked={data.optOut} disabled={saving} onChange={e => { void toggleOptOut(e.target.checked); }} />
          <span>Ẩn tôi khỏi <a href="/courses/leaderboard" className="underline">bảng xếp hạng học viên</a> (tên luôn được rút gọn, ví dụ “Nguyễn A.”).</span>
        </label>
        <div role="status" aria-live="polite" className="empty:hidden">{error && <p className={alertError}>{error}</p>}</div>
      </div>
    </div>
  );
}
