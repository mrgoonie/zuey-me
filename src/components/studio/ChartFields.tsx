import { useState } from 'react';
import { CHART_KINDS, CHART_LEGENDS, CHART_SERIES_TYPES, LIMITS } from '../../lib/blocks/schema';
import type { Block, ChartAnnotation, ChartAxis, ChartBlock, ChartKind, ChartLegend, ChartReference, ChartSeries, ChartSeriesType } from '../../lib/blocks/schema';
import { CARTESIAN_KINDS, CATEGORY_KINDS, axisFields, chartForKind } from '../../lib/blocks/chart-data';
import { Field, Select, Text, btnCls, inputCls } from './knowledge-studio-kit';

const KIND_LABELS: Record<ChartKind, string> = {
  bar: 'Cột', line: 'Đường', pie: 'Tròn', doughnut: 'Vành khuyên', area: 'Vùng', scatter: 'Phân tán (x, y)', radar: 'Radar', combo: 'Kết hợp cột + đường',
};
const SERIES_TYPE_LABELS: Record<ChartSeriesType, string> = { bar: 'Cột', line: 'Đường', area: 'Vùng' };
const LEGEND_OPTIONS = ['auto', ...CHART_LEGENDS] as const;
const LEGEND_LABELS: Record<(typeof LEGEND_OPTIONS)[number], string> = { auto: 'Tự động', top: 'Phía trên', bottom: 'Phía dưới', none: 'Ẩn' };
const VALUE_FORMATS = ['number', 'percent', 'currency'] as const;
const VALUE_FORMAT_LABELS: Record<(typeof VALUE_FORMATS)[number], string> = { number: 'Số', percent: 'Phần trăm (12.5 = 12,5%)', currency: 'Tiền tệ' };
const LABEL_FORMATS = ['text', 'date'] as const;
const AXIS_NAMES: Record<'x' | 'y' | 'y2', string> = { x: 'Trục ngang (x)', y: 'Trục giá trị (y)', y2: 'Trục phải (y2)' };

type ChartFlag = 'stacked' | 'dataLabels' | 'csv' | 'png';

const toNumbers = (raw: string): number[] => raw.split(',').map(s => s.trim()).filter(Boolean).map(Number);

/** Keeps the raw text locally so typing separators or a minus sign is not disrupted, committing on each change. */
function RawInput({ label, initial, onCommit, placeholder }: { label: string; initial: string; onCommit: (raw: string) => void; placeholder?: string }) {
  const [raw, setRaw] = useState(initial);
  return <Field label={label}><input className={inputCls} value={raw} placeholder={placeholder} onChange={e => { setRaw(e.target.value); onCommit(e.target.value); }} /></Field>;
}

/** An optional number: empty or not a number removes it. */
function NumberInput({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <RawInput label={label} initial={value === undefined ? '' : String(value)}
      onCommit={raw => { const n = Number(raw.trim()); onChange(raw.trim() && Number.isFinite(n) ? n : undefined); }} />
  );
}

/** One axis: only the fields this chart kind uses; unset fields are removed, an empty axis is removed. */
function AxisFields({ block, axisKey, onChange }: { block: ChartBlock; axisKey: 'x' | 'y' | 'y2'; onChange: (b: ChartBlock) => void }) {
  const fields = axisFields(block.kind, axisKey);
  if (fields.length === 0) return null;
  const axis: ChartAxis = block[axisKey] ?? {};
  const set = <K extends keyof ChartAxis>(field: K, value: ChartAxis[K] | undefined) => {
    const nextAxis: ChartAxis = { ...axis };
    if (value === undefined || value === '') delete nextAxis[field]; else nextAxis[field] = value;
    if (nextAxis.format !== 'currency') delete nextAxis.currency;
    const next = { ...block };
    if (Object.keys(nextAxis).length === 0) delete next[axisKey]; else next[axisKey] = nextAxis;
    onChange(next);
  };
  const has = (f: keyof ChartAxis) => fields.includes(f);
  const labelAxis = axisKey === 'x' && block.kind !== 'scatter';
  return (
    <fieldset className="rounded-lg border border-stone-800 p-2 space-y-2">
      <legend className="text-[11px] text-stone-300 px-1">{AXIS_NAMES[axisKey]}</legend>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {has('title') && <Text label="Tên trục" value={axis.title ?? ''} onChange={v => set('title', v.trim() ? v : undefined)} />}
        {has('format') && (labelAxis
          ? <Select label="Nhãn là" value={axis.format === 'date' ? 'date' : 'text'} options={LABEL_FORMATS} labels={{ text: 'Chữ', date: 'Ngày (2026-01 hoặc 2026-01-15)' }}
              onChange={v => set('format', v === 'date' ? 'date' : undefined)} />
          : <Select label="Định dạng" value={axis.format === 'percent' || axis.format === 'currency' ? axis.format : 'number'} options={VALUE_FORMATS} labels={VALUE_FORMAT_LABELS}
              onChange={v => { const next = v === 'number' ? undefined : v; set('format', next); }} />)}
        {has('currency') && axis.format === 'currency' && (
          <Text label="Mã tiền" value={axis.currency ?? ''} placeholder="VND" onChange={v => set('currency', v.trim() ? v.toUpperCase() : undefined)} />
        )}
        {has('decimals') && (
          <Field label="Số lẻ">
            <select className={inputCls} value={axis.decimals === undefined ? '' : String(axis.decimals)}
              onChange={e => set('decimals', e.target.value === '' ? undefined : Number(e.target.value))}>
              <option value="">–</option>
              {Array.from({ length: LIMITS.chartDecimalsMax + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Field>
        )}
        {has('unit') && <Text label="Đơn vị (sau số)" value={axis.unit ?? ''} placeholder="triệu" onChange={v => set('unit', v.trim() ? v : undefined)} />}
        {has('min') && <NumberInput key={`${axisKey}-min`} label="Nhỏ nhất" value={axis.min} onChange={v => set('min', v)} />}
        {has('max') && <NumberInput key={`${axisKey}-max`} label="Lớn nhất" value={axis.max} onChange={v => set('max', v)} />}
      </div>
    </fieldset>
  );
}

/**
 * Chart editor: kind, labels and series, plus the optional v2 settings (axes, legend, marks, downloads). Only
 * the settings the current kind uses are shown, and unset options are removed rather than stored, like the
 * validator normalises them; switching kind drops what the new kind cannot use.
 */
export function ChartFields({ block, onChange }: { block: ChartBlock; onChange: (b: Block) => void }) {
  const category = CATEGORY_KINDS.includes(block.kind);
  const cartesian = CARTESIAN_KINDS.includes(block.kind);
  const hasRight = block.series.some(s => s.axis === 'right');
  // Series edits can remove the last right-axis series, which also removes y2.
  const setSeries = (series: ChartSeries[]) => onChange(chartForKind({ ...block, series }, block.kind));
  const setOne = (i: number, s: ChartSeries) => setSeries(block.series.map((x, j) => (j === i ? s : x)));
  const without = <K extends keyof ChartBlock>(key: K): ChartBlock => { const next = { ...block }; delete next[key]; return next; };
  const setFlag = (key: ChartFlag, on: boolean) => onChange(on ? { ...block, [key]: true } : without(key));
  const flagBox = (key: ChartFlag, label: string) => (
    <label className="text-[11px] text-stone-300 flex items-center gap-1.5">
      <input type="checkbox" checked={block[key] === true} onChange={e => setFlag(key, e.target.checked)} />
      {label}
    </label>
  );
  const references = block.references ?? [];
  const setReferences = (next: ChartReference[]) => onChange(next.length ? { ...block, references: next } : without('references'));
  const annotations = block.annotations ?? [];
  const setAnnotations = (next: ChartAnnotation[]) => onChange(next.length ? { ...block, annotations: next } : without('annotations'));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Select label="Loại" value={block.kind} options={CHART_KINDS} labels={KIND_LABELS} onChange={kind => onChange(chartForKind(block, kind))} />
        <Text label="Tiêu đề" value={block.title ?? ''} onChange={title => onChange(title ? { ...block, title } : without('title'))} />
      </div>
      <RawInput label="Nhãn (phân cách bằng dấu phẩy)" initial={block.labels.join(', ')} onCommit={raw => onChange({ ...block, labels: raw.split(',').map(s => s.trim()) })} />
      {block.series.map((s, i) => (
        // Keyed with the count so removing a series remounts the rows: their number inputs keep local text.
        <div key={`${i}-${block.series.length}`} className="rounded-lg border border-stone-800 p-2 space-y-2">
          <div className="grid grid-cols-[1fr_2fr_auto] gap-2 items-end">
            <Text label={`Series ${i + 1}`} value={s.name} onChange={name => setOne(i, { ...s, name })} />
            <RawInput label={block.kind === 'scatter' ? `Giá trị y (${block.labels.length} điểm)` : `Số liệu (${block.labels.length} giá trị)`} initial={s.data.join(', ')}
              onCommit={raw => setOne(i, { ...s, data: toNumbers(raw) })} />
            <button type="button" className={btnCls} disabled={block.series.length <= 1}
              onClick={() => setSeries(block.series.filter((_, j) => j !== i))}>Xoá</button>
          </div>
          {block.kind === 'scatter' && (
            <RawInput label="Giá trị x (mỗi nhãn một giá trị)" initial={(s.x ?? []).join(', ')} onCommit={raw => setOne(i, { ...s, x: toNumbers(raw) })} />
          )}
          {(block.kind === 'combo' || category) && (
            <div className="flex flex-wrap gap-x-4 gap-y-2 items-end">
              {block.kind === 'combo' && (
                <div className="w-40">
                  <Select label="Vẽ dạng" value={s.type ?? 'bar'} options={CHART_SERIES_TYPES} labels={SERIES_TYPE_LABELS}
                    onChange={type => { const { type: _old, ...rest } = s; setOne(i, type === 'bar' ? rest : { ...rest, type }); }} />
                </div>
              )}
              <label className="text-[11px] text-stone-300 flex items-center gap-1.5 pb-2">
                <input type="checkbox" checked={s.axis === 'right'}
                  onChange={e => { const { axis: _old, ...rest } = s; setOne(i, e.target.checked ? { ...rest, axis: 'right' } : rest); }} />
                Dùng trục phải
              </label>
            </div>
          )}
        </div>
      ))}
      <button type="button" className={btnCls} disabled={block.series.length >= LIMITS.chartSeries}
        onClick={() => setSeries([...block.series, {
          name: `Series ${block.series.length + 1}`,
          data: block.labels.map(() => 0),
          ...(block.kind === 'scatter' ? { x: block.labels.map((_, j) => j + 1) } : {}),
        }])}>+ Series</button>

      <details className="rounded-lg border border-stone-800 p-2">
        <summary className="text-[11px] text-stone-300 cursor-pointer">Trục, chú giải, đường mốc và tải xuống</summary>
        <div className="space-y-2 mt-2">
          <div className="grid grid-cols-2 gap-2">
            <Text label="Chú thích dưới biểu đồ (tuỳ chọn)" value={block.caption ?? ''} onChange={caption => onChange(caption.trim() ? { ...block, caption } : without('caption'))} />
            <Select label="Chú giải" value={block.legend ?? 'auto'} options={LEGEND_OPTIONS} labels={LEGEND_LABELS}
              onChange={legend => onChange(legend === 'auto' ? without('legend') : { ...block, legend: legend satisfies ChartLegend })} />
          </div>
          <AxisFields block={block} axisKey="x" onChange={onChange} />
          <AxisFields block={block} axisKey="y" onChange={onChange} />
          {hasRight && <AxisFields block={block} axisKey="y2" onChange={onChange} />}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {category && flagBox('stacked', 'Xếp chồng')}
            {flagBox('dataLabels', 'Hiện giá trị trên biểu đồ')}
            {flagBox('csv', 'Tải CSV')}
            {flagBox('png', 'Tải PNG')}
          </div>

          {cartesian && (
            <div className="space-y-2">
              <p className="text-[11px] text-stone-300">Đường mốc (đường ngang tại một giá trị, vd. mục tiêu)</p>
              {references.map((r, i) => (
                <div key={`${i}-${references.length}`} className="grid grid-cols-[6rem_1fr_auto_auto] gap-2 items-end">
                  <NumberInput label="Giá trị" value={r.value}
                    onChange={value => { if (value !== undefined) setReferences(references.map((x, j) => (j === i ? { ...x, value } : x))); }} />
                  <Text label="Nhãn" value={r.label ?? ''}
                    onChange={label => setReferences(references.map((x, j) => { if (j !== i) return x; const { label: _old, ...rest } = x; return label.trim() ? { ...rest, label } : rest; }))} />
                  {hasRight
                    ? (
                      <label className="text-[11px] text-stone-300 flex items-center gap-1.5 pb-2">
                        <input type="checkbox" checked={r.axis === 'right'}
                          onChange={e => setReferences(references.map((x, j) => { if (j !== i) return x; const { axis: _old, ...rest } = x; return e.target.checked ? { ...rest, axis: 'right' } : rest; }))} />
                        Trục phải
                      </label>
                    )
                    : <span />}
                  <button type="button" className={btnCls} onClick={() => setReferences(references.filter((_, j) => j !== i))}>Xoá</button>
                </div>
              ))}
              <button type="button" className={btnCls} disabled={references.length >= LIMITS.chartReferences}
                onClick={() => setReferences([...references, { value: 0 }])}>+ Đường mốc</button>
            </div>
          )}

          {category && (
            <div className="space-y-2">
              <p className="text-[11px] text-stone-300">Ghi chú tại một nhãn (đường dọc kèm chữ)</p>
              {annotations.map((a, i) => {
                // Shortening the labels can leave a note on a label that no longer exists: it is kept (with its
                // text) and flagged until the author picks a label or removes it, since saving would fail.
                const missing = a.index >= block.labels.length;
                return (
                  <div key={`${i}-${annotations.length}`} className="space-y-1">
                    <div className="grid grid-cols-[10rem_1fr_auto] gap-2 items-end">
                      <Field label="Tại nhãn">
                        <select className={inputCls} value={String(a.index)} aria-invalid={missing || undefined}
                          onChange={e => setAnnotations(annotations.map((x, j) => (j === i ? { ...x, index: Number(e.target.value) } : x)))}>
                          {block.labels.map((l, j) => <option key={j} value={j}>{l || `#${j + 1}`}</option>)}
                          {missing && <option value={a.index}>{`#${a.index + 1} (không còn)`}</option>}
                        </select>
                      </Field>
                      <Text label="Nội dung" value={a.text} onChange={text => setAnnotations(annotations.map((x, j) => (j === i ? { ...x, text } : x)))} />
                      <button type="button" className={btnCls} onClick={() => setAnnotations(annotations.filter((_, j) => j !== i))}>Xoá</button>
                    </div>
                    {missing && <p role="alert" className="text-[11px] text-red-400">Nhãn #{a.index + 1} không còn: chọn nhãn khác hoặc xoá ghi chú này.</p>}
                  </div>
                );
              })}
              <button type="button" className={btnCls} disabled={annotations.length >= LIMITS.chartAnnotations || block.labels.length === 0}
                onClick={() => setAnnotations([...annotations, { index: 0, text: '' }])}>+ Ghi chú</button>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
