import { useState } from 'react';
import { alertError, btnGhost, btnPrimary, isRecord, loginUrl, numOr, str } from '../members/member-ui';
import { courseApi, lessonApiBase } from './course-ui';

interface Completion { xp: number; streak: number; percent: number; completed: number; total: number; certificateUrl: string | null }

function parseCompletion(v: unknown): Completion | null {
  if (!isRecord(v) || !isRecord(v.progress)) return null;
  const cert = isRecord(v.certificate) ? v.certificate : null;
  const code = cert ? str(cert, 'code') : '';
  return {
    xp: numOr(v, 'xp_awarded'), streak: numOr(v, 'streak'),
    percent: numOr(v.progress, 'percent'), completed: numOr(v.progress, 'completed_lessons'), total: numOr(v.progress, 'total_lessons'),
    certificateUrl: code ? `/certificates/${encodeURIComponent(code)}` : null,
  };
}

interface Props {
  courseSlug: string;
  lessonSlug: string;
  signedIn: boolean;
  initiallyCompleted: boolean;
  nextHref: string | null;
}

/** "Hoàn thành bài học": records progress, then shows XP gained, the streak and a certificate link when the course is done. */
export function LessonCompleteButton({ courseSlug, lessonSlug, signedIn, initiallyCompleted, nextHref }: Props) {
  const [done, setDone] = useState(initiallyCompleted);
  const [result, setResult] = useState<Completion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = `/courses/${courseSlug}/${lessonSlug}`;

  if (!signedIn) {
    return <p className="text-sm text-stone-700"><a className="font-semibold underline" href={loginUrl(here)}>Đăng nhập</a> để lưu tiến độ, nhận XP và chứng chỉ.</p>;
  }

  async function complete() {
    if (busy) return;
    setBusy(true); setError(null);
    const res = await courseApi(`${lessonApiBase(courseSlug, lessonSlug)}/complete`, { method: 'POST', body: '{}' });
    setBusy(false);
    const parsed = res.ok ? parseCompletion(res.data) : null;
    if (parsed) { setResult(parsed); setDone(true); return; }
    if (!res.ok && res.status === 401) { window.location.assign(loginUrl(here)); return; }
    setError(res.ok ? 'Phản hồi không hợp lệ từ máy chủ.' : res.message);
  }

  return (
    <div className="grid gap-3">
      <p className="flex flex-wrap gap-2">
        {done && !result
          ? <span className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-emerald-100 border border-emerald-300 px-4 text-sm font-semibold text-emerald-900">✓ Đã hoàn thành</span>
          : !done && <button type="button" className={`${btnPrimary} min-h-[44px]`} onClick={() => { void complete(); }} disabled={busy}>{busy ? 'Đang lưu…' : 'Hoàn thành bài học'}</button>}
        {done && nextHref && <a className={`${result ? btnPrimary : btnGhost} min-h-[44px]`} href={nextHref}>Bài tiếp theo →</a>}
      </p>
      <div role="status" aria-live="polite" className="grid gap-2 empty:hidden">
        {error && <p className={alertError}>{error}</p>}
        {result && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-950">
            <p>
              <strong>Hoàn thành!</strong>{result.xp > 0 ? <> Bạn nhận <strong>+{result.xp} XP</strong>.</> : ' Bài này đã được tính XP trước đó.'}
              {result.streak > 0 && <> Chuỗi học: <strong>{result.streak} ngày</strong> liên tiếp.</>}
            </p>
            <p className="mt-1 tabular-nums">Tiến độ khoá học: {result.completed}/{result.total} bài ({result.percent}%).</p>
            {result.certificateUrl && (
              <p className="mt-2"><a className="font-semibold underline" href={result.certificateUrl}>Bạn đã hoàn thành khoá học — xem chứng chỉ</a></p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
