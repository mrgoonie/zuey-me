import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { BlockRenderer } from '../blocks/BlockRenderer';
import { parseSurveyResults } from '../blocks/SurveyBlock';
import {
  BLOCK_TYPES, CALLOUT_TONES, CHART_KINDS, EMBED_PROVIDERS, LAYOUT_GAPS, LAYOUT_VARIANTS, LIMITS, emptyDocument,
} from '../../lib/blocks/schema';
import type {
  ArticleAccess, ArticleDocument, Block, BlockType, Breakpoint, LayoutBlock, LayoutChild, ResponsiveSpan, SurveyBlock,
} from '../../lib/blocks/schema';
import { validateDocument } from '../../lib/blocks/validate';
import type { ValidationError } from '../../lib/blocks/validate';
import type { SurveyResults } from '../../lib/blocks/survey';

// ---------- API helpers (typed narrowing, no casts) ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string): string => (typeof o[k] === 'string' ? String(o[k]) : '');

interface ArticleMeta {
  slug: string;
  title: string;
  excerpt: string;
  locale: string;
  access: ArticleAccess;
  tags: string[];
}

interface ArticleRow extends ArticleMeta {
  status: 'draft' | 'published';
  revision: number;
  updated_at: string;
  published_at: string | null;
  has_unpublished_changes: boolean;
}

function parseRow(v: unknown): ArticleRow | null {
  if (!isObj(v) || typeof v.slug !== 'string' || typeof v.revision !== 'number') return null;
  return {
    slug: v.slug,
    title: str(v, 'title'),
    excerpt: str(v, 'excerpt'),
    locale: str(v, 'locale') || 'vi',
    access: v.access === 'knowledges' ? 'knowledges' : 'free',
    tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : [],
    status: v.status === 'published' ? 'published' : 'draft',
    revision: v.revision,
    updated_at: str(v, 'updated_at'),
    published_at: typeof v.published_at === 'string' ? v.published_at : null,
    has_unpublished_changes: v.has_unpublished_changes === true,
  };
}

interface ApiResult { ok: boolean; status: number; data: unknown; code: string; message: string; error: Obj }

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    const body: unknown = await res.json().catch(() => null);
    const error = isObj(body) && isObj(body.error) ? body.error : {};
    return {
      ok: res.ok,
      status: res.status,
      data: isObj(body) ? body.data : null,
      code: str(error, 'code'),
      message: str(error, 'message') || (res.ok ? '' : `HTTP ${res.status}`),
      error,
    };
  } catch {
    return { ok: false, status: 0, data: null, code: 'network', message: 'Không kết nối được máy chủ', error: {} };
  }
}

function errorsFrom(error: Obj): ValidationError[] {
  if (!Array.isArray(error.errors)) return [];
  return error.errors.flatMap(e => (isObj(e) ? [{ path: str(e, 'path'), message: str(e, 'message') }] : []));
}

// ---------- Block factories ----------

const newId = () => 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);

const TYPE_LABELS: Record<BlockType, string> = {
  paragraph: 'Đoạn văn', heading: 'Tiêu đề', list: 'Danh sách', checklist: 'Checklist', quote: 'Trích dẫn',
  callout: 'Callout', code: 'Code', divider: 'Đường kẻ', image: 'Ảnh', embed: 'Nhúng (embed)', table: 'Bảng',
  chart: 'Biểu đồ', diagram: 'Sơ đồ Mermaid', survey: 'Khảo sát', layout: 'Bố cục (layout)',
};

function newBlock(type: BlockType): Block {
  const id = newId();
  switch (type) {
    case 'paragraph': return { id, type, text: '' };
    case 'heading': return { id, type, level: 2, text: 'Tiêu đề' };
    case 'list': return { id, type, style: 'bullet', items: ['Mục 1'] };
    case 'checklist': return { id, type, items: [{ text: 'Việc cần làm', checked: false }] };
    case 'quote': return { id, type, text: '' };
    case 'callout': return { id, type, tone: 'info', text: '' };
    case 'code': return { id, type, language: 'ts', code: '' };
    case 'divider': return { id, type };
    case 'image': return { id, type, url: 'https://', alt: '' };
    case 'embed': return { id, type, url: 'https://', provider: 'generic' };
    case 'table': return { id, type, headers: ['Cột 1', 'Cột 2'], rows: [['', '']] };
    case 'chart': return { id, type, kind: 'bar', title: '', labels: ['A', 'B', 'C'], series: [{ name: 'Series 1', data: [1, 2, 3] }] };
    case 'diagram': return { id, type, syntax: 'mermaid', source: 'graph TD\n  A[Start] --> B[End]' };
    case 'survey': return { id, type, question: 'Câu hỏi?', options: [{ id: 'o1', label: 'Lựa chọn 1' }, { id: 'o2', label: 'Lựa chọn 2' }], allowMultiple: false };
    case 'layout': return { id, type, variant: 'columns', cols: { base: 1, md: 2, lg: 3 }, gap: 'md', children: [{ blocks: [] }, { blocks: [] }] };
  }
}

// ---------- Small form controls ----------

const inputCls = 'w-full min-w-0 px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-xs text-white placeholder-stone-500 focus:outline-none focus:border-amber-400';
const btnCls = 'px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-stone-700 bg-stone-900 hover:bg-stone-800 text-stone-200 disabled:opacity-40';
const primaryCls = 'px-3.5 py-2 rounded-xl text-xs font-bold bg-amber-400 text-stone-950 hover:bg-amber-300 disabled:opacity-50';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="block text-[10px] uppercase tracking-widest text-stone-500 font-mono mb-1">{label}</span>
      {children}
    </label>
  );
}

function Text({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <Field label={label}><input className={inputCls} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></Field>;
}

function Area({ label, value, onChange, rows = 3, mono }: { label: string; value: string; onChange: (v: string) => void; rows?: number; mono?: boolean }) {
  return <Field label={label}><textarea className={`${inputCls} ${mono ? 'font-mono' : ''}`} rows={rows} value={value} onChange={e => onChange(e.target.value)} /></Field>;
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <Field label={label}>
      <select className={inputCls} value={value} onChange={e => { const v = options.find(o => o === e.target.value); if (v !== undefined) onChange(v); }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </Field>
  );
}

function NumberSelect({ label, value, min, max, onChange, allowEmpty }: { label: string; value: number | undefined; min: number; max: number; onChange: (v: number | undefined) => void; allowEmpty?: boolean }) {
  const opts = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <Field label={label}>
      <select className={inputCls} value={value === undefined ? '' : String(value)} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}>
        {allowEmpty && <option value="">–</option>}
        {opts.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </Field>
  );
}

/** Keeps the raw text locally so typing separators is not disrupted, committing parsed values on each change. */
function CsvInput({ label, initial, onCommit }: { label: string; initial: string; onCommit: (raw: string) => void }) {
  const [raw, setRaw] = useState(initial);
  return <Field label={label}><input className={inputCls} value={raw} onChange={e => { setRaw(e.target.value); onCommit(e.target.value); }} /></Field>;
}

const splitCsv = (raw: string): string[] => raw.split(',').map(s => s.trim());
const lines = (raw: string): string[] => raw.split('\n');

// ---------- Survey results (admin) ----------

function SurveyResultsView({ block, slug }: { block: SurveyBlock; slug: string }) {
  const [results, setResults] = useState<SurveyResults | null>(null);
  const [msg, setMsg] = useState('');
  const load = async () => {
    setMsg('Đang tải…');
    const res = await api(`/api/v1/surveys/${encodeURIComponent(block.id)}/results?article_slug=${encodeURIComponent(slug)}`);
    const parsed = res.ok ? parseSurveyResults(res.data) : null;
    setResults(parsed);
    setMsg(parsed ? '' : res.message || 'Không tải được kết quả (khảo sát cần được lưu trước).');
  };
  return (
    <div className="rounded-lg border border-stone-800 p-2.5 space-y-2">
      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" className={btnCls} onClick={load}>Xem kết quả</button>
        <a className={btnCls} href={`/api/v1/surveys/${encodeURIComponent(block.id)}/export.csv?article_slug=${encodeURIComponent(slug)}`}>Tải CSV</a>
        {msg && <span className="text-[11px] text-stone-400">{msg}</span>}
      </div>
      {results && (
        <ul className="text-[11px] text-stone-300 space-y-1">
          {results.options.map(o => <li key={o.id}>{o.label}: <b>{o.count}</b> ({o.percent}%)</li>)}
          <li className="text-stone-500">Tổng: {results.total_voters} người</li>
        </ul>
      )}
    </div>
  );
}

// ---------- Per-type block fields ----------

interface FieldsProps { block: Block; onChange: (b: Block) => void; layoutDepth: number; slug: string }

function LayoutFields({ block, onChange, layoutDepth, slug }: { block: LayoutBlock; onChange: (b: Block) => void; layoutDepth: number; slug: string }) {
  const setChild = (i: number, child: LayoutChild) => onChange({ ...block, children: block.children.map((c, j) => (j === i ? child : c)) });
  const spanOf = (child: LayoutChild, bp: Breakpoint): number | undefined => (typeof child.span === 'number' ? child.span : child.span?.[bp]);
  const setSpan = (i: number, bp: Breakpoint, v: number | undefined) => {
    const child = block.children[i];
    const current: ResponsiveSpan = typeof child.span === 'number' ? { base: child.span, md: child.span, lg: child.span } : { ...(child.span ?? {}) };
    if (v === undefined) delete current[bp]; else current[bp] = v;
    setChild(i, { ...child, span: current });
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Select label="Kiểu" value={block.variant} options={LAYOUT_VARIANTS} onChange={variant => onChange({ ...block, variant })} />
        <Select label="Khoảng cách" value={block.gap ?? 'md'} options={LAYOUT_GAPS} onChange={gap => onChange({ ...block, gap })} />
        {(['base', 'md', 'lg'] as const).map(bp => (
          <NumberSelect key={bp} label={`Cột ${bp}`} value={block.cols[bp]} min={1} max={LIMITS.layoutColsMax}
            onChange={v => onChange({ ...block, cols: { ...block.cols, [bp]: v ?? 1 } })} />
        ))}
      </div>
      {block.children.map((child, i) => (
        <div key={i} className="rounded-xl border border-dashed border-stone-700 p-2.5 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <span className="text-[11px] font-bold text-amber-300 mr-1">Ô {i + 1}</span>
            {(['base', 'md', 'lg'] as const).map(bp => (
              <div key={bp} className="w-20">
                <NumberSelect label={`Span ${bp}`} value={spanOf(child, bp)} min={1} max={block.cols[bp]} allowEmpty onChange={v => setSpan(i, bp, v)} />
              </div>
            ))}
            <div className="w-20">
              <NumberSelect label="Row span" value={child.rowSpan} min={1} max={LIMITS.layoutRowSpanMax} allowEmpty onChange={rowSpan => setChild(i, { ...child, rowSpan })} />
            </div>
            <button type="button" className={btnCls} disabled={block.children.length <= 1}
              onClick={() => onChange({ ...block, children: block.children.filter((_, j) => j !== i) })}>Xoá ô</button>
          </div>
          <BlockListEditor blocks={child.blocks} onChange={blocks => setChild(i, { ...child, blocks })} layoutDepth={layoutDepth + 1} slug={slug} />
        </div>
      ))}
      <button type="button" className={btnCls} disabled={block.children.length >= LIMITS.layoutChildren}
        onClick={() => onChange({ ...block, children: [...block.children, { blocks: [] }] })}>+ Thêm ô</button>
    </div>
  );
}

function BlockFields({ block, onChange, layoutDepth, slug }: FieldsProps) {
  switch (block.type) {
    case 'paragraph':
      return <Area label="Nội dung (**đậm**, *nghiêng*, `code`, [link](https://…))" value={block.text} onChange={text => onChange({ ...block, text })} rows={4} />;
    case 'heading':
      return (
        <div className="grid grid-cols-[5rem_1fr] gap-2">
          <NumberSelect label="Cấp" value={block.level} min={1} max={3} onChange={v => onChange({ ...block, level: v === 1 ? 1 : v === 3 ? 3 : 2 })} />
          <Text label="Tiêu đề" value={block.text} onChange={text => onChange({ ...block, text })} />
        </div>
      );
    case 'list':
      return (
        <div className="space-y-2">
          <Select label="Kiểu" value={block.style} options={['bullet', 'number'] as const} onChange={style => onChange({ ...block, style })} />
          <Area label="Mỗi dòng một mục" value={block.items.join('\n')} onChange={v => onChange({ ...block, items: lines(v) })} />
        </div>
      );
    case 'checklist':
      return (
        <Area label="Mỗi dòng một mục; bắt đầu bằng [x] nếu đã xong"
          value={block.items.map(i => `${i.checked ? '[x] ' : ''}${i.text}`).join('\n')}
          onChange={v => onChange({ ...block, items: lines(v).map(l => ({ checked: /^\[x\]\s?/i.test(l), text: l.replace(/^\[(x| )\]\s?/i, '') })) })} />
      );
    case 'quote':
      return (
        <div className="space-y-2">
          <Area label="Trích dẫn" value={block.text} onChange={text => onChange({ ...block, text })} />
          <Text label="Nguồn" value={block.cite ?? ''} onChange={cite => onChange({ ...block, cite: cite || undefined })} />
        </div>
      );
    case 'callout':
      return (
        <div className="space-y-2">
          <Select label="Sắc thái" value={block.tone} options={CALLOUT_TONES} onChange={tone => onChange({ ...block, tone })} />
          <Area label="Nội dung" value={block.text} onChange={text => onChange({ ...block, text })} />
        </div>
      );
    case 'code':
      return (
        <div className="space-y-2">
          <Text label="Ngôn ngữ" value={block.language} onChange={language => onChange({ ...block, language })} />
          <Area label="Code" value={block.code} onChange={code => onChange({ ...block, code })} rows={6} mono />
        </div>
      );
    case 'divider':
      return <p className="text-[11px] text-stone-500">Đường kẻ ngang.</p>;
    case 'image':
      return (
        <div className="space-y-2">
          <Text label="URL ảnh (https://)" value={block.url} onChange={url => onChange({ ...block, url })} />
          <Text label="Alt (mô tả cho trình đọc màn hình)" value={block.alt} onChange={alt => onChange({ ...block, alt })} />
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: caption || undefined })} />
        </div>
      );
    case 'embed':
      return (
        <div className="space-y-2">
          <Text label="URL (YouTube, Vimeo, Spotify, X, …)" value={block.url} onChange={url => onChange({ ...block, url })} />
          <Select label="Nhà cung cấp" value={block.provider} options={EMBED_PROVIDERS} onChange={provider => onChange({ ...block, provider })} />
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: caption || undefined })} />
        </div>
      );
    case 'table':
      return (
        <div className="space-y-2">
          <CsvInput label="Tiêu đề cột (phân cách bằng dấu phẩy)" initial={block.headers.join(', ')} onCommit={raw => onChange({ ...block, headers: splitCsv(raw) })} />
          <Area label="Hàng: mỗi dòng một hàng, các ô phân cách bằng |" value={block.rows.map(r => r.join(' | ')).join('\n')} rows={4}
            onChange={v => onChange({ ...block, rows: lines(v).map(l => l.split('|').map(c => c.trim())) })} />
        </div>
      );
    case 'chart':
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Select label="Loại" value={block.kind} options={CHART_KINDS} onChange={kind => onChange({ ...block, kind })} />
            <Text label="Tiêu đề" value={block.title ?? ''} onChange={title => onChange({ ...block, title: title || undefined })} />
          </div>
          <CsvInput label="Nhãn (phân cách bằng dấu phẩy)" initial={block.labels.join(', ')} onCommit={raw => onChange({ ...block, labels: splitCsv(raw) })} />
          {block.series.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-end">
              <Text label={`Series ${i + 1}`} value={s.name} onChange={name => onChange({ ...block, series: block.series.map((x, j) => (j === i ? { ...x, name } : x)) })} />
              <CsvInput label={`Số liệu (${block.labels.length} giá trị)`} initial={s.data.join(', ')}
                onCommit={raw => onChange({ ...block, series: block.series.map((x, j) => (j === i ? { ...x, data: splitCsv(raw).map(Number) } : x)) })} />
              <button type="button" className={btnCls} disabled={block.series.length <= 1}
                onClick={() => onChange({ ...block, series: block.series.filter((_, j) => j !== i) })}>Xoá</button>
            </div>
          ))}
          <button type="button" className={btnCls} disabled={block.series.length >= LIMITS.chartSeries}
            onClick={() => onChange({ ...block, series: [...block.series, { name: `Series ${block.series.length + 1}`, data: block.labels.map(() => 0) }] })}>+ Series</button>
        </div>
      );
    case 'diagram':
      return (
        <div className="space-y-2">
          <Area label="Mermaid" value={block.source} onChange={source => onChange({ ...block, source })} rows={6} mono />
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: caption || undefined })} />
        </div>
      );
    case 'survey':
      return (
        <div className="space-y-2">
          <Text label="Câu hỏi" value={block.question} onChange={question => onChange({ ...block, question })} />
          {block.options.map((o, i) => (
            <div key={o.id} className="flex gap-2 items-end">
              <div className="flex-1 min-w-0">
                <Text label={`Lựa chọn ${i + 1} (${o.id})`} value={o.label} onChange={label => onChange({ ...block, options: block.options.map(x => (x.id === o.id ? { ...x, label } : x)) })} />
              </div>
              <button type="button" className={btnCls} disabled={block.options.length <= LIMITS.surveyOptionsMin}
                onClick={() => onChange({ ...block, options: block.options.filter(x => x.id !== o.id) })}>Xoá</button>
            </div>
          ))}
          <div className="flex flex-wrap gap-3 items-center">
            <button type="button" className={btnCls} disabled={block.options.length >= LIMITS.surveyOptionsMax}
              onClick={() => {
                let n = block.options.length + 1;
                while (block.options.some(o => o.id === `o${n}`)) n += 1;
                onChange({ ...block, options: [...block.options, { id: `o${n}`, label: `Lựa chọn ${n}` }] });
              }}>+ Lựa chọn</button>
            <label className="text-[11px] text-stone-300 flex items-center gap-1.5">
              <input type="checkbox" checked={block.allowMultiple === true} onChange={e => onChange({ ...block, allowMultiple: e.target.checked })} />
              Cho chọn nhiều
            </label>
          </div>
          {slug && <SurveyResultsView block={block} slug={slug} />}
        </div>
      );
    case 'layout':
      return <LayoutFields block={block} onChange={onChange} layoutDepth={layoutDepth} slug={slug} />;
  }
}

// ---------- Block list editor (recursive for layouts) ----------

function BlockListEditor({ blocks, onChange, layoutDepth, slug }: { blocks: Block[]; onChange: (b: Block[]) => void; layoutDepth: number; slug: string }) {
  const allowed = BLOCK_TYPES.filter(t => t !== 'layout' || layoutDepth < LIMITS.layoutDepth);
  const [addType, setAddType] = useState<BlockType>('paragraph');
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2.5 min-w-0">
      {blocks.map((block, i) => (
        <div key={block.id} className="rounded-xl border border-stone-800 bg-stone-950/60 p-3 space-y-2.5 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-bold text-stone-200 mr-auto">{TYPE_LABELS[block.type]} <span className="text-stone-600 font-mono">#{block.id}</span></span>
            <button type="button" className={btnCls} aria-label="Lên" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className={btnCls} aria-label="Xuống" disabled={i === blocks.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className={`${btnCls} text-rose-300`} onClick={() => onChange(blocks.filter((_, j) => j !== i))}>Xoá</button>
          </div>
          <BlockFields block={block} layoutDepth={layoutDepth} slug={slug} onChange={b => onChange(blocks.map((x, j) => (j === i ? b : x)))} />
        </div>
      ))}
      <div className="flex gap-2 items-center">
        <select className={`${inputCls} max-w-[14rem]`} value={addType} aria-label="Loại block"
          onChange={e => { const t = allowed.find(x => x === e.target.value); if (t) setAddType(t); }}>
          {allowed.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
        </select>
        <button type="button" className={btnCls} onClick={() => onChange([...blocks, newBlock(addType)])}>+ Thêm block</button>
      </div>
    </div>
  );
}

// ---------- Panel ----------

interface Editing {
  originalSlug: string | null;
  meta: ArticleMeta;
  doc: ArticleDocument;
  revision: number;
  status: 'draft' | 'published';
  hasUnpublished: boolean;
}

const blankMeta = (): ArticleMeta => ({ slug: '', title: '', excerpt: '', locale: 'vi', access: 'free', tags: [] });

export function ArticlesPanel() {
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [listError, setListError] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [tab, setTab] = useState<'blocks' | 'preview' | 'json'>('blocks');
  const [jsonText, setJsonText] = useState('');
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [serverErrors, setServerErrors] = useState<ValidationError[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [tagsRaw, setTagsRaw] = useState('');

  const refresh = useCallback(async () => {
    const res = await api('/api/v1/articles?include_drafts=1');
    if (!res.ok || !Array.isArray(res.data)) { setListError(res.message || 'Không tải được danh sách'); return; }
    setListError('');
    setArticles(res.data.map(parseRow).filter((r): r is ArticleRow => r !== null));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const validation = useMemo(() => (editing ? validateDocument(editing.doc) : null), [editing]);
  const clientErrors = validation && !validation.ok ? validation.errors : [];

  const loadEditing = (data: unknown, originalSlug: string | null): boolean => {
    const row = parseRow(data);
    const docRes = isObj(data) ? validateDocument(data.document) : null;
    if (!row || !docRes?.ok) return false;
    setEditing({ originalSlug, meta: row, doc: docRes.doc, revision: row.revision, status: row.status, hasUnpublished: row.has_unpublished_changes });
    setTagsRaw(row.tags.join(', '));
    setJsonText(JSON.stringify(docRes.doc, null, 2));
    return true;
  };

  const open = async (slug: string) => {
    setStatus(null);
    setServerErrors([]);
    const res = await api(`/api/v1/articles/${encodeURIComponent(slug)}?draft=1`);
    if (!res.ok || !loadEditing(res.data, slug)) setStatus({ text: res.message || 'Không mở được bài viết', error: true });
  };

  const startNew = () => {
    setEditing({ originalSlug: null, meta: blankMeta(), doc: emptyDocument(), revision: 0, status: 'draft', hasUnpublished: true });
    setTagsRaw('');
    setJsonText(JSON.stringify(emptyDocument(), null, 2));
    setStatus(null);
    setServerErrors([]);
    setTab('blocks');
  };

  const setMeta = (patch: Partial<ArticleMeta>) => setEditing(e => (e ? { ...e, meta: { ...e.meta, ...patch } } : e));
  const setDoc = (doc: ArticleDocument) => setEditing(e => (e ? { ...e, doc } : e));

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setServerErrors([]);
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const payload = { ...editing.meta, tags, document: editing.doc };
    const res = editing.originalSlug
      ? await api(`/api/v1/articles/${encodeURIComponent(editing.originalSlug)}`, { method: 'PUT', body: JSON.stringify({ ...payload, expected_revision: editing.revision }) })
      : await api('/api/v1/articles', { method: 'POST', body: JSON.stringify(payload) });
    setBusy(false);
    if (res.ok && loadEditing(res.data, editing.meta.slug)) {
      setStatus({ text: 'Đã lưu bản nháp.', error: false });
      void refresh();
    } else if (res.code === 'revision_conflict') {
      setStatus({ text: `Xung đột phiên bản: bài đã được sửa ở nơi khác (revision hiện tại ${String(res.error.current_revision ?? '?')}). Hãy sao lưu JSON rồi mở lại bài.`, error: true });
    } else {
      setServerErrors(errorsFrom(res.error));
      setStatus({ text: res.message || 'Lưu thất bại', error: true });
    }
  };

  const publish = async () => {
    if (!editing?.originalSlug) return;
    setConfirmPublish(false);
    setBusy(true);
    const res = await api(`/api/v1/articles/${encodeURIComponent(editing.originalSlug)}/publish`, {
      method: 'POST', body: JSON.stringify({ expected_revision: editing.revision, confirm: true }),
    });
    setBusy(false);
    if (res.ok) {
      await open(editing.originalSlug);
      setStatus({ text: 'Đã xuất bản.', error: false });
      void refresh();
    } else {
      setStatus({ text: res.code === 'revision_conflict' ? 'Xung đột phiên bản; hãy lưu hoặc mở lại bài trước khi xuất bản.' : res.message, error: true });
    }
  };

  const remove = async () => {
    if (!editing?.originalSlug || !window.confirm(`Xoá bài "${editing.meta.title}"?`)) return;
    const res = await api(`/api/v1/articles/${encodeURIComponent(editing.originalSlug)}`, { method: 'DELETE' });
    if (res.ok) { setEditing(null); void refresh(); } else setStatus({ text: res.message, error: true });
  };

  const applyJson = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(jsonText); } catch { setServerErrors([{ path: '$', message: 'JSON không hợp lệ' }]); return; }
    const res = validateDocument(parsed);
    if (!res.ok) { setServerErrors(res.errors); return; }
    setServerErrors([]);
    setDoc(res.doc);
    setStatus({ text: 'Đã áp dụng JSON (chưa lưu).', error: false });
  };

  const errors = [...clientErrors, ...serverErrors];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 min-w-0">
      <aside className="space-y-2 min-w-0">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">Bài viết</h2>
          <button type="button" className={primaryCls} onClick={startNew}>+ Mới</button>
        </div>
        {listError && <p className="text-xs text-rose-400">{listError}</p>}
        <ul className="space-y-1.5">
          {articles.map(a => (
            <li key={a.slug}>
              <button type="button" onClick={() => void open(a.slug)}
                className={`w-full text-left rounded-xl border px-3 py-2 text-xs ${editing?.originalSlug === a.slug ? 'border-amber-400 bg-stone-900' : 'border-stone-800 bg-stone-950 hover:bg-stone-900'}`}>
                <span className="block font-semibold text-stone-100 truncate">{a.title || a.slug}</span>
                <span className="block text-[10px] text-stone-500 font-mono">
                  {a.status === 'published' ? (a.has_unpublished_changes ? 'đã xuất bản · có thay đổi' : 'đã xuất bản') : 'nháp'} · r{a.revision}{a.access === 'knowledges' ? ' · Knowledges' : ''}
                </span>
              </button>
            </li>
          ))}
          {articles.length === 0 && !listError && <li className="text-xs text-stone-500">Chưa có bài viết.</li>}
        </ul>
      </aside>

      {editing ? (
        <section className="space-y-4 min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <Text label="Tiêu đề" value={editing.meta.title} onChange={title => setMeta({ title })} />
            <Text label="Slug" value={editing.meta.slug} placeholder="vi-du-bai-viet" onChange={slug => setMeta({ slug: slug.toLowerCase() })} />
            <div className="sm:col-span-2"><Area label="Tóm tắt" value={editing.meta.excerpt} onChange={excerpt => setMeta({ excerpt })} rows={2} /></div>
            <Select label="Ngôn ngữ" value={editing.meta.locale === 'en' ? 'en' : 'vi'} options={['vi', 'en'] as const} onChange={locale => setMeta({ locale })} />
            <Select label="Quyền đọc" value={editing.meta.access} options={['free', 'knowledges'] as const} onChange={access => setMeta({ access })} />
            <div className="sm:col-span-2"><Text label="Tags (phân cách bằng dấu phẩy)" value={tagsRaw} onChange={setTagsRaw} /></div>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            {(['blocks', 'preview', 'json'] as const).map(t => (
              <button key={t} type="button" onClick={() => { setTab(t); if (t === 'json') setJsonText(JSON.stringify(editing.doc, null, 2)); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === t ? 'bg-amber-400 text-stone-950' : 'bg-stone-900 text-stone-300 border border-stone-700'}`}>
                {t === 'blocks' ? 'Blocks' : t === 'preview' ? 'Xem trước' : 'JSON'}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-stone-500 font-mono">r{editing.revision} · {editing.status}</span>
          </div>

          {tab === 'blocks' && <BlockListEditor blocks={editing.doc.blocks} onChange={blocks => setDoc({ version: 1, blocks })} layoutDepth={0} slug={editing.originalSlug ?? ''} />}
          {tab === 'preview' && (
            <div className="rounded-3xl bg-[#F5EFEB] p-4 sm:p-6 min-w-0 overflow-hidden">
              {validation?.ok ? <BlockRenderer doc={validation.doc} interactive={false} /> : <p className="text-sm text-rose-700">Sửa lỗi bên dưới để xem trước.</p>}
            </div>
          )}
          {tab === 'json' && (
            <div className="space-y-2">
              <textarea className={`${inputCls} font-mono`} rows={18} value={jsonText} onChange={e => setJsonText(e.target.value)} aria-label="Document JSON" />
              <button type="button" className={btnCls} onClick={applyJson}>Áp dụng JSON</button>
            </div>
          )}

          {errors.length > 0 && (
            <ul className="rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-[11px] text-rose-300 space-y-0.5 font-mono" aria-live="polite">
              {errors.slice(0, 20).map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}
            </ul>
          )}

          <div className="flex flex-wrap gap-2 items-center border-t border-stone-800 pt-3">
            <button type="button" className={primaryCls} disabled={busy || clientErrors.length > 0} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu nháp'}</button>
            <button type="button" className={btnCls} disabled={busy || !editing.originalSlug} onClick={() => setConfirmPublish(true)}>Xuất bản…</button>
            {editing.originalSlug && <a className={btnCls} href={`/articles/${editing.originalSlug}?preview=1`} target="_blank" rel="noreferrer">Xem trên trang</a>}
            {editing.originalSlug && <button type="button" className={`${btnCls} text-rose-300`} onClick={() => void remove()}>Xoá bài</button>}
            {status && <span className={`text-xs ${status.error ? 'text-rose-400' : 'text-emerald-400'}`} role="status">{status.text}</span>}
          </div>

          {confirmPublish && (
            <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="publish-title">
              <div className="w-full max-w-sm rounded-2xl border border-stone-700 bg-stone-950 p-5 space-y-3">
                <h3 id="publish-title" className="text-sm font-bold text-white">Xuất bản “{editing.meta.title}”?</h3>
                <p className="text-xs text-stone-400">
                  Bản nháp đã lưu (revision {editing.revision}) sẽ thay thế bản công khai. Thay đổi chưa lưu sẽ không được xuất bản.
                  {editing.meta.access === 'knowledges' ? ' Người chưa có gói Knowledges chỉ thấy khoảng 1/3 đầu bài.' : ''}
                </p>
                <div className="flex justify-end gap-2">
                  <button type="button" className={btnCls} onClick={() => setConfirmPublish(false)}>Huỷ</button>
                  <button type="button" className={primaryCls} onClick={() => void publish()} autoFocus>Xuất bản</button>
                </div>
              </div>
            </div>
          )}
        </section>
      ) : (
        <section className="rounded-2xl border border-dashed border-stone-800 p-8 text-center text-sm text-stone-500">
          Chọn một bài viết hoặc tạo bài mới.
        </section>
      )}
    </div>
  );
}

export default ArticlesPanel;
