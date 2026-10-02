import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LOCALES } from '../../lib/i18n/locales';
import type { Locale } from '../../lib/i18n/locales';
import {
  Field, StatusLine, api, btnCls, cardCls, dangerCls, formatTime, inputCls, isObj, issuesFrom, localeArr, localeOr, num, objArr,
  primaryCls, str, strArr, strOrNull, tabCls,
} from './knowledge-studio-kit';
import type { StatusMsg } from './knowledge-studio-kit';
import { AssignmentLine, assignmentTarget, parseAssignment, useLabelOptions } from './ArticleLabelsPanel';
import type { Assignment, LabelOption } from './ArticleLabelsPanel';

const STATUSES = ['pending', 'deferred', 'applied', 'rejected', 'stale'] as const;
type ProposalStatus = (typeof STATUSES)[number];
const STATUS_LABELS: Record<ProposalStatus, string> = { pending: 'Chờ duyệt', deferred: 'Hoãn', applied: 'Đã áp dụng', rejected: 'Đã từ chối', stale: 'Lỗi thời' };

interface Proposal {
  id: string;
  job_id: string | null;
  article_id: string;
  article_slug: string;
  article_title: string;
  locale: Locale;
  edition_revision: number;
  current_edition_revision: number | null;
  current_label_revision: number;
  before: Assignment[];
  proposed: Assignment[];
  questions: string[];
  rationale: string;
  status: ProposalStatus;
  outdated: boolean;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
}

function parseProposal(o: unknown): Proposal | null {
  if (!isObj(o) || typeof o.id !== 'string') return null;
  return {
    id: o.id, job_id: strOrNull(o, 'job_id'), article_id: str(o, 'article_id'), article_slug: str(o, 'article_slug'),
    article_title: str(o, 'article_title'), locale: localeOr(o.locale, 'vi'), edition_revision: num(o, 'edition_revision'),
    current_edition_revision: typeof o.current_edition_revision === 'number' ? o.current_edition_revision : null,
    current_label_revision: num(o, 'current_label_revision'),
    before: objArr(o.before).map(parseAssignment), proposed: objArr(o.proposed).map(parseAssignment),
    questions: strArr(o.questions), rationale: str(o, 'rationale'),
    status: STATUSES.find(s => s === o.status) ?? 'pending', outdated: o.outdated === true,
    decided_by: strOrNull(o, 'decided_by'), decided_at: strOrNull(o, 'decided_at'), decision_reason: strOrNull(o, 'decision_reason'),
    created_at: str(o, 'created_at'),
  };
}

const keyOf = (a: Assignment) => `${a.label_id}|${assignmentTarget(a)}`;

interface AuditJob {
  id: string;
  status: string;
  locales: Locale[];
  skip_unchanged: boolean;
  cursor: string;
  batch_size: number;
  processed: number;
  skipped: number;
  proposal_count: number;
  error_count: number;
  last_error: string | null;
  model: string;
  created_at: string;
}

function parseJob(o: unknown): AuditJob | null {
  if (!isObj(o) || typeof o.id !== 'string') return null;
  const scope = isObj(o.scope) ? o.scope : {};
  return {
    id: o.id, status: str(o, 'status'), locales: localeArr(scope.locales), skip_unchanged: scope.skip_unchanged === true,
    cursor: str(o, 'cursor'), batch_size: num(o, 'batch_size', 5), processed: num(o, 'processed'), skipped: num(o, 'skipped'),
    proposal_count: num(o, 'proposal_count'), error_count: num(o, 'error_count'), last_error: strOrNull(o, 'last_error'),
    model: str(o, 'model'), created_at: str(o, 'created_at'),
  };
}

const RUNNABLE = ['queued', 'paused', 'running'];

// ---------- Audit jobs ----------

function AuditJobs({ onProgress }: { onProgress: () => void }) {
  const [jobs, setJobs] = useState<AuditJob[]>([]);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [locales, setLocales] = useState<Locale[]>([...LOCALES]);
  const [skipUnchanged, setSkipUnchanged] = useState(true);
  const [batchSize, setBatchSize] = useState(5);
  const [running, setRunning] = useState<string | null>(null);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    const res = await api('/api/v1/taxonomy/audit-jobs');
    if (!res.ok) { setStatus({ text: res.message || 'Không tải được audit job', error: true }); return; }
    setJobs(objArr(res.data).map(parseJob).filter((j): j is AuditJob => j !== null).slice(0, 10));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (locales.length === 0) { setStatus({ text: 'Chọn ít nhất một ngôn ngữ', error: true }); return; }
    const res = await api('/api/v1/taxonomy/audit-jobs', { method: 'POST', body: { locales, skip_unchanged: skipUnchanged, batch_size: batchSize } });
    if (res.ok) { setStatus({ text: 'Đã tạo audit job. Bấm “Chạy” để xử lý theo lô.', error: false }); await load(); } else setStatus({ text: res.message, error: true });
  };

  /** Runs one batch, or keeps running batches until done, paused by an error, or stopped. */
  const run = async (job: AuditJob, all: boolean) => {
    stopRef.current = false;
    setRunning(job.id);
    let errors = job.error_count;
    try {
      for (;;) {
        const res = await api(`/api/v1/taxonomy/audit-jobs/${encodeURIComponent(job.id)}/run`, { method: 'POST' });
        if (!res.ok) {
          setStatus({
            text: res.code === 'ai_unavailable' ? 'Workers AI chưa được cấu hình (binding AI) — không thể chạy audit. Đề xuất thủ công vẫn dùng được.' : res.message,
            error: true,
          });
          break;
        }
        const updated = parseJob(res.data);
        onProgress();
        if (!updated) break;
        setJobs(list => list.map(j => (j.id === updated.id ? updated : j)));
        if (updated.error_count > errors) {
          setStatus({ text: `Job tạm dừng do lỗi: ${updated.last_error ?? 'không rõ'}. Chạy lại để thử tiếp từ con trỏ.`, error: true });
          break;
        }
        errors = updated.error_count;
        if (updated.status === 'completed') { setStatus({ text: `Hoàn tất: ${updated.processed} bản, ${updated.proposal_count} đề xuất.`, error: false }); break; }
        if (!all || stopRef.current || !RUNNABLE.includes(updated.status)) {
          setStatus({ text: `Đã xử lý lô; con trỏ: ${updated.cursor || '(đầu)'}.`, error: false });
          break;
        }
      }
    } finally {
      setRunning(null);
      await load();
    }
  };

  const cancel = async (job: AuditJob) => {
    if (!window.confirm('Huỷ audit job? Các đề xuất đã tạo vẫn được giữ để duyệt.')) return;
    const res = await api(`/api/v1/taxonomy/audit-jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
    if (res.ok) await load(); else setStatus({ text: res.message, error: true });
  };

  return (
    <section className={`${cardCls} space-y-3`} aria-labelledby="audit-jobs-title">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="audit-jobs-title" className="text-xs font-bold text-white">AI audit nhãn</h3>
        <span className="text-[11px] text-stone-500">Đọc bản đã xuất bản, tạo đề xuất để người duyệt — không tự áp dụng.</span>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <fieldset className="flex flex-wrap gap-2 items-center">
          <legend className="sr-only">Ngôn ngữ</legend>
          {LOCALES.map(l => (
            <label key={l} className="text-[11px] text-stone-300 flex items-center gap-1">
              <input type="checkbox" checked={locales.includes(l)} onChange={e => setLocales(list => (e.target.checked ? [...list, l] : list.filter(x => x !== l)))} />
              <span className="font-mono uppercase">{l}</span>
            </label>
          ))}
        </fieldset>
        <label className="text-[11px] text-stone-300 flex items-center gap-1.5">
          <input type="checkbox" checked={skipUnchanged} onChange={e => setSkipUnchanged(e.target.checked)} /> Bỏ qua bản chưa đổi
        </label>
        <div className="w-24">
          <Field label="Cỡ lô">
            <input className={inputCls} type="number" min={1} max={20} value={batchSize} onChange={e => setBatchSize(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
          </Field>
        </div>
        <button type="button" className={primaryCls} onClick={() => void create()}>Tạo audit job</button>
      </div>
      <StatusLine status={status} />
      {jobs.length === 0 && <p className="text-xs text-stone-500">Chưa có audit job.</p>}
      <ul className="space-y-1.5">
        {jobs.map(j => (
          <li key={j.id} className="rounded-lg border border-stone-800 px-3 py-2 text-[11px] text-stone-300 flex flex-wrap items-center gap-2">
            <span className="font-mono text-amber-300">{j.status}</span>
            <span>{j.processed} xử lý · {j.skipped} bỏ qua · {j.proposal_count} đề xuất · {j.error_count} lỗi</span>
            <span className="text-stone-500 font-mono truncate max-w-[14rem]" title={j.cursor}>con trỏ: {j.cursor || '(đầu)'}</span>
            <span className="text-stone-500">{j.locales.join(', ')} · {formatTime(j.created_at)}</span>
            {j.last_error && <span className="basis-full text-rose-300 break-words">Lỗi gần nhất: {j.last_error}</span>}
            {RUNNABLE.includes(j.status) && (
              <span className="ml-auto flex gap-1.5">
                {running === j.id
                  ? <button type="button" className={btnCls} onClick={() => { stopRef.current = true; }}>Dừng sau lô này</button>
                  : (
                    <>
                      <button type="button" className={btnCls} disabled={running !== null} onClick={() => void run(j, false)}>Chạy 1 lô</button>
                      <button type="button" className={btnCls} disabled={running !== null} onClick={() => void run(j, true)}>Chạy đến hết</button>
                      <button type="button" className={dangerCls} disabled={running !== null} onClick={() => void cancel(j)}>Huỷ</button>
                    </>
                  )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Proposal card ----------

function ProposalCard({ p, labels, onDecided }: { p: Proposal; labels: LabelOption[]; onDecided: (msg: StatusMsg) => void }) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(p.proposed.map((_, i) => i)));
  const [reason, setReason] = useState('');
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(p.proposed, null, 2));
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);

  const beforeKeys = new Set(p.before.map(keyOf));
  const proposedKeys = new Set(p.proposed.map(keyOf));
  const removed = p.before.filter(a => !proposedKeys.has(keyOf(a)));
  const open = p.status === 'pending' || p.status === 'deferred';

  const decide = async (decision: 'approve' | 'edit' | 'reject' | 'defer') => {
    let assignments: unknown;
    if (decision === 'edit' || decision === 'approve') {
      if (jsonMode) {
        try { assignments = JSON.parse(json); } catch { setIssues([{ path: '$', message: 'JSON không hợp lệ' }]); return; }
        decision = 'edit';
      } else if (selected.size !== p.proposed.length) {
        assignments = p.proposed.filter((_, i) => selected.has(i));
        decision = 'edit';
      }
    }
    setBusy(true);
    const apply = decision === 'approve' || decision === 'edit';
    const res = await api(`/api/v1/taxonomy/proposals/${encodeURIComponent(p.id)}/decision`, {
      method: 'POST',
      body: {
        decision, reason: reason.trim() || undefined,
        ...(apply ? { confirm: true, expected_label_revision: p.current_label_revision } : {}),
        ...(decision === 'edit' ? { assignments } : {}),
      },
    });
    setBusy(false);
    if (res.ok) {
      const already = isObj(res.data) && res.data.already_applied === true;
      onDecided({ text: already ? 'Đề xuất đã được áp dụng trước đó (không thay đổi gì).' : `Đã ${decision === 'reject' ? 'từ chối' : decision === 'defer' ? 'hoãn' : 'áp dụng'} đề xuất cho “${p.article_title}” (${p.locale}).`, error: false });
    } else if (res.code === 'label_revision_conflict') {
      onDecided({ text: 'Nhãn của bài vừa thay đổi — danh sách đã được tải lại, hãy xem lại đề xuất.', error: true });
    } else if (res.code === 'edition_changed') {
      onDecided({ text: 'Nội dung bản này đã đổi sau khi đề xuất; đề xuất chuyển sang lỗi thời. Hãy chạy audit mới.', error: true });
    } else {
      setIssues(issuesFrom(res.error));
      if (!issuesFrom(res.error).length) setIssues([{ path: res.code, message: res.message }]);
    }
  };

  return (
    <article className={`${cardCls} space-y-2`} aria-label={`Đề xuất cho bản ${p.locale}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono uppercase px-1.5 rounded bg-stone-800 text-stone-200">{p.locale}</span>
        <span className="text-stone-400">edition r{p.edition_revision}{p.current_edition_revision !== null && p.current_edition_revision !== p.edition_revision ? ` → r${p.current_edition_revision}` : ''}</span>
        <span className="text-stone-500">{p.job_id ? 'AI' : 'thủ công'} · {formatTime(p.created_at)}</span>
        <span className="ml-auto font-mono text-amber-300">{STATUS_LABELS[p.status]}</span>
      </div>
      {p.outdated && open && <p className="text-[11px] text-amber-300" role="note">Nội dung đã đổi sau đề xuất — không thể duyệt; hãy từ chối hoặc chạy audit mới.</p>}
      {p.rationale && <p className="text-[11px] text-stone-300">{p.rationale}</p>}
      {p.questions.length > 0 && (
        <ul className="text-[11px] text-sky-300 list-disc pl-4 space-y-0.5">{p.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
      )}

      {jsonMode ? (
        <textarea className={`${inputCls} font-mono`} rows={10} value={json} onChange={e => setJson(e.target.value)} aria-label="Nhãn đề xuất (JSON)" />
      ) : (
        <ul className="space-y-1">
          {p.proposed.length === 0 && <li className="text-[11px] text-stone-500">Đề xuất không có nhãn nào (sẽ xoá nhãn hiện có của phạm vi này).</li>}
          {p.proposed.map((a, i) => (
            <li key={i} className="flex items-start gap-2 text-[11px]">
              {open && (
                <input type="checkbox" aria-label="Giữ nhãn này" checked={selected.has(i)}
                  onChange={e => setSelected(s => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
              )}
              <span className={`shrink-0 font-mono ${beforeKeys.has(keyOf(a)) ? 'text-stone-500' : 'text-emerald-400'}`}>{beforeKeys.has(keyOf(a)) ? '=' : '+'}</span>
              <AssignmentLine a={a} labels={labels} />
            </li>
          ))}
          {removed.map((a, i) => (
            <li key={`r${i}`} className="flex items-start gap-2 text-[11px] opacity-80">
              <span className="shrink-0 font-mono text-rose-400">−</span>
              <AssignmentLine a={a} labels={labels} />
            </li>
          ))}
        </ul>
      )}

      {issues.length > 0 && (
        <ul className="text-[11px] text-rose-300 font-mono" role="alert">{issues.map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}</ul>
      )}

      {open && (
        <div className="flex flex-wrap gap-2 items-center pt-1">
          <input className={`${inputCls} flex-1 min-w-[10rem]`} placeholder="Lý do (tuỳ chọn)" aria-label="Lý do quyết định" value={reason} onChange={e => setReason(e.target.value)} />
          <button type="button" className={primaryCls} disabled={busy || p.outdated} onClick={() => void decide('approve')}>
            {jsonMode || selected.size !== p.proposed.length ? 'Áp dụng bản đã sửa' : 'Duyệt'}
          </button>
          <button type="button" className={btnCls} disabled={busy} aria-pressed={jsonMode} onClick={() => setJsonMode(m => !m)}>{jsonMode ? 'Danh sách' : 'Sửa JSON'}</button>
          {p.status === 'pending' && <button type="button" className={btnCls} disabled={busy} onClick={() => void decide('defer')}>Hoãn</button>}
          <button type="button" className={dangerCls} disabled={busy} onClick={() => void decide('reject')}>Từ chối</button>
        </div>
      )}
      {!open && p.decided_at && (
        <p className="text-[10px] text-stone-500">{p.decided_by} · {formatTime(p.decided_at)}{p.decision_reason ? ` · “${p.decision_reason}”` : ''}</p>
      )}
    </article>
  );
}

// ---------- Panel ----------

/** Admin review of AI/manual label proposals, grouped by article, plus resumable AI audit jobs. */
export function TaxonomyReviewPanel() {
  const labels = useLabelOptions();
  const [filter, setFilter] = useState<ProposalStatus>('pending');
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [status, setStatus] = useState<StatusMsg | null>(null);

  const load = useCallback(async () => {
    const res = await api(`/api/v1/taxonomy/proposals?status=${filter}`);
    if (!res.ok) { setStatus({ text: res.message || 'Không tải được đề xuất', error: true }); setProposals([]); return; }
    setProposals(objArr(res.data).map(parseProposal).filter((p): p is Proposal => p !== null));
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, { title: string; slug: string; items: Proposal[] }>();
    for (const p of proposals ?? []) {
      const g = map.get(p.article_id) ?? { title: p.article_title, slug: p.article_slug, items: [] };
      g.items.push(p);
      map.set(p.article_id, g);
    }
    return [...map.entries()].map(([id, g]) => ({ id, ...g, items: g.items.sort((a, b) => a.locale.localeCompare(b.locale)) }));
  }, [proposals]);

  const onDecided = (msg: StatusMsg) => { setStatus(msg); void load(); };

  return (
    <div className="space-y-4 min-w-0">
      <AuditJobs onProgress={() => { if (filter === 'pending') void load(); }} />
      <div className="flex flex-wrap gap-2 items-center" role="group" aria-label="Lọc theo trạng thái">
        {STATUSES.map(s => (
          <button key={s} type="button" className={tabCls(filter === s)} aria-pressed={filter === s} onClick={() => setFilter(s)}>{STATUS_LABELS[s]}</button>
        ))}
        <button type="button" className={`${btnCls} ml-auto`} onClick={() => void load()}>Tải lại</button>
      </div>
      <StatusLine status={status} />
      {proposals === null && <p className="text-xs text-stone-500">Đang tải…</p>}
      {proposals !== null && groups.length === 0 && (
        <p className="rounded-xl border border-dashed border-stone-800 p-6 text-center text-xs text-stone-500">Không có đề xuất ở trạng thái “{STATUS_LABELS[filter]}”.</p>
      )}
      {groups.map(g => (
        <section key={g.id} className="space-y-2" aria-label={g.title}>
          <h3 className="text-sm font-bold text-white flex flex-wrap items-baseline gap-2">
            {g.title || g.slug}
            <a className="text-[11px] font-normal text-amber-300 underline" href={`/articles/${encodeURIComponent(g.slug)}`} target="_blank" rel="noreferrer">/{g.slug}</a>
            <span className="text-[11px] font-normal text-stone-500">{g.items.length} đề xuất</span>
          </h3>
          {g.items.map(p => <ProposalCard key={`${p.id}-${p.current_label_revision}-${p.status}`} p={p} labels={labels} onDecided={onDecided} />)}
        </section>
      ))}
    </div>
  );
}
