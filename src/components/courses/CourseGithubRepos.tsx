import { useCallback, useEffect, useState } from 'react';
import { alertError, alertInfo, btnGhost, fmtDateTime, records, str, strOrNull } from '../members/member-ui';
import { courseApi } from './course-ui';

interface Invite { repo: string; action: string; status: string; github_login: string | null; last_error: string | null; updated_at: string }

function parseInvites(v: unknown): Invite[] | null {
  if (!Array.isArray(v)) return null;
  return records(v).map(r => ({
    repo: str(r, 'repo'), action: str(r, 'action'), status: str(r, 'status'),
    github_login: strOrNull(r, 'github_login'), last_error: strOrNull(r, 'last_error'), updated_at: str(r, 'updated_at'),
  }));
}

function statusCopy(i: Invite | undefined): { text: string; tone: 'ok' | 'wait' | 'warn' } {
  if (!i) return { text: 'Chưa gửi lời mời.', tone: 'warn' };
  if (i.action === 'remove') return { text: 'Quyền truy cập đã bị gỡ.', tone: 'warn' };
  if (i.status === 'done') return { text: `Đã mời${i.github_login ? ` @${i.github_login}` : ''}. Chấp nhận lời mời trong email GitHub hoặc tại github.com/notifications.`, tone: 'ok' };
  if (i.status === 'queued') return { text: 'Đang xếp hàng gửi lời mời (thường trong vài phút).', tone: 'wait' };
  if (i.status === 'skipped') return { text: 'Chưa có tài khoản GitHub liên kết.', tone: 'warn' };
  return { text: 'Gửi lời mời chưa thành công. Bấm “Gửi lại lời mời” hoặc email hi@zuey.me.', tone: 'warn' };
}

/** Private repositories of an owned course with the invite status and a resend button. */
export function CourseGithubRepos({ courseSlug, repos }: { courseSlug: string; repos: string[] }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const url = `/api/v1/courses/${encodeURIComponent(courseSlug)}/github-resync`;

  const load = useCallback(async () => {
    const res = await courseApi(url, { cache: 'no-store' });
    const parsed = res.ok ? parseInvites(res.data) : null;
    if (parsed) { setInvites(parsed); setError(null); } else setError(res.ok ? 'Phản hồi không hợp lệ.' : res.message);
  }, [url]);

  useEffect(() => { void load(); }, [load]);

  async function resend() {
    setBusy(true); setError(null); setOk(null);
    const res = await courseApi(url, { method: 'POST', body: '{}' });
    setBusy(false);
    const parsed = res.ok ? parseInvites(res.data) : null;
    if (parsed) { setInvites(parsed); setOk('Đã xếp hàng gửi lại lời mời. Trạng thái sẽ cập nhật trong vài phút.'); }
    else setError(res.ok ? 'Phản hồi không hợp lệ.' : res.message);
  }

  const needsGithub = invites?.some(i => i.status === 'skipped' || i.last_error === 'no_github_identity') ?? false;

  return (
    <div className="grid gap-3">
      <ul className="grid gap-2">
        {repos.map(repo => {
          const s = statusCopy(invites?.find(i => i.repo === repo));
          return (
            <li key={repo} className="rounded-xl border border-stone-300 bg-white/80 px-3 py-2.5 min-w-0">
              <a href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer" className="font-mono text-sm font-semibold underline break-all">{repo}</a>
              <p className={`mt-0.5 text-xs ${s.tone === 'ok' ? 'text-emerald-800' : s.tone === 'wait' ? 'text-stone-600' : 'text-amber-900'}`}>
                {invites === null && !error ? 'Đang tải trạng thái…' : s.text}
              </p>
            </li>
          );
        })}
      </ul>
      <div role="status" aria-live="polite" className="grid gap-2 empty:hidden">
        {needsGithub && (
          <p className={alertInfo}>Liên kết tài khoản GitHub tại <a href="/account#email" className="font-semibold underline">Tài khoản → Email & đăng nhập</a>, rồi quay lại đây bấm “Gửi lại lời mời”.</p>
        )}
        {error && <p className={alertError}>{error}</p>}
        {ok && <p className="text-xs text-emerald-800">{ok}</p>}
      </div>
      <p className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${btnGhost} min-h-[44px]`} onClick={() => { void resend(); }} disabled={busy}>{busy ? 'Đang gửi…' : 'Gửi lại lời mời'}</button>
        {invites && invites.length > 0 && <span className="text-xs text-stone-500">Cập nhật {fmtDateTime(invites.reduce((a, b) => (a > b.updated_at ? a : b.updated_at), ''))}</span>}
      </p>
    </div>
  );
}

