import { useCallback, useEffect, useState } from 'react';
import type { Locale } from '../../lib/i18n/locales';
import {
  Area, Field, NamesFields, Select, StatusLine, Text, api, btnCls, cardCls, compactNames, dangerCls, displayName, formatTime, inputCls,
  isObj, namesOf, num, objArr, primaryCls, str, strArr, strOrNull, tabCls,
} from './knowledge-studio-kit';
import type { Obj, StatusMsg } from './knowledge-studio-kit';

type Names = Partial<Record<Locale, string>>;
type Extra = 'aliases' | 'position' | 'kind' | 'description' | 'version' | 'approve';

const EDITABLE_KINDS = ['domain', 'tool', 'model', 'workflow', 'mindset', 'extension'] as const;
type EditableKind = (typeof EDITABLE_KINDS)[number];

interface Row {
  id: string;
  slug: string;
  names: Names;
  revision: number;
  aliases: string[];
  position: number;
  kind: string;
  description: string;
  version: string | null;
  approved: boolean;
  builtin: boolean;
  articleCount: number | null;
}

function parseRow(o: Obj): Row {
  return {
    id: str(o, 'id'), slug: str(o, 'slug'), names: namesOf(o.names), revision: num(o, 'revision', 1), aliases: strArr(o.aliases),
    position: num(o, 'position'), kind: str(o, 'kind'), description: str(o, 'description'), version: strOrNull(o, 'version'),
    approved: o.approved !== false, builtin: o.builtin === true, articleCount: typeof o.article_count === 'number' ? o.article_count : null,
  };
}

interface Form { names: Names; slug: string; aliases: string; position: string; kind: EditableKind; description: string; version: string; approve: boolean }

const blankForm = (): Form => ({ names: {}, slug: '', aliases: '', position: '0', kind: 'domain', description: '', version: '', approve: false });
const formFrom = (r: Row): Form => ({
  names: r.names, slug: r.slug, aliases: r.aliases.join(', '), position: String(r.position),
  kind: EDITABLE_KINDS.find(k => k === r.kind) ?? 'domain', description: r.description, version: r.version ?? '', approve: r.approved,
});

interface SectionConfig { title: string; noun: string; endpoint: string; extras: Extra[] }

function bodyFrom(form: Form, cfg: SectionConfig, original: Row | null): Obj {
  const body: Obj = { names: compactNames(form.names) };
  const slug = form.slug.trim();
  if (slug && (!original || slug !== original.slug)) body.slug = slug;
  if (cfg.extras.includes('aliases')) body.aliases = form.aliases.split(',').map(s => s.trim()).filter(Boolean);
  if (cfg.extras.includes('position')) body.position = Number(form.position) || 0;
  if (cfg.extras.includes('kind') && !original) body.kind = form.kind;
  if (cfg.extras.includes('description')) body.description = form.description.trim();
  if (cfg.extras.includes('version')) body.version = form.version.trim() || null;
  if (cfg.extras.includes('approve') && form.approve && (!original || !original.approved)) body.approve = true;
  return body;
}

function EntityForm({ cfg, form, onChange, original }: { cfg: SectionConfig; form: Form; onChange: (f: Form) => void; original: Row | null }) {
  const set = (patch: Partial<Form>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-2">
      <NamesFields value={form.names} onChange={names => set({ names })} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {cfg.extras.includes('kind') && !original && (
          <Select label="Nhóm" value={form.kind} options={EDITABLE_KINDS} onChange={kind => set({ kind })} />
        )}
        <Field label="Slug (để trống = tự tạo)">
          <input className={inputCls} value={form.slug} disabled={original?.builtin === true} onChange={e => set({ slug: e.target.value.toLowerCase() })} />
        </Field>
        {cfg.extras.includes('aliases') && <Text label="Bí danh (phẩy)" value={form.aliases} onChange={aliases => set({ aliases })} />}
        {cfg.extras.includes('position') && <Text label="Thứ tự" type="number" value={form.position} onChange={position => set({ position })} />}
        {cfg.extras.includes('version') && <Text label="Phiên bản (tuỳ chọn)" value={form.version} onChange={version => set({ version })} />}
      </div>
      {cfg.extras.includes('description') && <Area label="Mô tả" value={form.description} onChange={description => set({ description })} rows={2} />}
      {cfg.extras.includes('approve') && (form.kind === 'extension' || original?.kind === 'extension') && (
        <label className="text-[11px] text-stone-300 flex items-center gap-1.5">
          <input type="checkbox" checked={form.approve} disabled={original?.approved === true} onChange={e => set({ approve: e.target.checked })} />
          Duyệt nhãn mở rộng (cho phép dùng công khai)
        </label>
      )}
    </div>
  );
}

function TaxonomySection({ cfg }: { cfg: SectionConfig }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [creating, setCreating] = useState<Form | null>(null);
  const [editing, setEditing] = useState<{ row: Row; form: Form } | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    const res = await api(cfg.endpoint);
    if (!res.ok) { setStatus({ text: res.message || `Không tải được ${cfg.noun}`, error: true }); setRows([]); return; }
    setRows(objArr(res.data).map(parseRow));
  }, [cfg.endpoint, cfg.noun]);
  useEffect(() => { void load(); }, [load]);

  const itemUrl = (r: Row) => `${cfg.endpoint}/${encodeURIComponent(r.id)}`;

  const create = async () => {
    if (!creating) return;
    const res = await api(cfg.endpoint, { method: 'POST', body: bodyFrom(creating, cfg, null) });
    if (res.ok) { setCreating(null); setStatus({ text: `Đã tạo ${cfg.noun}.`, error: false }); await load(); } else setStatus({ text: res.message, error: true });
  };
  const update = async () => {
    if (!editing) return;
    const res = await api(itemUrl(editing.row), { method: 'PUT', body: { ...bodyFrom(editing.form, cfg, editing.row), expected_revision: editing.row.revision } });
    if (res.ok) { setEditing(null); setStatus({ text: `Đã cập nhật ${cfg.noun}.`, error: false }); await load(); }
    else setStatus({ text: res.code === 'revision_conflict' ? `${cfg.noun} vừa được sửa ở nơi khác — tải lại rồi sửa tiếp.` : res.message, error: true });
  };
  const remove = async (r: Row) => {
    const usage = r.articleCount ? ` (đang dùng ở ${r.articleCount} bài)` : '';
    if (!window.confirm(`Xoá ${cfg.noun} “${displayName(r.names, r.slug)}”${usage}?`)) return;
    const res = await api(`${itemUrl(r)}?expected_revision=${r.revision}`, { method: 'DELETE' });
    if (res.ok) { setStatus({ text: `Đã xoá ${cfg.noun}.`, error: false }); await load(); } else setStatus({ text: res.message, error: true });
  };

  const q = query.trim().toLowerCase();
  const visible = (rows ?? []).filter(r => !q || [r.slug, r.kind, ...Object.values(r.names), ...r.aliases].some(v => v?.toLowerCase().includes(q)));

  return (
    <section className="space-y-3 min-w-0" aria-label={cfg.title}>
      <div className="flex flex-wrap gap-2 items-center">
        <input className={`${inputCls} max-w-xs`} type="search" placeholder={`Tìm ${cfg.noun}`} aria-label={`Tìm ${cfg.noun}`} value={query} onChange={e => setQuery(e.target.value)} />
        <button type="button" className={primaryCls} onClick={() => setCreating(c => (c ? null : blankForm()))}>{creating ? 'Đóng' : `+ ${cfg.noun}`}</button>
        <button type="button" className={btnCls} onClick={() => void load()}>Tải lại</button>
        <StatusLine status={status} />
      </div>
      {creating && (
        <div className={`${cardCls} space-y-2`}>
          <EntityForm cfg={cfg} form={creating} onChange={setCreating} original={null} />
          <button type="button" className={primaryCls} onClick={() => void create()}>Tạo</button>
        </div>
      )}
      {rows === null && <p className="text-xs text-stone-500">Đang tải…</p>}
      {rows !== null && visible.length === 0 && <p className="text-xs text-stone-500">Không có {cfg.noun} nào.</p>}
      <ul className="space-y-1.5">
        {visible.map(r => (
          <li key={r.id} className={`${cardCls} space-y-2`}>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <b className="text-stone-100">{displayName(r.names, r.slug)}</b>
              <span className="font-mono text-stone-500">{r.kind ? `${r.kind}:` : ''}{r.slug}</span>
              {r.version && <span className="text-stone-400">v{r.version}</span>}
              {r.builtin && <span className="px-1 rounded bg-stone-800 text-stone-400">có sẵn</span>}
              {!r.approved && <span className="px-1 rounded bg-amber-900/60 text-amber-300">chưa duyệt</span>}
              {r.aliases.length > 0 && <span className="text-stone-500 truncate max-w-[14rem]">≈ {r.aliases.join(', ')}</span>}
              {r.articleCount !== null && <span className="text-stone-500">{r.articleCount} bài</span>}
              <span className="ml-auto flex gap-1.5">
                <button type="button" className={btnCls} aria-expanded={editing?.row.id === r.id}
                  onClick={() => setEditing(e => (e?.row.id === r.id ? null : { row: r, form: formFrom(r) }))}>{editing?.row.id === r.id ? 'Đóng' : 'Sửa'}</button>
                {!r.builtin && <button type="button" className={dangerCls} onClick={() => void remove(r)}>Xoá</button>}
              </span>
            </div>
            {editing?.row.id === r.id && (
              <div className="space-y-2 border-t border-stone-800 pt-2">
                <EntityForm cfg={cfg} form={editing.form} onChange={form => setEditing({ row: r, form })} original={r} />
                <button type="button" className={primaryCls} onClick={() => void update()}>Lưu</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface LogEntry { id: string; actor: string; action: string; target_type: string; target_id: string; reason: string; created_at: string }

function AuditLog() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api('/api/v1/taxonomy/audit-log?limit=100').then(res => {
      if (!res.ok) { setError(res.message || 'Không tải được nhật ký'); setEntries([]); return; }
      setEntries(objArr(res.data).filter(isObj).map(e => ({
        id: str(e, 'id'), actor: str(e, 'actor'), action: str(e, 'action'), target_type: str(e, 'target_type'),
        target_id: str(e, 'target_id'), reason: str(e, 'reason'), created_at: str(e, 'created_at'),
      })));
    });
  }, []);
  return (
    <section className="space-y-2" aria-label="Nhật ký phân loại">
      {error && <p className="text-xs text-rose-400" role="alert">{error}</p>}
      {entries === null && <p className="text-xs text-stone-500">Đang tải…</p>}
      {entries?.length === 0 && !error && <p className="text-xs text-stone-500">Chưa có thay đổi nào.</p>}
      <ul className="divide-y divide-stone-800 rounded-xl border border-stone-800">
        {entries?.map(e => (
          <li key={e.id} className="px-3 py-2 text-[11px] text-stone-300 flex flex-wrap gap-2">
            <span className="font-mono text-amber-300">{e.action}</span>
            <span className="font-mono text-stone-400 truncate max-w-[14rem]">{e.target_type}:{e.target_id}</span>
            <span className="text-stone-500">{e.actor} · {formatTime(e.created_at)}</span>
            {e.reason && <span className="text-stone-400">“{e.reason}”</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const SECTIONS: Record<'tags' | 'categories' | 'labels', SectionConfig> = {
  tags: { title: 'Tags', noun: 'tag', endpoint: '/api/v1/taxonomy/tags', extras: ['aliases'] },
  categories: { title: 'Danh mục', noun: 'danh mục', endpoint: '/api/v1/taxonomy/categories', extras: ['position'] },
  labels: { title: 'Nhãn', noun: 'nhãn', endpoint: '/api/v1/taxonomy/labels', extras: ['kind', 'description', 'version', 'approve'] },
};

/** Admin vocabulary management: topic tags, categories, typed labels, and the taxonomy audit log. */
export function TaxonomyManager() {
  const [tab, setTab] = useState<'tags' | 'categories' | 'labels' | 'log'>('tags');
  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Loại phân loại">
        {([['tags', 'Tags'], ['categories', 'Danh mục'], ['labels', 'Nhãn'], ['log', 'Nhật ký']] as const).map(([t, label]) => (
          <button key={t} type="button" className={tabCls(tab === t)} aria-pressed={tab === t} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      {tab === 'log' ? <AuditLog /> : <TaxonomySection key={tab} cfg={SECTIONS[tab]} />}
    </div>
  );
}
