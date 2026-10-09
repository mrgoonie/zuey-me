import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { BlockRenderer } from '../blocks/BlockRenderer';
import { parseSurveyResults } from '../blocks/SurveyBlock';
import {
  BLOCK_TYPES, CALLOUT_TONES, CHART_KINDS, EMBED_PROVIDERS, LAYOUT_GAPS, LAYOUT_VARIANTS, LIMITS, emptyDocument,
} from '../../lib/blocks/schema';
import type {
  ArticleAccess, ArticleDocument, Block, BlockType, Breakpoint, GalleryImage, LayoutBlock, LayoutChild, ParagraphBlock,
  ResponsiveSpan, SurveyBlock, ToggleBlock,
} from '../../lib/blocks/schema';
import { recognizeEmbed } from '../../lib/blocks/embed';
import { formatBytes } from '../../lib/blocks/markdown';
import { validateDocument } from '../../lib/blocks/validate';
import type { ValidationError } from '../../lib/blocks/validate';
import type { SurveyResults } from '../../lib/blocks/survey';
import { LOCALES, LOCALE_LABELS } from '../../lib/i18n/locales';
import type { Locale } from '../../lib/i18n/locales';
import {
  Area, Field, Select, StatusLine, Text, api, btnCls, cardCls, dangerCls, displayName, formatTime, inputCls, isObj, issuesFrom,
  localeOr, namesOf, num, objArr, primaryCls, str, strArr, tabCls,
} from './knowledge-studio-kit';
import type { StatusMsg } from './knowledge-studio-kit';
import { ArticleLabelsPanel } from './ArticleLabelsPanel';
import { TaxonomyReviewPanel } from './TaxonomyReviewPanel';
import { TaxonomyManager } from './TaxonomyManager';

// ---------- Block catalogue ----------

const newId = () => 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);

/** Editor labels; block types without a label (added by other features) are edited in the JSON tab. */
const TYPE_LABELS: Partial<Record<BlockType, string>> = {
  paragraph: 'Đoạn văn', heading: 'Tiêu đề', list: 'Danh sách', checklist: 'Checklist', quote: 'Trích dẫn',
  callout: 'Callout', code: 'Code', divider: 'Đường kẻ', image: 'Ảnh', embed: 'Nhúng (YouTube, Spotify, X…)', table: 'Bảng',
  chart: 'Biểu đồ', diagram: 'Sơ đồ Mermaid', survey: 'Khảo sát', layout: 'Bố cục (cột/lưới)',
  math: 'Công thức (TeX)', gallery: 'Bộ sưu tập ảnh', audio: 'Âm thanh (file)', video: 'Video (file)', file: 'Tệp đính kèm',
  bookmark: 'Thẻ liên kết', toggle: 'Mục thu gọn',
  interactive: 'Tương tác (HTML/JS)',
};

/** Extra search words for the slash menu (unaccented). */
const TYPE_HINTS: Partial<Record<BlockType, string>> = {
  paragraph: 'text p van ban', heading: 'h1 h2 h3 title', list: 'ul ol bullet number', checklist: 'todo task',
  quote: 'blockquote', callout: 'note tip warn', code: 'snippet', divider: 'hr line', image: 'img picture anh',
  embed: 'youtube vimeo spotify soundcloud x twitter facebook instagram tiktok linkedin', table: 'grid', chart: 'bar line pie graph',
  diagram: 'mermaid flow', survey: 'poll vote', layout: 'columns grid bento', math: 'latex katex equation formula',
  gallery: 'images album', audio: 'mp3 podcast sound', video: 'mp4', file: 'pdf download attachment', bookmark: 'link card url',
  toggle: 'details collapse accordion',
};

const typeLabel = (t: BlockType): string => TYPE_LABELS[t] ?? t;

function newBlock(type: BlockType): Block | null {
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
    case 'interactive': return { id, type, title: 'Demo', html: '<p>Hello</p>', css: '', js: '' };
    case 'math': return { id, type, tex: 'E = mc^2' };
    case 'gallery': return { id, type, images: [{ url: 'https://', alt: '' }] };
    case 'audio': return { id, type, url: 'https://' };
    case 'video': return { id, type, url: 'https://' };
    case 'file': return { id, type, url: 'https://', name: 'tai-lieu.pdf' };
    case 'bookmark': return { id, type, url: 'https://' };
    case 'toggle': return { id, type, summary: 'Xem thêm', blocks: [] };
    default: return null;
  }
}

const CREATABLE: BlockType[] = BLOCK_TYPES.filter(t => TYPE_LABELS[t] !== undefined);

interface ListCtx { layoutDepth: number; inToggle: boolean; slug: string }

function allowedTypes(ctx: ListCtx): BlockType[] {
  return CREATABLE.filter(t => !(t === 'layout' && ctx.layoutDepth >= LIMITS.layoutDepth) && !(ctx.inToggle && (t === 'toggle' || t === 'layout')));
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase();

function matchTypes(allowed: BlockType[], query: string): BlockType[] {
  const q = fold(query.trim());
  if (!q) return allowed;
  return allowed.filter(t => fold(`${t} ${typeLabel(t)} ${TYPE_HINTS[t] ?? ''}`).includes(q));
}

// ---------- Slash menu ----------

/** Shared keyboard handling for a combobox driving the slash list. Returns true when the key was consumed. */
function slashKey(e: KeyboardEvent, count: number, active: number, setActive: (i: number) => void, pick: () => void, close: () => void): boolean {
  if (e.key === 'ArrowDown') setActive(count ? (active + 1) % count : 0);
  else if (e.key === 'ArrowUp') setActive(count ? (active - 1 + count) % count : 0);
  else if (e.key === 'Enter' && count > 0) pick();
  else if (e.key === 'Escape') close();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function SlashList({ id, items, active, onPick }: { id: string; items: BlockType[]; active: number; onPick: (t: BlockType) => void }) {
  return (
    <ul id={id} role="listbox" aria-label="Chèn block"
      className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-auto rounded-xl border border-stone-700 bg-stone-950 shadow-xl p-1">
      {items.length === 0 && <li role="presentation" className="px-3 py-2 text-[11px] text-stone-500">Không có block phù hợp</li>}
      {items.map((t, i) => (
        <li key={t} id={`${id}-${t}`} role="option" aria-selected={i === active}
          onMouseDown={e => { e.preventDefault(); onPick(t); }}
          className={`px-3 py-1.5 rounded-lg text-xs cursor-pointer flex justify-between gap-3 ${i === active ? 'bg-amber-400 text-stone-950' : 'text-stone-200 hover:bg-stone-800'}`}>
          <span>{typeLabel(t)}</span><span className="font-mono opacity-60">/{t}</span>
        </li>
      ))}
    </ul>
  );
}

/** Notion-style inserter: "/" opens the block menu; plain text + Enter adds a paragraph. */
function BlockInserter({ allowed, onInsert, autoFocus, onDone }: { allowed: BlockType[]; onInsert: (b: Block) => void; autoFocus?: boolean; onDone?: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const slash = q.startsWith('/');
  const showing = open || slash;
  const items = showing ? matchTypes(allowed, slash ? q.slice(1) : '') : [];
  const reset = () => { setQ(''); setOpen(false); setActive(0); };
  const insert = (t: BlockType | undefined) => {
    const b = t ? newBlock(t) : null;
    if (!b) return;
    onInsert(b);
    reset();
    onDone?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (showing && slashKey(e, items.length, active, setActive, () => insert(items[Math.min(active, items.length - 1)]), () => { reset(); onDone?.(); })) return;
    if (e.key === 'Enter' && q.trim()) {
      e.preventDefault();
      onInsert({ id: newId(), type: 'paragraph', text: q.trim() });
      reset();
      onDone?.();
    } else if (e.key === 'Escape') {
      onDone?.();
    }
  };
  return (
    <div className="relative">
      <div className="flex gap-2 items-center">
        <input className={`${inputCls} border-dashed`} value={q} autoFocus={autoFocus}
          placeholder="Gõ / để chèn block, hoặc gõ chữ rồi Enter"
          role="combobox" aria-expanded={showing} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={showing && items[active] ? `${listId}-${items[active]}` : undefined}
          aria-label="Chèn block mới"
          onChange={e => { setQ(e.target.value); setActive(0); }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown} />
        <button type="button" className={btnCls} aria-label="Chọn loại block" aria-expanded={open}
          onMouseDown={e => e.preventDefault()} onClick={() => setOpen(o => !o)}>+</button>
      </div>
      {showing && <SlashList id={listId} items={items} active={Math.min(active, Math.max(items.length - 1, 0))} onPick={t => insert(t)} />}
    </div>
  );
}

// ---------- Small form helpers ----------

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
const opt = (v: string): string | undefined => (v ? v : undefined);

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
        <button type="button" className={btnCls} onClick={() => void load()}>Xem kết quả</button>
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

interface FieldsProps { block: Block; onChange: (b: Block) => void; ctx: ListCtx; allowed: BlockType[] }

/** Paragraph textarea; typing "/" in an empty paragraph turns it into another block type. */
function ParagraphField({ block, onChange, allowed }: { block: ParagraphBlock; onChange: (b: Block) => void; allowed: BlockType[] }) {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const slash = block.text.startsWith('/') && !/\s/.test(block.text) && block.text.length <= 24 && !dismissed;
  const items = slash ? matchTypes(allowed, block.text.slice(1)) : [];
  const pick = (t: BlockType | undefined) => {
    const b = t ? newBlock(t) : null;
    if (b) onChange({ ...b, id: block.id });
  };
  return (
    <div className="relative">
      <Field label="Nội dung (**đậm**, *nghiêng*, ~~gạch~~, ==tô sáng==, `code`, [link](https://…)) — gõ / để đổi loại block">
        <textarea className={inputCls} rows={4} value={block.text}
          aria-controls={slash ? listId : undefined} aria-expanded={slash}
          aria-activedescendant={slash && items[active] ? `${listId}-${items[active]}` : undefined}
          onChange={e => { setDismissed(false); setActive(0); onChange({ ...block, text: e.target.value }); }}
          onKeyDown={e => { if (slash) slashKey(e, items.length, active, setActive, () => pick(items[Math.min(active, items.length - 1)]), () => setDismissed(true)); }} />
      </Field>
      {slash && <SlashList id={listId} items={items} active={Math.min(active, Math.max(items.length - 1, 0))} onPick={pick} />}
    </div>
  );
}

function LayoutFields({ block, onChange, ctx }: { block: LayoutBlock; onChange: (b: Block) => void; ctx: ListCtx }) {
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
          <BlockListEditor blocks={child.blocks} onChange={blocks => setChild(i, { ...child, blocks })} ctx={{ ...ctx, layoutDepth: ctx.layoutDepth + 1 }} />
        </div>
      ))}
      <button type="button" className={btnCls} disabled={block.children.length >= LIMITS.layoutChildren}
        onClick={() => onChange({ ...block, children: [...block.children, { blocks: [] }] })}>+ Thêm ô</button>
    </div>
  );
}

function GalleryFields({ images, onChange }: { images: GalleryImage[]; onChange: (images: GalleryImage[]) => void }) {
  const set = (i: number, patch: Partial<GalleryImage>) => onChange(images.map((img, j) => (j === i ? { ...img, ...patch } : img)));
  return (
    <div className="space-y-2">
      {images.map((img, i) => (
        <div key={i} className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr_auto] gap-2 items-end">
          <Text label={`Ảnh ${i + 1} (https://)`} value={img.url} onChange={url => set(i, { url })} />
          <Text label="Alt" value={img.alt} onChange={alt => set(i, { alt })} />
          <Text label="Chú thích" value={img.caption ?? ''} onChange={caption => set(i, { caption: opt(caption) })} />
          <button type="button" className={btnCls} disabled={images.length <= 1} onClick={() => onChange(images.filter((_, j) => j !== i))}>Xoá</button>
        </div>
      ))}
      <button type="button" className={btnCls} disabled={images.length >= LIMITS.galleryImages}
        onClick={() => onChange([...images, { url: 'https://', alt: '' }])}>+ Ảnh</button>
    </div>
  );
}

function EmbedFields({ block, onChange }: { block: Extract<Block, { type: 'embed' }>; onChange: (b: Block) => void }) {
  const rec = recognizeEmbed(block.url);
  return (
    <div className="space-y-2">
      <Text label="URL (YouTube, Vimeo, SoundCloud, Spotify, X, Facebook, Instagram, TikTok, LinkedIn)" value={block.url}
        onChange={url => {
          const detected = recognizeEmbed(url).provider;
          // Follow the URL while the provider was auto-detected; keep a manual override otherwise.
          const follow = block.provider === 'generic' || block.provider === recognizeEmbed(block.url).provider;
          onChange({ ...block, url, provider: follow ? detected : block.provider });
        }} />
      <p className="text-[11px] text-stone-400" aria-live="polite">
        Nhận diện: <b className="text-stone-200">{rec.label}</b> · {rec.src ? 'nhúng được (người đọc bấm để tải)' : 'hiển thị dạng liên kết'}
      </p>
      <Select label="Nhà cung cấp" value={block.provider} options={EMBED_PROVIDERS} onChange={provider => onChange({ ...block, provider })} />
      <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: opt(caption) })} />
    </div>
  );
}

function ToggleFields({ block, onChange, ctx }: { block: ToggleBlock; onChange: (b: Block) => void; ctx: ListCtx }) {
  return (
    <div className="space-y-2">
      <Text label="Tiêu đề mục" value={block.summary} onChange={summary => onChange({ ...block, summary })} />
      <label className="text-[11px] text-stone-300 flex items-center gap-1.5">
        <input type="checkbox" checked={block.open === true} onChange={e => onChange({ ...block, open: e.target.checked || undefined })} />
        Mở sẵn
      </label>
      <div className="rounded-xl border border-dashed border-stone-700 p-2.5">
        <BlockListEditor blocks={block.blocks} onChange={blocks => onChange({ ...block, blocks })} ctx={{ ...ctx, inToggle: true }} />
      </div>
    </div>
  );
}

function BlockFields({ block, onChange, ctx, allowed }: FieldsProps) {
  switch (block.type) {
    case 'paragraph':
      return <ParagraphField block={block} onChange={onChange} allowed={allowed} />;
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
          <Text label="Nguồn" value={block.cite ?? ''} onChange={cite => onChange({ ...block, cite: opt(cite) })} />
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
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: opt(caption) })} />
        </div>
      );
    case 'embed':
      return <EmbedFields block={block} onChange={onChange} />;
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
            <Text label="Tiêu đề" value={block.title ?? ''} onChange={title => onChange({ ...block, title: opt(title) })} />
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
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: opt(caption) })} />
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
          {ctx.slug && <SurveyResultsView block={block} slug={ctx.slug} />}
        </div>
      );
    case 'layout':
      return <LayoutFields block={block} onChange={onChange} ctx={ctx} />;
    case 'interactive':
      return (
        <div className="space-y-2">
          <Text label="Tiêu đề" value={block.title} onChange={title => onChange({ ...block, title })} />
          <Area label="HTML" value={block.html} onChange={html => onChange({ ...block, html })} rows={5} mono />
          <Area label="CSS" value={block.css} onChange={css => onChange({ ...block, css })} rows={4} mono />
          <Area label="JS (chạy trong iframe sandbox, mạng chỉ qua zuey.fetch)" value={block.js} onChange={js => onChange({ ...block, js })} rows={6} mono />
        </div>
      );
    case 'math':
      return (
        <div className="space-y-2">
          <Area label="Công thức TeX (hiển thị nguyên văn, có thể đọc bằng trình đọc màn hình)" value={block.tex} onChange={tex => onChange({ ...block, tex })} rows={3} mono />
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: opt(caption) })} />
        </div>
      );
    case 'gallery':
      return (
        <div className="space-y-2">
          <GalleryFields images={block.images} onChange={images => onChange({ ...block, images })} />
          <Text label="Chú thích chung" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: opt(caption) })} />
        </div>
      );
    case 'audio':
      return (
        <div className="space-y-2">
          <Text label="URL file âm thanh (https://…mp3) — SoundCloud/Spotify dùng block Nhúng" value={block.url} onChange={url => onChange({ ...block, url })} />
          <Text label="Tên" value={block.title ?? ''} onChange={title => onChange({ ...block, title: opt(title) })} />
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: opt(caption) })} />
        </div>
      );
    case 'video':
      return (
        <div className="space-y-2">
          <Text label="URL file video (https://…mp4) — YouTube/Vimeo dùng block Nhúng" value={block.url} onChange={url => onChange({ ...block, url })} />
          <Text label="Ảnh poster (https://)" value={block.poster ?? ''} onChange={poster => onChange({ ...block, poster: opt(poster) })} />
          <Text label="Tên" value={block.title ?? ''} onChange={title => onChange({ ...block, title: opt(title) })} />
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: opt(caption) })} />
        </div>
      );
    case 'file':
      return (
        <div className="space-y-2">
          <Text label="URL tệp (https://)" value={block.url} onChange={url => onChange({ ...block, url })} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Text label="Tên tệp" value={block.name} onChange={name => onChange({ ...block, name })} />
            <Field label={`Dung lượng (byte)${block.sizeBytes ? ` · ${formatBytes(block.sizeBytes)}` : ''}`}>
              <input className={inputCls} type="number" min={0} value={block.sizeBytes ?? ''}
                onChange={e => { const n = Number(e.target.value); onChange({ ...block, sizeBytes: e.target.value === '' || !Number.isFinite(n) ? undefined : Math.max(0, Math.round(n)) }); }} />
            </Field>
          </div>
          <Text label="Chú thích" value={block.caption ?? ''} onChange={caption => onChange({ ...block, caption: opt(caption) })} />
        </div>
      );
    case 'bookmark':
      return (
        <div className="space-y-2">
          <Text label="URL (https://)" value={block.url} onChange={url => onChange({ ...block, url })} />
          <p className="text-[11px] text-stone-500">Thông tin thẻ được lưu cùng bài, không tự tải khi đọc — điền tay bên dưới.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Text label="Tiêu đề" value={block.title ?? ''} onChange={title => onChange({ ...block, title: opt(title) })} />
            <Text label="Tên trang" value={block.siteName ?? ''} onChange={siteName => onChange({ ...block, siteName: opt(siteName) })} />
          </div>
          <Area label="Mô tả" value={block.description ?? ''} onChange={description => onChange({ ...block, description: opt(description) })} rows={2} />
          <Text label="Ảnh (https://)" value={block.image ?? ''} onChange={image => onChange({ ...block, image: opt(image) })} />
        </div>
      );
    case 'toggle':
      return <ToggleFields block={block} onChange={onChange} ctx={ctx} />;
    default:
      return <p className="text-[11px] text-stone-400">Block này được chỉnh trong tab JSON.</p>;
  }
}

function BlockPreview({ block, slug }: { block: Block; slug: string }) {
  const res = useMemo(() => validateDocument({ version: 1, blocks: [block] }), [block]);
  return (
    <div className="rounded-2xl bg-[#F5EFEB] p-3 sm:p-4 min-w-0 overflow-hidden">
      {res.ok
        ? <BlockRenderer doc={res.doc} articleSlug={slug || undefined} interactive={false} />
        : <ul className="text-[11px] text-rose-700 font-mono">{res.errors.slice(0, 5).map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}</ul>}
    </div>
  );
}

// ---------- Block list editor (recursive for layouts and toggles) ----------

function BlockListEditor({ blocks, onChange, ctx }: { blocks: Block[]; onChange: (b: Block[]) => void; ctx: ListCtx }) {
  const allowed = allowedTypes(ctx);
  const [previewing, setPreviewing] = useState<Set<string>>(() => new Set());
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= blocks.length) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };
  const insertBlock = (at: number, b: Block) => onChange([...blocks.slice(0, at), b, ...blocks.slice(at)]);
  const togglePreview = (id: string) => setPreviewing(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const onCardKeyDown = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    e.stopPropagation();
    const focused = document.activeElement;
    moveTo(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
    // Reordering can detach the focused node; restore focus so keyboard users keep their place.
    requestAnimationFrame(() => {
      if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) focused.focus();
    });
  };
  const endDrag = () => { setDragFrom(null); setDropAt(null); };
  const onDragOver = (e: DragEvent<HTMLDivElement>, i: number) => {
    if (dragFrom === null) return; // not a drag from this list: let an outer list handle it
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropAt !== i) setDropAt(i);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, i: number) => {
    if (dragFrom === null) return;
    e.preventDefault();
    e.stopPropagation();
    moveTo(dragFrom, i);
    endDrag();
  };

  return (
    <div className="space-y-2.5 min-w-0">
      {blocks.map((block, i) => {
        const isPreview = previewing.has(block.id);
        return (
          <div key={block.id}>
            <div
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onKeyDown={e => onCardKeyDown(e, i)}
              onDragOver={e => onDragOver(e, i)}
              onDrop={e => onDrop(e, i)}
              className={`${cardCls} space-y-2.5 ${dropAt === i && dragFrom !== null && dragFrom !== i ? 'ring-2 ring-amber-400' : ''} ${dragFrom === i ? 'opacity-50' : ''}`}>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span draggable aria-hidden="true" title="Kéo để sắp xếp (hoặc Alt+↑/↓)"
                  onDragStart={e => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', block.id); setDragFrom(i); }}
                  onDragEnd={endDrag}
                  className="cursor-grab select-none px-1 text-stone-500 hover:text-amber-300">⋮⋮</span>
                <span className="text-[11px] font-bold text-stone-200 mr-auto min-w-0 truncate">{typeLabel(block.type)} <span className="text-stone-600 font-mono">#{block.id}</span></span>
                <button type="button" className={btnCls} aria-pressed={isPreview} onClick={() => togglePreview(block.id)}>{isPreview ? 'Sửa' : 'Xem'}</button>
                <button type="button" className={btnCls} aria-label={`Đưa ${typeLabel(block.type)} lên`} disabled={i === 0} onClick={() => moveTo(i, i - 1)}>↑</button>
                <button type="button" className={btnCls} aria-label={`Đưa ${typeLabel(block.type)} xuống`} disabled={i === blocks.length - 1} onClick={() => moveTo(i, i + 1)}>↓</button>
                <button type="button" className={btnCls} aria-label="Chèn block bên dưới" onClick={() => setInsertAt(i + 1)}>+</button>
                <button type="button" className={dangerCls} onClick={() => onChange(blocks.filter((_, j) => j !== i))}>Xoá</button>
              </div>
              {isPreview
                ? <BlockPreview block={block} slug={ctx.slug} />
                : <BlockFields block={block} ctx={ctx} allowed={allowed} onChange={b => onChange(blocks.map((x, j) => (j === i ? b : x)))} />}
            </div>
            {insertAt === i + 1 && i + 1 < blocks.length && (
              <div className="mt-2.5">
                <BlockInserter allowed={allowed} autoFocus onInsert={b => insertBlock(i + 1, b)} onDone={() => setInsertAt(null)} />
              </div>
            )}
          </div>
        );
      })}
      <BlockInserter allowed={allowed} autoFocus={insertAt === blocks.length} onInsert={b => insertBlock(blocks.length, b)} onDone={() => setInsertAt(null)} />
    </div>
  );
}

// ---------- Article data ----------

interface EditionRow {
  locale: Locale;
  title: string;
  status: 'draft' | 'published';
  has_unpublished_changes: boolean;
  published_revision: number | null;
}

interface ArticleRow {
  slug: string;
  title: string;
  locale: Locale;
  access: ArticleAccess;
  status: 'draft' | 'published';
  revision: number;
  has_unpublished_changes: boolean;
  editions: EditionRow[];
}

function parseEditions(v: unknown): EditionRow[] {
  return objArr(v).flatMap(e => {
    const locale = localeOr(e.locale, 'vi');
    if (e.locale !== locale) return [];
    return [{
      locale, title: str(e, 'title'), status: e.status === 'published' ? 'published' : 'draft',
      has_unpublished_changes: e.has_unpublished_changes === true,
      published_revision: typeof e.published_revision === 'number' ? e.published_revision : null,
    }];
  });
}

function parseRow(v: unknown): ArticleRow | null {
  if (!isObj(v) || typeof v.slug !== 'string' || typeof v.revision !== 'number') return null;
  return {
    slug: v.slug, title: str(v, 'title'), locale: localeOr(v.locale, 'vi'), access: v.access === 'knowledges' ? 'knowledges' : 'free',
    status: v.status === 'published' ? 'published' : 'draft', revision: v.revision, has_unpublished_changes: v.has_unpublished_changes === true,
    editions: parseEditions(v.editions),
  };
}

interface TagChip { ref: string; label: string }
interface TagOption { id: string; slug: string; name: string; keys: string[] }
interface CategoryOption { id: string; name: string }

/** The savable state of one edition plus article-wide metadata. */
interface Draft {
  slug: string;
  title: string;
  excerpt: string;
  locale: Locale;
  primary_locale: Locale;
  access: ArticleAccess;
  category: string;
  tags: TagChip[];
  doc: ArticleDocument;
}

interface Editing {
  originalSlug: string | null;
  revision: number;
  status: 'draft' | 'published';
  hasUnpublished: boolean;
  editions: EditionRow[];
  /** The selected locale has no edition yet; saving creates it. */
  newEdition: boolean;
  draft: Draft;
  /** Snapshot of the last loaded/saved draft, to detect unsaved changes. */
  saved: string;
  /** New-article email to members; null before the article's first publish. */
  emailNotification: EmailNotification | null;
}

interface EmailNotification { status: string; sendAfter: string; sentCount: number }

function parseEmailNotification(v: unknown): EmailNotification | null {
  if (!isObj(v) || typeof v.status !== 'string') return null;
  return { status: v.status, sendAfter: str(v, 'send_after'), sentCount: typeof v.sent_count === 'number' ? v.sent_count : 0 };
}

const fmtSaigon = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
};

const snapshot = (d: Draft): string => JSON.stringify(d);

function blankDraft(locale: Locale): Draft {
  return { slug: '', title: '', excerpt: '', locale, primary_locale: locale, access: 'free', category: '', tags: [], doc: emptyDocument() };
}

/** Builds the editing state from GET /api/v1/articles/{slug}?draft=1&lang= (an admin ArticleView). */
function editingFrom(data: unknown, requested: Locale | undefined): Editing | null {
  if (!isObj(data) || typeof data.slug !== 'string' || typeof data.revision !== 'number') return null;
  const docRes = validateDocument(data.document);
  if (!docRes.ok) return null;
  const locale = localeOr(data.locale, 'vi');
  const fallback = data.locale_fallback === true && requested !== undefined && requested !== locale;
  const category = isObj(data.category) ? str(data.category, 'id') : '';
  const tags = objArr(data.topic_tags).map(t => ({ ref: str(t, 'id'), label: str(t, 'name') || str(t, 'slug') })).filter(t => t.ref);
  const base: Draft = {
    slug: data.slug, title: str(data, 'title'), excerpt: str(data, 'excerpt'), locale, primary_locale: localeOr(data.primary_locale, locale),
    access: data.access === 'knowledges' ? 'knowledges' : 'free', category, tags, doc: docRes.doc,
  };
  // A missing edition starts empty: translations are written by people, never generated.
  const draft: Draft = fallback && requested ? { ...base, locale: requested, title: '', excerpt: '', doc: emptyDocument() } : base;
  return {
    originalSlug: data.slug, revision: data.revision, status: fallback ? 'draft' : data.status === 'published' ? 'published' : 'draft',
    hasUnpublished: fallback || data.has_unpublished_changes === true, editions: parseEditions(data.editions), newEdition: fallback,
    draft, saved: snapshot(draft), emailNotification: parseEmailNotification(data.email_notification),
  };
}

// ---------- Tags and category ----------

function TagEditor({ value, onChange, options }: { value: TagChip[]; onChange: (v: TagChip[]) => void; options: TagOption[] }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const name = raw.trim().replace(/,$/, '').trim();
    if (!name) return;
    if (name.length > 40) { setMsg('Tag tối đa 40 ký tự'); return; }
    if (value.length >= 20) { setMsg('Tối đa 20 tag'); return; }
    const key = name.toLowerCase();
    const match = options.find(o => o.keys.includes(key));
    const chip: TagChip = match ? { ref: match.id, label: match.name } : { ref: name, label: name };
    if (value.some(v => v.ref.toLowerCase() === chip.ref.toLowerCase() || v.label.toLowerCase() === chip.label.toLowerCase())) { setMsg('Tag đã có'); setText(''); return; }
    onChange([...value, chip]);
    setText('');
    setMsg(match ? '' : `“${name}” là tag mới — sẽ được tạo khi lưu.`);
  };
  return (
    <Field label={`Tags (${value.length}/20) — Enter hoặc dấu phẩy để thêm`}>
      <div className={`${inputCls} flex flex-wrap gap-1.5 items-center`}>
        {value.map(t => (
          <span key={t.ref} className="inline-flex items-center gap-1 rounded-full bg-stone-800 border border-stone-700 px-2 py-0.5 text-[11px] text-stone-200">
            {t.label}
            <button type="button" className="text-stone-400 hover:text-rose-300" aria-label={`Bỏ tag ${t.label}`} onClick={() => onChange(value.filter(v => v.ref !== t.ref))}>×</button>
          </span>
        ))}
        <input className="flex-1 min-w-[8rem] bg-transparent outline-none text-xs text-white placeholder-stone-500" list={listId} value={text}
          placeholder="Thêm tag…" aria-label="Thêm tag"
          onChange={e => { if (e.target.value.endsWith(',')) add(e.target.value); else setText(e.target.value); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); add(text); }
            else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }} />
        <datalist id={listId}>{options.map(o => <option key={o.id} value={o.name} />)}</datalist>
      </div>
      {msg && <span className="block text-[11px] text-stone-400 mt-1" aria-live="polite">{msg}</span>}
    </Field>
  );
}

// ---------- Revision history ----------

interface RevisionRow { revision: number; locale: Locale; action: string; title: string; actor: string; created_at: string }

function HistoryView({ slug, locale, onRestore }: { slug: string; locale: Locale; onRestore: (title: string, excerpt: string, doc: ArticleDocument, revision: number) => void }) {
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<{ revision: number; title: string; excerpt: string; doc: ArticleDocument } | null>(null);
  useEffect(() => {
    let alive = true;
    setRows(null);
    setViewing(null);
    void api(`/api/v1/articles/${encodeURIComponent(slug)}/revisions?lang=${locale}`).then(res => {
      if (!alive) return;
      if (!res.ok || !Array.isArray(res.data)) { setError(res.message || 'Không tải được lịch sử'); return; }
      setError('');
      setRows(objArr(res.data).map(r => ({
        revision: num(r, 'revision'), locale: localeOr(r.locale, locale), action: str(r, 'action'), title: str(r, 'title'), actor: str(r, 'actor'), created_at: str(r, 'created_at'),
      })));
    });
    return () => { alive = false; };
  }, [slug, locale]);
  const view = async (revision: number) => {
    const res = await api(`/api/v1/articles/${encodeURIComponent(slug)}/revisions?lang=${locale}&revision=${revision}`);
    const doc = isObj(res.data) ? validateDocument(res.data.document) : null;
    if (!res.ok || !isObj(res.data) || !doc?.ok) { setError(res.message || 'Không mở được revision'); return; }
    setViewing({ revision, title: str(res.data, 'title'), excerpt: str(res.data, 'excerpt'), doc: doc.doc });
  };
  const ACTIONS: Record<string, string> = { create: 'tạo', save: 'lưu nháp', publish: 'xuất bản', delete_edition: 'xoá bản ngôn ngữ' };
  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-rose-400" role="alert">{error}</p>}
      {rows === null && !error && <p className="text-xs text-stone-500">Đang tải…</p>}
      {rows && rows.length === 0 && <p className="text-xs text-stone-500">Chưa có lịch sử cho bản {locale}.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-stone-800 rounded-xl border border-stone-800">
          {rows.map((r, i) => (
            <li key={`${r.revision}-${r.action}-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px] text-stone-300">
              <span className="font-mono text-amber-300">r{r.revision}</span>
              <span>{ACTIONS[r.action] ?? r.action}</span>
              <span className="truncate max-w-[14rem] text-stone-200">{r.title}</span>
              <span className="text-stone-500">{r.actor} · {formatTime(r.created_at)}</span>
              {r.action !== 'delete_edition' && <button type="button" className={`${btnCls} ml-auto`} onClick={() => void view(r.revision)}>Xem</button>}
            </li>
          ))}
        </ul>
      )}
      {viewing && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs text-stone-300">Revision r{viewing.revision}: <b>{viewing.title}</b></span>
            <button type="button" className={primaryCls} onClick={() => onRestore(viewing.title, viewing.excerpt, viewing.doc, viewing.revision)}>Khôi phục vào bản nháp</button>
            <button type="button" className={btnCls} onClick={() => setViewing(null)}>Đóng</button>
          </div>
          <div className="rounded-3xl bg-[#F5EFEB] p-4 sm:p-6 min-w-0 overflow-hidden">
            <BlockRenderer doc={viewing.doc} interactive={false} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Article editor ----------

type EditorTab = 'blocks' | 'preview' | 'json' | 'history' | 'labels';

/** Whether the publish dialog offers the member-email switch (not once the email is going out or went out). */
function emailChoice(n: EmailNotification | null): boolean {
  return n === null || n.status === 'scheduled' || n.status === 'skipped' || n.status === 'cancelled';
}

/** Default of the switch: on for a first publish or a scheduled email, off for articles that were skipped before. */
function defaultNotify(n: EmailNotification | null): boolean {
  return n === null || n.status === 'scheduled';
}

function EmailNotificationChoice({ notification: n, checked, onChange }: {
  notification: EmailNotification | null; checked: boolean; onChange: (v: boolean) => void;
}) {
  if (n && (n.status === 'sent' || n.status === 'sending')) {
    return <p className="text-xs text-stone-400">Email bài viết mới {n.status === 'sent' ? 'đã gửi' : 'đang gửi'} tới {n.sentCount} thành viên; xuất bản lại không gửi thêm.</p>;
  }
  const hint = n === null
    ? 'Gửi tới mọi thành viên đã xác minh email, 30 phút sau khi xuất bản (bản sửa trong lúc chờ sẽ được dùng). Bỏ chọn khi đăng lại bài cũ.'
    : n.status === 'scheduled'
      ? `Đã lên lịch gửi lúc ${fmtSaigon(n.sendAfter)}. Bỏ chọn để huỷ.`
      : 'Bài này chưa từng gửi email. Chọn để gửi sau 30 phút.';
  return (
    <label className="flex items-start gap-2 rounded-xl border border-stone-700 p-3 text-xs text-stone-300">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span><span className="font-semibold text-white">Gửi email cho thành viên</span><br />{hint}</span>
    </label>
  );
}

function ArticleEditorPane({ categories, tagOptions, onListChanged, onClosed, initialSlug }: {
  categories: CategoryOption[]; tagOptions: TagOption[]; onListChanged: () => void; onClosed: () => void; initialSlug: string | null;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [tab, setTab] = useState<EditorTab>('blocks');
  const [jsonText, setJsonText] = useState('');
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [serverErrors, setServerErrors] = useState<ValidationError[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  /** "Email members" switch of the publish dialog; reset whenever the dialog opens. */
  const [notifyMembers, setNotifyMembers] = useState(true);
  const [conflict, setConflict] = useState<{ current: number | null } | null>(null);

  const dirty = editing !== null && snapshot(editing.draft) !== editing.saved;

  const load = useCallback(async (slug: string, locale?: Locale): Promise<boolean> => {
    const q = locale ? `&lang=${locale}` : '';
    const res = await api(`/api/v1/articles/${encodeURIComponent(slug)}?draft=1${q}`);
    const next = res.ok ? editingFrom(res.data, locale) : null;
    if (!next) { setStatus({ text: res.message || 'Không mở được bài viết', error: true }); return false; }
    setEditing(next);
    setJsonText(JSON.stringify(next.draft.doc, null, 2));
    setServerErrors([]);
    setConflict(null);
    return true;
  }, []);

  useEffect(() => {
    setStatus(null);
    setTab('blocks');
    if (initialSlug) { void load(initialSlug); return; }
    const draft = blankDraft('vi');
    setEditing({ originalSlug: null, revision: 0, status: 'draft', hasUnpublished: true, editions: [], newEdition: true, draft, saved: snapshot(draft), emailNotification: null });
    setJsonText(JSON.stringify(draft.doc, null, 2));
    setServerErrors([]);
    setConflict(null);
  }, [initialSlug, load]);

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const validation = useMemo(() => (editing ? validateDocument(editing.draft.doc) : null), [editing]);
  const clientErrors = validation && !validation.ok ? validation.errors : [];

  const setDraft = (patch: Partial<Draft>) => setEditing(e => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));

  const save = useCallback(async (overrideRevision?: number) => {
    if (!editing || busy) return;
    if (clientErrors.length > 0) { setStatus({ text: 'Sửa lỗi block trước khi lưu.', error: true }); return; }
    setBusy(true);
    setServerErrors([]);
    const d = editing.draft;
    const common = {
      title: d.title, excerpt: d.excerpt, locale: d.locale, access: d.access, tags: d.tags.map(t => t.ref),
      category: d.category || null, document: d.doc,
    };
    const res = editing.originalSlug
      ? await api(`/api/v1/articles/${encodeURIComponent(editing.originalSlug)}`, {
        method: 'PUT',
        body: {
          ...common, expected_revision: overrideRevision ?? editing.revision,
          ...(d.slug !== editing.originalSlug ? { slug: d.slug } : {}),
          ...(editing.editions.some(e => e.locale === d.primary_locale) ? { primary_locale: d.primary_locale } : {}),
        },
      })
      : await api('/api/v1/articles', { method: 'POST', body: { ...common, slug: d.slug, primary_locale: d.locale } });
    setBusy(false);
    if (res.ok) {
      const slug = isObj(res.data) && typeof res.data.slug === 'string' ? res.data.slug : d.slug;
      if (await load(slug, d.locale)) setStatus({ text: `Đã lưu bản nháp (${d.locale}).`, error: false });
      onListChanged();
    } else if (res.code === 'revision_conflict') {
      setConflict({ current: typeof res.error.current_revision === 'number' ? res.error.current_revision : null });
      setStatus({ text: 'Xung đột phiên bản: bài vừa được sửa ở nơi khác.', error: true });
    } else {
      setServerErrors(issuesFrom(res.error));
      setStatus({ text: res.message || 'Lưu thất bại', error: true });
    }
  }, [editing, busy, clientErrors.length, load, onListChanged]);

  // Ctrl/Cmd+S saves the draft.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Conflict: keep my changes and save them over the latest revision (after re-reading it). */
  const overwrite = async () => {
    if (!editing?.originalSlug) return;
    if (!window.confirm('Ghi đè thay đổi vừa được lưu ở nơi khác bằng bản của bạn?')) return;
    const res = await api(`/api/v1/articles/${encodeURIComponent(editing.originalSlug)}?draft=1&lang=${editing.draft.locale}`);
    if (!res.ok || !isObj(res.data) || typeof res.data.revision !== 'number') { setStatus({ text: res.message || 'Không đọc được bản mới nhất', error: true }); return; }
    setConflict(null);
    await save(res.data.revision);
  };

  const switchLocale = async (locale: Locale) => {
    if (!editing || locale === editing.draft.locale) return;
    if (dirty && !window.confirm('Bỏ các thay đổi chưa lưu của bản hiện tại?')) return;
    setStatus(null);
    if (!editing.originalSlug) { setDraft({ locale, primary_locale: locale }); return; }
    await load(editing.originalSlug, locale);
  };

  const publish = async () => {
    if (!editing?.originalSlug) return;
    setConfirmPublish(false);
    setBusy(true);
    const res = await api(`/api/v1/articles/${encodeURIComponent(editing.originalSlug)}/publish`, {
      method: 'POST', body: {
        expected_revision: editing.revision, confirm: true, locale: editing.draft.locale,
        // Only sent when the dialog offers the choice, so republishing never re-schedules by accident.
        ...(emailChoice(editing.emailNotification) ? { notify: notifyMembers } : {}),
      },
    });
    setBusy(false);
    if (res.ok) {
      await load(editing.originalSlug, editing.draft.locale);
      const scheduled = isObj(res.data) ? parseEmailNotification(res.data.email_notification) : null;
      const emailNote = scheduled?.status === 'scheduled' ? ` Email cho thành viên sẽ gửi lúc ${fmtSaigon(scheduled.sendAfter)}.` : '';
      setStatus({ text: `Đã xuất bản bản ${editing.draft.locale}.${emailNote}`, error: false });
      onListChanged();
    } else if (res.code === 'revision_conflict') {
      setConflict({ current: typeof res.error.current_revision === 'number' ? res.error.current_revision : null });
      setStatus({ text: 'Xung đột phiên bản; tải lại bài trước khi xuất bản.', error: true });
    } else {
      setStatus({ text: res.message, error: true });
    }
  };

  const removeEdition = async () => {
    if (!editing?.originalSlug || editing.newEdition) return;
    const locale = editing.draft.locale;
    if (!window.confirm(`Xoá bản ${LOCALE_LABELS[locale].native} của bài này? Bản đã xuất bản (nếu có) cũng bị gỡ.`)) return;
    const res = await api(`/api/v1/articles/${encodeURIComponent(editing.originalSlug)}/editions`, {
      method: 'DELETE', body: { locale, expected_revision: editing.revision },
    });
    if (res.ok) {
      await load(editing.originalSlug);
      setStatus({ text: `Đã xoá bản ${locale}.`, error: false });
      onListChanged();
    } else {
      if (res.code === 'revision_conflict') setConflict({ current: null });
      setStatus({ text: res.message, error: true });
    }
  };

  const removeArticle = async () => {
    if (!editing?.originalSlug || !window.confirm(`Xoá bài "${editing.draft.title || editing.originalSlug}" (mọi bản ngôn ngữ)?`)) return;
    const res = await api(`/api/v1/articles/${encodeURIComponent(editing.originalSlug)}`, { method: 'DELETE' });
    if (res.ok) { onListChanged(); onClosed(); } else setStatus({ text: res.message, error: true });
  };

  const applyJson = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(jsonText); } catch { setServerErrors([{ path: '$', message: 'JSON không hợp lệ' }]); return; }
    const res = validateDocument(parsed);
    if (!res.ok) { setServerErrors(res.errors); return; }
    setServerErrors([]);
    setDraft({ doc: res.doc });
    setStatus({ text: 'Đã áp dụng JSON (chưa lưu).', error: false });
  };

  const copyMine = async () => {
    if (!editing) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(editing.draft.doc, null, 2));
      setStatus({ text: 'Đã sao chép JSON bản của bạn.', error: false });
    } catch {
      setStatus({ text: 'Trình duyệt chặn clipboard; mở tab JSON để sao chép thủ công.', error: true });
    }
  };

  if (!editing) {
    return <section className="rounded-2xl border border-dashed border-stone-800 p-8 text-center text-sm text-stone-500">{status?.text ?? 'Đang tải…'}</section>;
  }

  const d = editing.draft;
  const errors = [...clientErrors, ...serverErrors];
  const editionFor = (l: Locale) => editing.editions.find(e => e.locale === l);
  const isPrimary = d.locale === d.primary_locale;
  const tabs: Array<[EditorTab, string]> = [['blocks', 'Blocks'], ['preview', 'Xem trước'], ['json', 'JSON']];
  if (editing.originalSlug) tabs.push(['history', 'Lịch sử'], ['labels', 'Nhãn']);

  return (
    <section className="space-y-4 min-w-0" aria-label="Trình soạn bài viết">
      <div role="tablist" aria-label="Bản ngôn ngữ" className="flex flex-wrap gap-1.5">
        {LOCALES.map(l => {
          const ed = editionFor(l);
          const selected = l === d.locale;
          return (
            <button key={l} type="button" role="tab" aria-selected={selected} onClick={() => void switchLocale(l)}
              className={`${tabCls(selected)} inline-flex items-center gap-1.5`}
              title={ed ? `${LOCALE_LABELS[l].native}: ${ed.status === 'published' ? (ed.has_unpublished_changes ? 'đã xuất bản, có thay đổi' : 'đã xuất bản') : 'nháp'}` : `Thêm bản ${LOCALE_LABELS[l].native}`}>
              <span className="font-mono uppercase">{l}</span>
              {ed
                ? <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${ed.status === 'published' ? (ed.has_unpublished_changes ? 'bg-sky-400' : 'bg-emerald-400') : 'bg-stone-500'}`} />
                : <span aria-hidden="true" className="opacity-60">+</span>}
              {editing.originalSlug && l === d.primary_locale && <span className="text-[9px] uppercase opacity-70">chính</span>}
            </button>
          );
        })}
      </div>
      {editing.newEdition && editing.originalSlug && (
        <p className="text-[11px] text-sky-300 rounded-lg border border-sky-900 bg-sky-950/40 px-3 py-2">
          Bản {LOCALE_LABELS[d.locale].native} chưa có. Viết nội dung rồi lưu để tạo — bản dịch do người viết, hệ thống không tự dịch.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <Text label={`Tiêu đề (${d.locale})`} value={d.title} onChange={title => setDraft({ title })} />
        <Text label="Slug (chung mọi ngôn ngữ)" value={d.slug} placeholder="vi-du-bai-viet" onChange={slug => setDraft({ slug: slug.toLowerCase() })} />
        <div className="sm:col-span-2"><Area label={`Tóm tắt (${d.locale})`} value={d.excerpt} onChange={excerpt => setDraft({ excerpt })} rows={2} /></div>
        <Select label="Quyền đọc" value={d.access} options={['free', 'knowledges'] as const} labels={{ free: 'Miễn phí', knowledges: 'Knowledges (trả phí)' }} onChange={access => setDraft({ access })} />
        <Field label="Danh mục">
          <select className={inputCls} value={d.category} onChange={e => setDraft({ category: e.target.value })}>
            <option value="">— Không có —</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {editing.originalSlug && editing.editions.length > 1 && (
          <Select label="Ngôn ngữ chính (canonical mặc định)" value={d.primary_locale} options={editing.editions.map(e => e.locale)}
            labels={Object.fromEntries(LOCALES.map(l => [l, LOCALE_LABELS[l].native]))} onChange={primary_locale => setDraft({ primary_locale })} />
        )}
        <div className="sm:col-span-2"><TagEditor value={d.tags} onChange={tags => setDraft({ tags })} options={tagOptions} /></div>
      </div>

      {conflict && (
        <div role="alert" className="rounded-xl border border-amber-700 bg-amber-950/40 p-3 space-y-2 text-xs text-amber-200">
          <p>
            Bài đã được lưu ở nơi khác{conflict.current !== null ? ` (revision hiện tại r${conflict.current}, bạn đang sửa r${editing.revision})` : ''}.
            Chọn cách xử lý:
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnCls} onClick={() => editing.originalSlug && void load(editing.originalSlug, d.locale)}>Tải bản mới nhất (bỏ thay đổi của tôi)</button>
            <button type="button" className={btnCls} onClick={() => void overwrite()}>Giữ bản của tôi và lưu đè</button>
            <button type="button" className={btnCls} onClick={() => void copyMine()}>Sao chép JSON của tôi</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        {tabs.map(([t, label]) => (
          <button key={t} type="button" className={tabCls(tab === t)} aria-pressed={tab === t}
            onClick={() => { setTab(t); if (t === 'json') setJsonText(JSON.stringify(d.doc, null, 2)); }}>{label}</button>
        ))}
        <span className="ml-auto text-[11px] text-stone-500 font-mono">
          r{editing.revision} · {editing.status}{dirty ? ' · chưa lưu' : ''}
        </span>
      </div>

      {tab === 'blocks' && (
        <BlockListEditor blocks={d.doc.blocks} onChange={blocks => setDraft({ doc: { version: 1, blocks } })}
          ctx={{ layoutDepth: 0, inToggle: false, slug: editing.originalSlug ?? '' }} />
      )}
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
      {tab === 'history' && editing.originalSlug && (
        <HistoryView slug={editing.originalSlug} locale={d.locale}
          onRestore={(title, excerpt, doc, revision) => {
            setDraft({ title, excerpt, doc });
            setTab('blocks');
            setStatus({ text: `Đã nạp r${revision} vào bản nháp — bấm Lưu để giữ.`, error: false });
          }} />
      )}
      {tab === 'labels' && editing.originalSlug && <ArticleLabelsPanel slug={editing.originalSlug} locale={d.locale} />}

      {errors.length > 0 && (
        <ul className="rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-[11px] text-rose-300 space-y-0.5 font-mono" aria-live="polite">
          {errors.slice(0, 20).map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 items-center border-t border-stone-800 pt-3">
        <button type="button" className={primaryCls} disabled={busy || clientErrors.length > 0} aria-keyshortcuts="Control+S Meta+S" onClick={() => void save()}>
          {busy ? 'Đang lưu…' : 'Lưu nháp (Ctrl+S)'}
        </button>
        <button type="button" className={btnCls} disabled={busy || !editing.originalSlug || editing.newEdition || dirty}
          title={dirty ? 'Lưu trước khi xuất bản' : undefined} onClick={() => { setNotifyMembers(defaultNotify(editing.emailNotification)); setConfirmPublish(true); }}>Xuất bản bản {d.locale}…</button>
        {editing.originalSlug && !editing.newEdition && (
          <a className={btnCls} href={`/articles/${encodeURIComponent(editing.originalSlug)}?lang=${d.locale}&preview=1`} target="_blank" rel="noreferrer">Xem trên trang</a>
        )}
        {editing.originalSlug && !editing.newEdition && !isPrimary && <button type="button" className={dangerCls} onClick={() => void removeEdition()}>Xoá bản {d.locale}</button>}
        {editing.originalSlug && <button type="button" className={dangerCls} onClick={() => void removeArticle()}>Xoá bài</button>}
        <StatusLine status={status} />
      </div>

      {confirmPublish && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="publish-title"
          onKeyDown={e => { if (e.key === 'Escape') setConfirmPublish(false); }}>
          <div className="w-full max-w-sm rounded-2xl border border-stone-700 bg-stone-950 p-5 space-y-3">
            <h3 id="publish-title" className="text-sm font-bold text-white">Xuất bản “{d.title}” ({LOCALE_LABELS[d.locale].native})?</h3>
            <p className="text-xs text-stone-400">
              Bản nháp đã lưu (revision {editing.revision}) của ngôn ngữ này sẽ thay thế bản công khai. Các ngôn ngữ khác không đổi.
              {d.access === 'knowledges' ? ' Người chưa có quyền đọc đầy đủ chỉ thấy phần xem trước và lời mời nâng cấp.' : ''}
            </p>
            <EmailNotificationChoice notification={editing.emailNotification} checked={notifyMembers} onChange={setNotifyMembers} />
            <div className="flex justify-end gap-2">
              <button type="button" className={btnCls} onClick={() => setConfirmPublish(false)}>Huỷ</button>
              <button type="button" className={primaryCls} onClick={() => void publish()} autoFocus>Xuất bản</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- Panel ----------

type PanelTab = 'articles' | 'review' | 'taxonomy';

function useTaxonomyOptions(): { categories: CategoryOption[]; tagOptions: TagOption[]; reload: () => void } {
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const reload = useCallback(() => {
    void api('/api/v1/taxonomy/categories').then(res => {
      if (res.ok) setCategories(objArr(res.data).map(c => ({ id: str(c, 'id'), name: displayName(namesOf(c.names), str(c, 'slug')) })));
    });
    void api('/api/v1/taxonomy/tags').then(res => {
      if (!res.ok) return;
      setTagOptions(objArr(res.data).map(t => {
        const names = namesOf(t.names);
        return {
          id: str(t, 'id'), slug: str(t, 'slug'), name: displayName(names, str(t, 'slug')),
          keys: [str(t, 'id'), str(t, 'slug'), ...Object.values(names), ...strArr(t.aliases)].filter(Boolean).map(k => k.toLowerCase()),
        };
      }));
    });
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { categories, tagOptions, reload };
}

export function ArticlesPanel() {
  const [panel, setPanel] = useState<PanelTab>('articles');
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [listError, setListError] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<{ slug: string | null; nonce: number } | null>(null);
  const { categories, tagOptions, reload: reloadTaxonomy } = useTaxonomyOptions();

  const refresh = useCallback(async () => {
    const res = await api('/api/v1/articles?include_drafts=1&limit=100');
    if (!res.ok || !Array.isArray(res.data)) { setListError(res.message || 'Không tải được danh sách'); return; }
    setListError('');
    setArticles(res.data.map(parseRow).filter((r): r is ArticleRow => r !== null));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onListChanged = useCallback(() => { void refresh(); reloadTaxonomy(); }, [refresh, reloadTaxonomy]);
  const visible = useMemo(() => {
    const q = fold(filter.trim());
    return q ? articles.filter(a => fold(`${a.title} ${a.slug}`).includes(q)) : articles;
  }, [articles, filter]);

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Kiến thức">
        {([['articles', 'Bài viết'], ['review', 'Duyệt nhãn AI'], ['taxonomy', 'Tags · Danh mục · Nhãn']] as const).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={panel === t} className={tabCls(panel === t)}
            onClick={() => { if (t === 'articles' && panel !== 'articles') onListChanged(); setPanel(t); }}>{label}</button>
        ))}
      </div>

      {panel === 'review' && <TaxonomyReviewPanel />}
      {panel === 'taxonomy' && <TaxonomyManager />}
      {/* The editor stays mounted while other tabs are open so unsaved edits survive tab switches. */}
      <div hidden={panel !== 'articles'}>
        <div className="grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 min-w-0">
          <aside className="space-y-2 min-w-0">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white">Bài viết</h2>
              <button type="button" className={primaryCls} onClick={() => setSelected({ slug: null, nonce: Date.now() })}>+ Mới</button>
            </div>
            <input className={inputCls} type="search" placeholder="Lọc theo tiêu đề/slug" aria-label="Lọc bài viết" value={filter} onChange={e => setFilter(e.target.value)} />
            {listError && <p className="text-xs text-rose-400" role="alert">{listError}</p>}
            <ul className="space-y-1.5 max-h-[60vh] lg:max-h-[75vh] overflow-auto pr-1">
              {visible.map(a => (
                <li key={a.slug}>
                  <button type="button" onClick={() => setSelected({ slug: a.slug, nonce: Date.now() })} aria-current={selected?.slug === a.slug ? 'true' : undefined}
                    className={`w-full text-left rounded-xl border px-3 py-2 text-xs ${selected?.slug === a.slug ? 'border-amber-400 bg-stone-900' : 'border-stone-800 bg-stone-950 hover:bg-stone-900'}`}>
                    <span className="block font-semibold text-stone-100 truncate">{a.title || a.slug}</span>
                    <span className="block text-[10px] text-stone-500 font-mono">
                      {a.status === 'published' ? (a.has_unpublished_changes ? 'đã xuất bản · có thay đổi' : 'đã xuất bản') : 'nháp'} · r{a.revision}{a.access === 'knowledges' ? ' · Knowledges' : ''}
                    </span>
                    {a.editions.length > 0 && (
                      <span className="mt-1 flex gap-1">
                        {a.editions.map(e => (
                          <span key={e.locale} className={`px-1 rounded font-mono text-[9px] uppercase ${e.status === 'published' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-stone-800 text-stone-400'}`}>{e.locale}</span>
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {visible.length === 0 && !listError && <li className="text-xs text-stone-500">{articles.length === 0 ? 'Chưa có bài viết.' : 'Không có bài khớp bộ lọc.'}</li>}
            </ul>
          </aside>

          {selected ? (
            <ArticleEditorPane key={selected.nonce} initialSlug={selected.slug} categories={categories} tagOptions={tagOptions}
              onListChanged={onListChanged} onClosed={() => setSelected(null)} />
          ) : (
            <section className="rounded-2xl border border-dashed border-stone-800 p-8 text-center text-sm text-stone-500">
              Chọn một bài viết hoặc tạo bài mới.
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export default ArticlesPanel;

/** Exposed for tests: slash-menu matching and block factories. */
export const editorInternals = { matchTypes, newBlock, allowedTypes, CREATABLE };
