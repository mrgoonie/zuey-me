import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  CARD_LEVELS, DEFAULT_CARD_LEVEL, DEFAULT_PROGRESS_SEGMENTS, DEFAULT_RATING_MAX, LIMITS, PROGRESS_STATES, PROGRESS_VARIANTS, STAT_STATES,
  STAT_TRENDS, STEP_CONNECTORS, STEP_ORIENTATIONS, STEP_STATUSES, STEP_VARIANTS,
} from '../../lib/blocks/schema';
import type {
  Block, ComparisonBlock, ComparisonFeature, ComparisonOption, CompositionBlock, ProgressBlock, ProgressItem, StatBlock, StatDelta, StatItem, StepItem,
  StepsBlock, TabItem, TabsBlock,
} from '../../lib/blocks/schema';
import { Area, Field, Select, Text, btnCls, inputCls } from './knowledge-studio-kit';
import { IconPicker } from './IconPicker';

/** Renders the nested block editor of one widget item (supplied by the article editor to avoid a circular import). */
export type RenderBody = (blocks: Block[], onChange: (blocks: Block[]) => void) => ReactNode;

const opt = (v: string): string | undefined => (v ? v : undefined);
const lines = (raw: string): string[] | undefined => {
  const out = raw.split('\n');
  return out.some(l => l.trim()) ? out : undefined;
};

/** Optional number field: keeps the raw text while typing and commits a finite number, or undefined when empty. */
function NumInput({ label, value, onChange, required }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; required?: boolean }) {
  const [raw, setRaw] = useState(value === undefined ? '' : String(value));
  const shown = raw.trim() === '' || Number(raw) !== value ? raw : String(value);
  return (
    <Field label={label}>
      <input
        className={inputCls} inputMode="decimal" value={shown} placeholder={required ? '0' : '–'}
        onChange={e => {
          setRaw(e.target.value);
          const text = e.target.value.trim().replace(',', '.');
          if (text === '') { if (!required) onChange(undefined); return; }
          const n = Number(text);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </Field>
  );
}

function OptionalSelect<T extends string>({ label, value, options, none, onChange, labels }: {
  label: string; value: T | undefined; options: readonly T[]; none: string; onChange: (v: T | undefined) => void; labels?: Partial<Record<T, string>>;
}) {
  return (
    <Field label={label}>
      <select className={inputCls} value={value ?? ''} onChange={e => onChange(options.find(o => o === e.target.value))}>
        <option value="">{none}</option>
        {options.map(o => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
      </select>
    </Field>
  );
}

function Decimals({ value, onChange, label = 'Số lẻ' }: { value: number | undefined; onChange: (v: number | undefined) => void; label?: string }) {
  return (
    <Field label={label}>
      <select className={inputCls} value={value ?? ''} onChange={e => onChange(e.target.value === '' || e.target.value === '0' ? undefined : Number(e.target.value))}>
        <option value="">0</option>
        {Array.from({ length: LIMITS.widgetDecimalsMax }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </Field>
  );
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** One editable item of a widget list, with reorder and remove controls. */
function ItemFrame({ title, index, count, min, onMove, onRemove, children }: {
  title: string; index: number; count: number; min: number; onMove: (to: number) => void; onRemove: () => void; children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-stone-700 p-2.5 space-y-2" role="group" aria-label={title}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-mono text-stone-400 flex-1 min-w-0 truncate">{title}</span>
        <button type="button" className={btnCls} disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={`Đưa ${title} lên`}>↑</button>
        <button type="button" className={btnCls} disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={`Đưa ${title} xuống`}>↓</button>
        <button type="button" className={btnCls} disabled={count <= min} onClick={onRemove}>Xoá</button>
      </div>
      {children}
    </div>
  );
}

function Body({ blocks, onChange, renderBody }: { blocks: Block[]; onChange: (blocks: Block[]) => void; renderBody: RenderBody }) {
  return <div className="rounded-xl border border-dashed border-stone-700 p-2.5">{renderBody(blocks, onChange)}</div>;
}

const without = <T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> => {
  const { [key]: _drop, ...rest } = obj;
  return rest;
};

// ---------- Tabs ----------

function TabsFields({ block, onChange, renderBody }: { block: TabsBlock; onChange: (b: Block) => void; renderBody: RenderBody }) {
  const setTabs = (tabs: TabItem[], defaultTab = block.defaultTab) => {
    const rest = without(block, 'defaultTab');
    const d = defaultTab !== undefined && defaultTab > 0 && defaultTab < tabs.length ? defaultTab : undefined;
    onChange(d === undefined ? { ...rest, tabs } : { ...rest, tabs, defaultTab: d });
  };
  const setTab = (i: number, tab: TabItem) => setTabs(block.tabs.map((t, j) => (j === i ? tab : t)));
  const labels = Object.fromEntries(block.tabs.map((t, i) => [String(i), `${i + 1}. ${t.label || '(chưa đặt tên)'}`]));
  const indices = block.tabs.map((_, i) => String(i));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Select label="Tab mở sẵn" value={String(block.defaultTab ?? 0)} options={indices} labels={labels} onChange={v => setTabs(block.tabs, Number(v))} />
        <Select label="Cấp tiêu đề (khi không có JS)" value={String(block.level ?? DEFAULT_CARD_LEVEL)} options={CARD_LEVELS.map(String)}
          onChange={v => { const level = CARD_LEVELS.find(l => String(l) === v); const rest = without(block, 'level'); onChange(level === undefined || level === DEFAULT_CARD_LEVEL ? rest : { ...rest, level }); }} />
      </div>
      {block.tabs.map((tab, i) => (
        <ItemFrame key={i} title={`Tab ${i + 1}`} index={i} count={block.tabs.length} min={LIMITS.tabsMin}
          onMove={to => setTabs(move(block.tabs, i, to), block.defaultTab === i ? to : block.defaultTab === to ? i : block.defaultTab)}
          onRemove={() => setTabs(block.tabs.filter((_, j) => j !== i), (block.defaultTab ?? 0) > i ? (block.defaultTab ?? 0) - 1 : block.defaultTab === i ? 0 : block.defaultTab)}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Text label="Nhãn" value={tab.label} onChange={label => setTab(i, { ...tab, label })} />
            <Text label="Neo (#anchor, tuỳ chọn)" value={tab.anchor ?? ''} onChange={anchor => { const rest = without(tab, 'anchor'); setTab(i, anchor ? { ...rest, anchor } : rest); }} />
          </div>
          <Body blocks={tab.blocks} onChange={blocks => setTab(i, { ...tab, blocks })} renderBody={renderBody} />
        </ItemFrame>
      ))}
      <button type="button" className={btnCls} disabled={block.tabs.length >= LIMITS.tabsMax}
        onClick={() => setTabs([...block.tabs, { label: `Tab ${block.tabs.length + 1}`, blocks: [] }])}>+ Tab</button>
      <p className="text-[11px] text-stone-500">Không có JavaScript (và trong Markdown, email) mọi tab hiện lần lượt dưới tiêu đề của nó. Neo cho phép mở thẳng một tab qua #neo.</p>
    </div>
  );
}

// ---------- Stat ----------

const TREND_LABELS = { up: 'Tăng ▲', down: 'Giảm ▼', flat: 'Ngang ▬' } as const;
const STAT_STATE_LABELS = { positive: 'Tích cực (xanh)', negative: 'Tiêu cực (đỏ)', neutral: 'Trung tính' } as const;

function StatItemFields({ item, onChange }: { item: StatItem; onChange: (item: StatItem) => void }) {
  const delta = item.delta;
  const setDelta = (next: StatDelta | undefined) => {
    const rest = without(item, 'delta');
    onChange(next ? { ...rest, delta: next } : rest);
  };
  const setOpt = (key: 'prefix' | 'suffix' | 'unit' | 'note', v: string) => { const rest = without(item, key); onChange(v ? { ...rest, [key]: v } : rest); };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Text label="Nhãn" value={item.label} onChange={label => onChange({ ...item, label })} />
        <NumInput label="Giá trị" value={item.value} required onChange={v => onChange({ ...item, value: v ?? 0 })} />
        <Decimals value={item.decimals} onChange={d => { const rest = without(item, 'decimals'); onChange(d === undefined ? rest : { ...rest, decimals: d }); }} />
        <Text label="Đơn vị (vd. người dùng)" value={item.unit ?? ''} onChange={v => setOpt('unit', v)} />
        <Text label="Tiền tố (vd. $)" value={item.prefix ?? ''} onChange={v => setOpt('prefix', v)} />
        <Text label="Hậu tố (vd. %)" value={item.suffix ?? ''} onChange={v => setOpt('suffix', v)} />
        <OptionalSelect label="Xu hướng" value={item.trend} options={STAT_TRENDS} labels={TREND_LABELS} none="Theo chênh lệch"
          onChange={trend => { const rest = without(item, 'trend'); onChange(trend ? { ...rest, trend } : rest); }} />
        <OptionalSelect label="Sắc thái" value={item.state} options={STAT_STATES} labels={STAT_STATE_LABELS} none="Theo xu hướng"
          onChange={state => { const rest = without(item, 'state'); onChange(state ? { ...rest, state } : rest); }} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <NumInput label="Chênh lệch (tuỳ chọn)" value={delta?.value} onChange={v => setDelta(v === undefined ? undefined : { ...(delta ?? {}), value: v })} />
        <Decimals label="Số lẻ chênh lệch" value={delta?.decimals} onChange={d => { if (delta) { const rest = without(delta, 'decimals'); setDelta(d === undefined ? rest : { ...rest, decimals: d }); } }} />
        <Text label="Hậu tố chênh lệch" value={delta?.suffix ?? ''} onChange={v => { if (delta) { const rest = without(delta, 'suffix'); setDelta(v ? { ...rest, suffix: v } : rest); } }} />
        <Text label="So với (vd. so với quý trước)" value={delta?.label ?? ''} onChange={v => { if (delta) { const rest = without(delta, 'label'); setDelta(v ? { ...rest, label: v } : rest); } }} />
      </div>
      <SparklineInput values={item.sparkline} onChange={sparkline => { const rest = without(item, 'sparkline'); onChange(sparkline ? { ...rest, sparkline } : rest); }} />
      <Text label="Ghi chú (tuỳ chọn)" value={item.note ?? ''} onChange={v => setOpt('note', v)} />
    </div>
  );
}

function SparklineInput({ values, onChange }: { values: number[] | undefined; onChange: (v: number[] | undefined) => void }) {
  const [raw, setRaw] = useState(values?.join(', ') ?? '');
  return (
    <Field label={`Đường xu hướng (${LIMITS.sparklineMin}–${LIMITS.sparklineMax} số, cách nhau dấu phẩy)`}>
      <input className={inputCls} value={raw} onChange={e => {
        setRaw(e.target.value);
        const nums = e.target.value.split(',').map(s => s.trim()).filter(Boolean).map(Number);
        onChange(nums.length > 0 && nums.every(Number.isFinite) ? nums : undefined);
      }} />
    </Field>
  );
}

function StatFields({ block, onChange }: { block: StatBlock; onChange: (b: Block) => void }) {
  const setItems = (items: StatItem[]) => onChange({ ...block, items });
  return (
    <div className="space-y-2">
      <Text label="Tiêu đề (tuỳ chọn)" value={block.title ?? ''} onChange={title => onChange({ ...block, title: opt(title) })} />
      {block.items.map((item, i) => (
        <ItemFrame key={i} title={`Chỉ số ${i + 1}`} index={i} count={block.items.length} min={1}
          onMove={to => setItems(move(block.items, i, to))} onRemove={() => setItems(block.items.filter((_, j) => j !== i))}>
          <StatItemFields item={item} onChange={next => setItems(block.items.map((x, j) => (j === i ? next : x)))} />
        </ItemFrame>
      ))}
      <button type="button" className={btnCls} disabled={block.items.length >= LIMITS.statItems}
        onClick={() => setItems([...block.items, { label: `Chỉ số ${block.items.length + 1}`, value: 0 }])}>+ Chỉ số</button>
    </div>
  );
}

// ---------- Steps ----------

const STEP_STATUS_LABELS = { done: 'Đã xong', current: 'Đang làm', upcoming: 'Sắp tới' } as const;

function StepsFields({ block, onChange, renderBody }: { block: StepsBlock; onChange: (b: Block) => void; renderBody: RenderBody }) {
  const setItems = (items: StepItem[]) => onChange({ ...block, items });
  const setItem = (i: number, item: StepItem) => setItems(block.items.map((x, j) => (j === i ? item : x)));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <Select label="Kiểu" value={block.variant} options={STEP_VARIANTS} labels={{ steps: 'Các bước', timeline: 'Dòng thời gian' }} onChange={variant => onChange({ ...block, variant })} />
        <Select label="Hướng" value={block.orientation ?? 'vertical'} options={STEP_ORIENTATIONS} labels={{ vertical: 'Dọc', horizontal: 'Ngang (≥ tablet)' }}
          onChange={o => { const rest = without(block, 'orientation'); onChange(o === 'horizontal' ? { ...rest, orientation: o } : rest); }} />
        <Select label="Đường nối" value={block.connector ?? 'line'} options={STEP_CONNECTORS} labels={{ line: 'Có', none: 'Không' }}
          onChange={c => { const rest = without(block, 'connector'); onChange(c === 'none' ? { ...rest, connector: c } : rest); }} />
      </div>
      {block.items.map((item, i) => (
        <ItemFrame key={i} title={`Bước ${i + 1}`} index={i} count={block.items.length} min={1}
          onMove={to => setItems(move(block.items, i, to))} onRemove={() => setItems(block.items.filter((_, j) => j !== i))}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Text label="Tiêu đề" value={item.title} onChange={title => setItem(i, { ...item, title })} />
            <Text label="Ngày / mốc (tuỳ chọn)" value={item.date ?? ''} onChange={v => { const rest = without(item, 'date'); setItem(i, v ? { ...rest, date: v } : rest); }} />
            <OptionalSelect label="Trạng thái" value={item.status} options={STEP_STATUSES} labels={STEP_STATUS_LABELS} none="Không ghi"
              onChange={status => { const rest = without(item, 'status'); setItem(i, status ? { ...rest, status } : rest); }} />
          </div>
          <IconPicker label="Icon (tuỳ chọn)" value={item.icon} noneLabel="Số thứ tự / dấu chấm"
            onChange={icon => { const rest = without(item, 'icon'); setItem(i, icon ? { ...rest, icon } : rest); }} />
          <Body blocks={item.blocks} onChange={blocks => setItem(i, { ...item, blocks })} renderBody={renderBody} />
        </ItemFrame>
      ))}
      <button type="button" className={btnCls} disabled={block.items.length >= LIMITS.stepItems}
        onClick={() => setItems([...block.items, { title: `Bước ${block.items.length + 1}`, blocks: [] }])}>+ Bước</button>
    </div>
  );
}

// ---------- Comparison ----------

type CellKind = 'yes' | 'no' | 'text';
const CELL_KINDS: readonly CellKind[] = ['yes', 'no', 'text'];

function CellInput({ label, value, onChange }: { label: string; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const kind: CellKind = value === true ? 'yes' : value === false ? 'no' : 'text';
  return (
    <div className="space-y-1 min-w-0">
      <Select label={label} value={kind} options={CELL_KINDS} labels={{ yes: '✓ Có', no: '✗ Không', text: 'Văn bản' }}
        onChange={k => onChange(k === 'yes' ? true : k === 'no' ? false : typeof value === 'string' ? value : '')} />
      {kind === 'text' && <input className={inputCls} aria-label={`${label} (văn bản)`} value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value)} />}
    </div>
  );
}

function ComparisonFields({ block, onChange, renderBody }: { block: ComparisonBlock; onChange: (b: Block) => void; renderBody: RenderBody }) {
  const features = block.features ?? [];
  const set = (options: ComparisonOption[], nextFeatures: ComparisonFeature[]) => {
    const rest = without(block, 'features');
    onChange(nextFeatures.length > 0 ? { ...rest, options, features: nextFeatures } : { ...rest, options });
  };
  const setOption = (i: number, o: ComparisonOption) => set(block.options.map((x, j) => (j === i ? o : x)), features);
  const setFeature = (r: number, f: ComparisonFeature) => set(block.options, features.map((x, j) => (j === r ? f : x)));
  return (
    <div className="space-y-2">
      <Text label="Tiêu đề (tuỳ chọn)" value={block.title ?? ''} onChange={title => onChange({ ...block, title: opt(title) })} />
      {block.options.map((o, i) => (
        <ItemFrame key={i} title={`Lựa chọn ${i + 1}`} index={i} count={block.options.length} min={LIMITS.comparisonOptionsMin}
          onMove={to => set(move(block.options, i, to), features.map(f => ({ ...f, values: move(f.values, i, to) })))}
          onRemove={() => set(block.options.filter((_, j) => j !== i), features.map(f => ({ ...f, values: f.values.filter((_, j) => j !== i) })))}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
            <Text label="Tên" value={o.name} onChange={name => setOption(i, { ...o, name })} />
            <Text label="Nhãn (badge, tuỳ chọn)" value={o.badge ?? ''} onChange={v => { const rest = without(o, 'badge'); setOption(i, v ? { ...rest, badge: v } : rest); }} />
            <label className="text-[11px] text-stone-300 flex items-center gap-1.5 min-h-[34px]">
              <input type="checkbox" checked={o.highlight === true}
                onChange={e => set(block.options.map((x, j) => { const rest = without(x, 'highlight'); return j === i && e.target.checked ? { ...rest, highlight: true } : rest; }), features)} />
              Đề xuất (chỉ một lựa chọn)
            </label>
          </div>
          <Text label="Mô tả (tuỳ chọn)" value={o.description ?? ''} onChange={v => { const rest = without(o, 'description'); setOption(i, v ? { ...rest, description: v } : rest); }} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Area label="Ưu điểm (mỗi dòng một ý)" rows={2} value={(o.pros ?? []).join('\n')}
              onChange={v => { const rest = without(o, 'pros'); const pros = lines(v); setOption(i, pros ? { ...rest, pros } : rest); }} />
            <Area label="Nhược điểm (mỗi dòng một ý)" rows={2} value={(o.cons ?? []).join('\n')}
              onChange={v => { const rest = without(o, 'cons'); const cons = lines(v); setOption(i, cons ? { ...rest, cons } : rest); }} />
          </div>
          <Body blocks={o.blocks} onChange={blocks => setOption(i, { ...o, blocks })} renderBody={renderBody} />
        </ItemFrame>
      ))}
      <button type="button" className={btnCls} disabled={block.options.length >= LIMITS.comparisonOptionsMax}
        onClick={() => set([...block.options, { name: `Lựa chọn ${block.options.length + 1}`, blocks: [] }], features.map(f => ({ ...f, values: [...f.values, false] })))}>+ Lựa chọn</button>
      <p className="text-[11px] font-mono uppercase tracking-widest text-stone-500 pt-1">Bảng tính năng</p>
      {features.map((f, r) => (
        <ItemFrame key={r} title={`Tính năng ${r + 1}`} index={r} count={features.length} min={0}
          onMove={to => set(block.options, move(features, r, to))} onRemove={() => set(block.options, features.filter((_, j) => j !== r))}>
          <Text label="Tính năng" value={f.label} onChange={label => setFeature(r, { ...f, label })} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {block.options.map((o, i) => (
              <CellInput key={i} label={o.name || `Lựa chọn ${i + 1}`} value={f.values[i] ?? false}
                onChange={v => setFeature(r, { ...f, values: block.options.map((_, j) => (j === i ? v : f.values[j] ?? false)) })} />
            ))}
          </div>
        </ItemFrame>
      ))}
      <button type="button" className={btnCls} disabled={features.length >= LIMITS.comparisonFeatures}
        onClick={() => set(block.options, [...features, { label: `Tính năng ${features.length + 1}`, values: block.options.map(() => true) }])}>+ Tính năng</button>
    </div>
  );
}

// ---------- Progress ----------

const PROGRESS_VARIANT_LABELS = { bar: 'Thanh', segments: 'Thanh chia đoạn', gauge: 'Đồng hồ', rating: 'Sao (điểm)' } as const;
const PROGRESS_STATE_LABELS = { positive: 'Tốt', warning: 'Cần chú ý', negative: 'Kém', neutral: 'Trung tính' } as const;

function ProgressFields({ block, onChange }: { block: ProgressBlock; onChange: (b: Block) => void }) {
  const thresholds = block.thresholds ?? [];
  const setItems = (items: ProgressItem[]) => onChange({ ...block, items });
  const setItem = (i: number, item: ProgressItem) => setItems(block.items.map((x, j) => (j === i ? item : x)));
  const setThresholds = (next: ProgressBlock['thresholds']) => { const rest = without(block, 'thresholds'); onChange(next && next.length > 0 ? { ...rest, thresholds: next } : rest); };
  const setVariant = (variant: ProgressBlock['variant']) => {
    const rest = without(without(without(block, 'segments'), 'min'), 'max');
    if (variant === 'rating') onChange({ ...rest, variant });
    else onChange({ ...rest, variant, ...(block.variant === 'rating' ? {} : { min: block.min, max: block.max }) });
  };
  const rating = block.variant === 'rating';
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Select label="Kiểu" value={block.variant} options={PROGRESS_VARIANTS} labels={PROGRESS_VARIANT_LABELS} onChange={setVariant} />
        <Text label="Tiêu đề (tuỳ chọn)" value={block.title ?? ''} onChange={title => onChange({ ...block, title: opt(title) })} />
        {rating ? (
          <Field label="Số sao">
            <select className={inputCls} value={block.max ?? DEFAULT_RATING_MAX}
              onChange={e => { const max = Number(e.target.value); const rest = without(block, 'max'); onChange(max === DEFAULT_RATING_MAX ? rest : { ...rest, max }); }}>
              {Array.from({ length: LIMITS.ratingMax }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
        ) : (
          <>
            <NumInput label="Tối thiểu (0)" value={block.min} onChange={min => { const rest = without(block, 'min'); onChange(min === undefined || min === 0 ? rest : { ...rest, min }); }} />
            <NumInput label="Tối đa (100)" value={block.max} onChange={max => { const rest = without(block, 'max'); onChange(max === undefined || max === 100 ? rest : { ...rest, max }); }} />
          </>
        )}
        {block.variant === 'segments' && (
          <Field label="Số đoạn">
            <select className={inputCls} value={block.segments ?? DEFAULT_PROGRESS_SEGMENTS}
              onChange={e => { const segments = Number(e.target.value); const rest = without(block, 'segments'); onChange(segments === DEFAULT_PROGRESS_SEGMENTS ? rest : { ...rest, segments }); }}>
              {Array.from({ length: LIMITS.progressSegmentsMax - LIMITS.progressSegmentsMin + 1 }, (_, i) => i + LIMITS.progressSegmentsMin).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
        )}
        <Decimals value={block.decimals} onChange={d => { const rest = without(block, 'decimals'); onChange(d === undefined ? rest : { ...rest, decimals: d }); }} />
        {!rating && <Text label="Hậu tố (vd. %, điểm)" value={block.suffix ?? ''} onChange={v => { const rest = without(block, 'suffix'); onChange(v ? { ...rest, suffix: v } : rest); }} />}
      </div>
      {block.items.map((item, i) => (
        <ItemFrame key={i} title={`Mục ${i + 1}`} index={i} count={block.items.length} min={1}
          onMove={to => setItems(move(block.items, i, to))} onRemove={() => setItems(block.items.filter((_, j) => j !== i))}>
          <div className="grid grid-cols-2 gap-2">
            <Text label="Nhãn" value={item.label} onChange={label => setItem(i, { ...item, label })} />
            <NumInput label="Giá trị" value={item.value} required onChange={v => setItem(i, { ...item, value: v ?? 0 })} />
          </div>
          <Text label="Ghi chú (tuỳ chọn)" value={item.note ?? ''} onChange={v => { const rest = without(item, 'note'); setItem(i, v ? { ...rest, note: v } : rest); }} />
        </ItemFrame>
      ))}
      <button type="button" className={btnCls} disabled={block.items.length >= LIMITS.progressItems}
        onClick={() => setItems([...block.items, { label: `Mục ${block.items.length + 1}`, value: 0 }])}>+ Mục</button>
      <p className="text-[11px] font-mono uppercase tracking-widest text-stone-500 pt-1">Ngưỡng (tăng dần; giá trị từ ngưỡng trở lên lấy sắc thái đó)</p>
      {thresholds.map((t, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
          <NumInput label={`Ngưỡng ${i + 1}`} value={t.at} required onChange={at => setThresholds(thresholds.map((x, j) => (j === i ? { ...x, at: at ?? 0 } : x)))} />
          <Select label="Sắc thái" value={t.state} options={PROGRESS_STATES} labels={PROGRESS_STATE_LABELS} onChange={state => setThresholds(thresholds.map((x, j) => (j === i ? { ...x, state } : x)))} />
          <button type="button" className={btnCls} onClick={() => setThresholds(thresholds.filter((_, j) => j !== i))}>Xoá</button>
        </div>
      ))}
      <button type="button" className={btnCls} disabled={thresholds.length >= LIMITS.progressThresholds}
        onClick={() => setThresholds([...thresholds, { at: (thresholds[thresholds.length - 1]?.at ?? (block.min ?? 0)) + 1, state: 'positive' }])}>+ Ngưỡng</button>
    </div>
  );
}

/** Studio editors of the composition widgets (tabs, stat, steps, comparison, progress). */
export function CompositionFields({ block, onChange, renderBody }: { block: CompositionBlock; onChange: (b: Block) => void; renderBody: RenderBody }) {
  switch (block.type) {
    case 'tabs': return <TabsFields block={block} onChange={onChange} renderBody={renderBody} />;
    case 'stat': return <StatFields block={block} onChange={onChange} />;
    case 'steps': return <StepsFields block={block} onChange={onChange} renderBody={renderBody} />;
    case 'comparison': return <ComparisonFields block={block} onChange={onChange} renderBody={renderBody} />;
    case 'progress': return <ProgressFields block={block} onChange={onChange} />;
  }
}
