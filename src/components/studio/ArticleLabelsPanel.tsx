import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOCALES } from '../../lib/i18n/locales';
import type { Locale } from '../../lib/i18n/locales';
import {
  Field, Select, StatusLine, Text, api, btnCls, cardCls, dangerCls, displayName, formatTime, inputCls, isObj, issuesFrom,
  localeOr, namesOf, num, objArr, primaryCls, str, strOrNull,
} from './knowledge-studio-kit';
import type { Obj, StatusMsg } from './knowledge-studio-kit';

/** Label vocabulary entry as returned by GET /api/v1/taxonomy/labels. */
export interface LabelOption { id: string; key: string; kind: string; name: string; approved: boolean; builtin: boolean; version: string | null }

export function parseLabelOptions(data: unknown): LabelOption[] {
  return objArr(data).map(l => ({
    id: str(l, 'id'), kind: str(l, 'kind'), key: `${str(l, 'kind')}:${str(l, 'slug')}`,
    name: displayName(namesOf(l.names), str(l, 'slug')), approved: l.approved === true, builtin: l.builtin === true, version: strOrNull(l, 'version'),
  }));
}

export function useLabelOptions(): LabelOption[] {
  const [labels, setLabels] = useState<LabelOption[]>([]);
  useEffect(() => {
    void api('/api/v1/taxonomy/labels').then(res => { if (res.ok) setLabels(parseLabelOptions(res.data)); });
  }, []);
  return labels;
}

const SCOPES = ['article', 'locale', 'revision', 'block'] as const;
type Scope = (typeof SCOPES)[number];
const EVIDENCE_KEYS = ['source_url', 'source_title', 'retrieved_at', 'as_of', 'review_date', 'version_applicability', 'claim', 'note'] as const;
type EvidenceKey = (typeof EVIDENCE_KEYS)[number];
const EVIDENCE_LABELS: Record<EvidenceKey, string> = {
  source_url: 'Nguồn (https://)', source_title: 'Tên nguồn', retrieved_at: 'Ngày truy cập (YYYY-MM-DD)', as_of: 'Đúng tại ngày',
  review_date: 'Ngày cần xem lại', version_applicability: 'Áp dụng cho phiên bản', claim: 'Khẳng định', note: 'Ghi chú',
};

export interface Assignment {
  label_id: string;
  scope: Scope;
  locale?: Locale;
  edition_revision?: number;
  block_id?: string;
  evidence: Partial<Record<EvidenceKey, string>>;
}

export function parseAssignment(o: Obj): Assignment {
  const scope = SCOPES.find(s => s === o.scope) ?? 'article';
  const ev = isObj(o.evidence) ? o.evidence : {};
  const evidence: Partial<Record<EvidenceKey, string>> = {};
  for (const k of EVIDENCE_KEYS) if (typeof ev[k] === 'string' && ev[k]) evidence[k] = String(ev[k]);
  return {
    label_id: str(o, 'label_id'), scope,
    ...(typeof o.locale === 'string' ? { locale: localeOr(o.locale, 'vi') } : {}),
    ...(typeof o.edition_revision === 'number' ? { edition_revision: o.edition_revision } : {}),
    ...(typeof o.block_id === 'string' ? { block_id: o.block_id } : {}),
    evidence,
  };
}

export function assignmentTarget(a: Assignment): string {
  if (a.scope === 'article') return 'toàn bài';
  if (a.scope === 'locale') return `bản ${a.locale ?? '?'}`;
  if (a.scope === 'revision') return `${a.locale ?? '?'} r${a.edition_revision ?? '?'}`;
  return `${a.locale ?? '?'} r${a.edition_revision ?? '?'} · block ${a.block_id ?? '?'}`;
}

export function AssignmentLine({ a, labels }: { a: Assignment; labels: LabelOption[] }) {
  const label = labels.find(l => l.id === a.label_id);
  const ev = Object.entries(a.evidence).filter(([, v]) => v);
  return (
    <span className="min-w-0">
      <b className="text-stone-100">{label ? label.name : a.label_id}</b>{' '}
      <span className="font-mono text-stone-500">{label?.key ?? ''}</span>{' '}
      <span className="text-stone-400">· {assignmentTarget(a)}</span>
      {ev.length > 0 && (
        <span className="block text-[10px] text-stone-500 break-words">
          {ev.map(([k, v]) => `${k}: ${v}`).join(' · ')}
        </span>
      )}
    </span>
  );
}

interface HistoryRow { label_revision: number; count: number; source: string; actor: string; reason: string; created_at: string }

const emptyNew = (locale: Locale): Assignment => ({ label_id: '', scope: 'locale', locale, evidence: {} });

/** Admin label assignments for one article: edit with evidence, save as a new label revision, or revert. */
export function ArticleLabelsPanel({ slug, locale }: { slug: string; locale: Locale }) {
  const labels = useLabelOptions();
  const [labelRevision, setLabelRevision] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [saved, setSaved] = useState('');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [draft, setDraft] = useState<Assignment>(() => emptyNew(locale));
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api(`/api/v1/articles/${encodeURIComponent(slug)}/labels`);
    if (!res.ok || !isObj(res.data)) { setStatus({ text: res.message || 'Không tải được nhãn', error: true }); return; }
    const list = objArr(res.data.assignments).map(parseAssignment);
    setLabelRevision(num(res.data, 'label_revision'));
    setAssignments(list);
    setSaved(JSON.stringify(list));
    setHistory(objArr(res.data.history).map(h => ({
      label_revision: num(h, 'label_revision'), count: objArr(h.assignments).length, source: str(h, 'source'), actor: str(h, 'actor'),
      reason: str(h, 'reason'), created_at: str(h, 'created_at'),
    })));
    setIssues([]);
  }, [slug]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setDraft(d => ({ ...d, locale })); }, [locale]);

  const dirty = JSON.stringify(assignments) !== saved;
  const grouped = useMemo(() => {
    const kinds = Array.from(new Set(labels.map(l => l.kind)));
    return kinds.map(kind => ({ kind, items: labels.filter(l => l.kind === kind && l.approved) }));
  }, [labels]);

  const add = () => {
    if (!draft.label_id) { setStatus({ text: 'Chọn một nhãn', error: true }); return; }
    const a: Assignment = {
      label_id: draft.label_id, scope: draft.scope, evidence: Object.fromEntries(Object.entries(draft.evidence).filter(([, v]) => v && v.trim())),
      ...(draft.scope !== 'article' ? { locale: draft.locale ?? locale } : {}),
      ...(draft.scope === 'block' && draft.block_id ? { block_id: draft.block_id.trim() } : {}),
    };
    setAssignments(list => [...list, a]);
    setDraft(emptyNew(locale));
    setStatus(null);
  };

  const save = async () => {
    if (labelRevision === null) return;
    setBusy(true);
    const res = await api(`/api/v1/articles/${encodeURIComponent(slug)}/labels`, {
      method: 'PUT', body: { assignments, expected_label_revision: labelRevision, reason: reason.trim() || undefined },
    });
    setBusy(false);
    if (res.ok) {
      setReason('');
      await load();
      setStatus({ text: 'Đã lưu nhãn (revision mới).', error: false });
    } else if (res.code === 'label_revision_conflict') {
      setStatus({ text: 'Nhãn vừa được thay đổi ở nơi khác. Tải lại để xem bản mới nhất (thay đổi của bạn chưa được lưu).', error: true });
    } else {
      setIssues(issuesFrom(res.error));
      setStatus({ text: res.message || 'Lưu nhãn thất bại', error: true });
    }
  };

  const revert = async (to: number) => {
    if (labelRevision === null) return;
    if (dirty && !window.confirm('Bỏ các thay đổi chưa lưu?')) return;
    if (!window.confirm(`Khôi phục bộ nhãn ở revision ${to} (tạo revision mới)?`)) return;
    const res = await api(`/api/v1/articles/${encodeURIComponent(slug)}/labels/revert`, {
      method: 'POST', body: { to_label_revision: to, expected_label_revision: labelRevision, reason: `Khôi phục về r${to}` },
    });
    if (res.ok) { await load(); setStatus({ text: `Đã khôi phục về r${to}.`, error: false }); } else setStatus({ text: res.message, error: true });
  };

  const setEv = (k: EvidenceKey, v: string) => setDraft(d => ({ ...d, evidence: { ...d.evidence, [k]: v } }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold text-white">Nhãn hiện tại</h3>
        <span className="text-[11px] font-mono text-stone-500">label r{labelRevision ?? '…'}{dirty ? ' · chưa lưu' : ''}</span>
        <button type="button" className={`${btnCls} ml-auto`} onClick={() => void load()}>Tải lại</button>
      </div>
      {assignments.length === 0 && <p className="text-xs text-stone-500">Chưa có nhãn.</p>}
      <ul className="space-y-1.5">
        {assignments.map((a, i) => (
          <li key={`${a.label_id}-${i}`} className={`${cardCls} flex items-start gap-2 text-[11px] ${a.scope === 'article' || a.locale === locale ? '' : 'opacity-70'}`}>
            <AssignmentLine a={a} labels={labels} />
            <button type="button" className={`${dangerCls} ml-auto shrink-0`} onClick={() => setAssignments(list => list.filter((_, j) => j !== i))}>Bỏ</button>
          </li>
        ))}
      </ul>

      <fieldset className={`${cardCls} space-y-2`}>
        <legend className="text-[11px] font-bold text-amber-300 px-1">Thêm nhãn</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Field label="Nhãn">
            <select className={inputCls} value={draft.label_id} onChange={e => setDraft(d => ({ ...d, label_id: e.target.value }))}>
              <option value="">— Chọn —</option>
              {grouped.map(g => (
                <optgroup key={g.kind} label={g.kind}>
                  {g.items.map(l => <option key={l.id} value={l.id}>{l.name}{l.version ? ` (${l.version})` : ''}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Select label="Phạm vi" value={draft.scope} options={SCOPES}
            labels={{ article: 'Toàn bài', locale: 'Một ngôn ngữ', revision: 'Một revision', block: 'Một block' }}
            onChange={scope => setDraft(d => ({ ...d, scope }))} />
          {draft.scope !== 'article' && (
            <Select label="Ngôn ngữ" value={draft.locale ?? locale} options={LOCALES} onChange={l => setDraft(d => ({ ...d, locale: l }))} />
          )}
          {draft.scope === 'block' && <Text label="Block id" value={draft.block_id ?? ''} onChange={block_id => setDraft(d => ({ ...d, block_id }))} />}
        </div>
        <p className="text-[10px] text-stone-500">
          “Sự thật” (claim:fact) cần nguồn https và ngày (đúng tại / truy cập). Nhãn claim/freshness phải gắn theo ngôn ngữ, revision hoặc block.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {EVIDENCE_KEYS.map(k => <Text key={k} label={EVIDENCE_LABELS[k]} value={draft.evidence[k] ?? ''} onChange={v => setEv(k, v)} />)}
        </div>
        <button type="button" className={btnCls} onClick={add}>+ Thêm vào danh sách</button>
      </fieldset>

      {issues.length > 0 && (
        <ul className="rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-[11px] text-rose-300 font-mono" aria-live="polite">
          {issues.map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[12rem]"><Text label="Lý do thay đổi" value={reason} onChange={setReason} /></div>
        <button type="button" className={primaryCls} disabled={!dirty || busy || labelRevision === null} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu nhãn'}</button>
        <StatusLine status={status} />
      </div>

      <div className="space-y-1.5">
        <h3 className="text-xs font-bold text-white">Lịch sử nhãn</h3>
        {history.length === 0 && <p className="text-xs text-stone-500">Chưa có revision nhãn.</p>}
        <ul className="divide-y divide-stone-800 rounded-xl border border-stone-800">
          {history.map(h => (
            <li key={h.label_revision} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px] text-stone-300">
              <span className="font-mono text-amber-300">r{h.label_revision}</span>
              <span>{h.source}</span>
              <span>{h.count} nhãn</span>
              <span className="text-stone-500">{h.actor} · {formatTime(h.created_at)}</span>
              {h.reason && <span className="text-stone-400 truncate max-w-[16rem]">“{h.reason}”</span>}
              {h.label_revision !== labelRevision && (
                <button type="button" className={`${btnCls} ml-auto`} onClick={() => void revert(h.label_revision)}>Khôi phục</button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
