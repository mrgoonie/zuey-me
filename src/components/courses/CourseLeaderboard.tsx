import { useEffect, useState } from 'react';
import { alertError, card, isRecord, numOr, records, str } from '../members/member-ui';
import { courseApi } from './course-ui';

type Period = 'month' | 'all';
interface Entry { rank: number; name: string; xp: number; is_me: boolean }

function parseEntries(v: unknown): Entry[] | null {
  if (!isRecord(v) || !Array.isArray(v.entries)) return null;
  return records(v.entries).map(r => ({ rank: numOr(r, 'rank'), name: str(r, 'name') || 'Ẩn danh', xp: numOr(r, 'xp'), is_me: r.is_me === true }));
}

const TABS: Array<{ id: Period; label: string }> = [{ id: 'month', label: 'Tháng này' }, { id: 'all', label: 'Mọi thời điểm' }];

/** XP leaderboard with month / all-time tabs. Names arrive masked; learners who opted out are not listed. */
export function CourseLeaderboard() {
  const [period, setPeriod] = useState<Period>('month');
  const [data, setData] = useState<Partial<Record<Period, Entry[]>>>({});
  const [error, setError] = useState<string | null>(null);
  const entries = data[period];

  useEffect(() => {
    if (data[period]) return;
    let cancelled = false;
    setError(null);
    void courseApi(`/api/v1/courses/leaderboard?period=${period}`, { cache: 'no-store' }).then(res => {
      if (cancelled) return;
      const parsed = res.ok ? parseEntries(res.data) : null;
      if (parsed) setData(prev => ({ ...prev, [period]: parsed }));
      else setError(res.ok ? 'Phản hồi không hợp lệ.' : res.message);
    });
    return () => { cancelled = true; };
  }, [period, data]);

  function onTabKey(e: { key: string; preventDefault(): void }) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next: Period = period === 'month' ? 'all' : 'month';
    setPeriod(next);
    document.getElementById(`lb-tab-${next}`)?.focus();
  }

  return (
    <section className={card} aria-labelledby="lb-title">
      <h1 id="lb-title" className="text-2xl sm:text-3xl font-bold font-serif">Bảng xếp hạng học viên</h1>
      <p className="mt-1 text-sm text-stone-600">XP nhận được khi hoàn thành bài học, vượt qua quiz, giữ chuỗi ngày học và hoàn thành khoá học. Tên được rút gọn để bảo vệ quyền riêng tư; bạn có thể ẩn mình trong <a href="/account#learning" className="underline">Tài khoản</a>.</p>
      <div role="tablist" aria-label="Khoảng thời gian" className="mt-5 grid grid-cols-2 gap-1 rounded-full bg-white/70 p-1 border border-stone-200 max-w-[360px]">
        {TABS.map(t => (
          <button
            key={t.id} id={`lb-tab-${t.id}`} type="button" role="tab" aria-selected={period === t.id} aria-controls="lb-panel" tabIndex={period === t.id ? 0 : -1}
            onClick={() => setPeriod(t.id)} onKeyDown={onTabKey}
            className={`min-h-[44px] rounded-full px-3 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${period === t.id ? 'bg-stone-900 text-amber-50' : 'text-stone-700 hover:bg-white'}`}
          >{t.label}</button>
        ))}
      </div>
      <div id="lb-panel" role="tabpanel" aria-labelledby={`lb-tab-${period}`} className="mt-4" aria-live="polite" aria-busy={!entries && !error}>
        {error && <p className={alertError}>{error}</p>}
        {!entries && !error && <p className="text-sm text-stone-600">Đang tải…</p>}
        {entries && entries.length === 0 && <p className="text-sm text-stone-600">Chưa có ai trên bảng xếp hạng {period === 'month' ? 'tháng này' : ''}. Hoàn thành một bài học để mở màn!</p>}
        {entries && entries.length > 0 && (
          <ol className="grid gap-1.5">
            {entries.map(e => (
              <li key={`${e.rank}-${e.name}`} className={`flex min-h-[44px] items-center gap-3 rounded-xl border px-3 py-2 ${e.is_me ? 'border-amber-400 bg-amber-50' : 'border-stone-200 bg-white/70'}`}>
                <span className={`w-8 shrink-0 text-center font-bold tabular-nums ${e.rank <= 3 ? 'text-amber-700' : 'text-stone-500'}`}>{e.rank}</span>
                <span className="min-w-0 flex-1 break-words font-medium">{e.name}{e.is_me && <span className="ml-2 rounded-full bg-stone-900 px-2 py-0.5 text-[10px] font-bold text-amber-50">Bạn</span>}</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">{e.xp.toLocaleString('vi-VN')} XP</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
