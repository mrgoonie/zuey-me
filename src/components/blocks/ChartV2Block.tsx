import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Chart } from 'chart.js';
import type { ChartBlock, ChartKind } from '../../lib/blocks/schema';
import { chartCsv, chartFilename, chartGrid, formatChartLabel, formatChartValue, isCircular, paletteColor } from '../../lib/blocks/chart-data';
import { chartConfig } from '../../lib/blocks/chart-config';
import { tableLocale } from '../../lib/blocks/table-data';
import { BlockFrame } from './BlockFrame';
import type { BlockDownload, BlockFrameDownload, BlockFrameLabels } from './BlockFrame';

const KIND_NAMES: Record<'vi' | 'en', Record<ChartKind, string>> = {
  vi: { bar: 'cột', line: 'đường', pie: 'tròn', doughnut: 'vành khuyên', area: 'vùng', scatter: 'phân tán', radar: 'radar', combo: 'kết hợp' },
  en: { bar: 'bar', line: 'line', pie: 'pie', doughnut: 'doughnut', area: 'area', scatter: 'scatter', radar: 'radar', combo: 'combo' },
};

const LABELS = {
  vi: {
    csv: 'Tải CSV',
    png: 'Tải PNG',
    legend: 'Chú giải: bấm để ẩn hoặc hiện',
    showAll: 'Hiện tất cả',
    label: 'Nhãn',
    failed: 'Không tải được biểu đồ; dữ liệu hiển thị dạng bảng.',
    chart: (kind: ChartKind) => `Biểu đồ ${KIND_NAMES.vi[kind]}`,
    frame: {} satisfies Partial<BlockFrameLabels>,
  },
  en: {
    csv: 'Download CSV',
    png: 'Download PNG',
    legend: 'Legend: press to hide or show',
    showAll: 'Show all',
    label: 'Label',
    failed: 'The chart could not load; the data is shown as a table.',
    chart: (kind: ChartKind) => `${KIND_NAMES.en[kind].charAt(0).toUpperCase()}${KIND_NAMES.en[kind].slice(1)} chart`,
    frame: { fullscreen: 'Full screen', exitFullscreen: 'Exit full screen', download: 'Download' } satisfies Partial<BlockFrameLabels>,
  },
};

export interface ChartV2Props {
  block: ChartBlock;
  /** Renders inline Markdown (the caption). */
  renderInline: (text: string) => ReactNode;
  /** Edition locale: number and date style and label language (Vietnamese for `vi`, English otherwise). */
  locale?: string;
}

/** The drawn chart on the page background (canvases are transparent), as a PNG file. */
function pngDownload(canvas: HTMLCanvasElement, filename: string): BlockDownload {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#fffdf9';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
  }
  // toDataURL is synchronous, so the download still runs inside the click.
  const url = (ctx ? out : canvas).toDataURL('image/png');
  const bytes = atob(url.slice(url.indexOf(',') + 1));
  const data = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) data[i] = bytes.charCodeAt(i);
  return { filename, data: new Blob([data], { type: 'image/png' }) };
}

/**
 * Chart v2. The server renders the data as a table with formatted values (readers without script and search
 * engines get every figure); on the client Chart.js is imported inside the effect only, so it never enters the
 * server bundle, and the table becomes screen-reader-only once the canvas is drawn. The legend is a row of toggle
 * buttons (keyboard and screen-reader operable) shown once the chart is ready. If Chart.js fails to load, the
 * table stays with a note.
 */
export function ChartV2({ block, renderInline, locale: editionLocale }: ChartV2Props) {
  const locale = tableLocale(editionLocale);
  const text = LABELS[locale];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    // Statically false in the SSR bundle so the bundler drops chart.js from the edge worker.
    if (import.meta.env.SSR) return;
    import('chart.js/auto')
      .then(({ default: ChartJs }) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        chartRef.current = new ChartJs(canvas, chartConfig(block, { locale, reducedMotion }));
        setHidden(new Set());
        setReady(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [block, locale]);

  const circular = isCircular(block.kind);
  const legendItems = circular
    ? block.labels.map((l, i) => ({ name: formatChartLabel(block, l, locale), color: paletteColor(i) }))
    : block.series.map((s, i) => ({ name: s.name, color: paletteColor(i) }));
  // Same default as the original charts (several series, or slices); an explicit position always shows it.
  const showLegend = ready && block.legend !== 'none' && (block.legend !== undefined || circular || block.series.length > 1);

  const setVisible = (chart: Chart, i: number, visible: boolean) => {
    if (circular) {
      if (chart.getDataVisibility(i) !== visible) chart.toggleDataVisibility(i);
    } else {
      chart.setDatasetVisibility(i, visible);
    }
  };
  const toggle = (i: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    const next = new Set(hidden);
    if (next.has(i)) next.delete(i); else next.add(i);
    setVisible(chart, i, !next.has(i));
    chart.update();
    setHidden(next);
  };
  const showAll = () => {
    const chart = chartRef.current;
    if (!chart) return;
    hidden.forEach(i => setVisible(chart, i, true));
    chart.update();
    setHidden(new Set());
  };

  const legend = showLegend && (
    <div className="zb-chart-legend" role="group" aria-label={text.legend}>
      {legendItems.map((item, i) => (
        <button type="button" key={i} className="zb-chart-legend-item" aria-pressed={!hidden.has(i)} onClick={() => toggle(i)}>
          <span className="zb-chart-swatch" style={{ background: item.color }} aria-hidden="true" />
          {item.name}
        </button>
      ))}
      {hidden.size > 0 && <button type="button" className="zb-chart-legend-reset" onClick={showAll}>{text.showAll}</button>}
    </div>
  );

  const labelHeader = block.x?.title ?? text.label;
  const grid = chartGrid(block, labelHeader, (n, axis) => formatChartValue(n, axis, locale), l => formatChartLabel(block, l, locale));
  const downloads: BlockFrameDownload[] = [];
  if (block.csv) downloads.push({ label: text.csv, file: () => ({ filename: chartFilename(block, 'csv'), data: chartCsv(block, labelHeader), type: 'text/csv;charset=utf-8' }) });
  const canvas = canvasRef.current;
  if (block.png && ready && canvas) downloads.push({ label: text.png, file: () => pngDownload(canvas, chartFilename(block, 'png')) });

  return (
    <BlockFrame
      className="zb-chart zb-chart-v2"
      title={block.title || undefined}
      caption={block.caption ? renderInline(block.caption) : undefined}
      fullscreen
      downloads={downloads}
      labels={text.frame}
    >
      {block.legend !== 'bottom' && legend}
      <canvas ref={canvasRef} aria-hidden="true" style={ready ? undefined : { display: 'none' }} />
      {block.legend === 'bottom' && legend}
      <div className={ready ? 'zb-sr-only' : 'zb-scroll'}>
        <table className="zb-table">
          {/* The frame already shows the title: the caption only names the table for screen readers. */}
          <caption className={block.title ? 'zb-sr-only' : undefined}>{block.title || text.chart(block.kind)}</caption>
          <thead>
            <tr>{grid.headers.map((h, i) => <th scope="col" key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {grid.rows.map(([label, ...values], r) => (
              <tr key={r}>
                <th scope="row">{label}</th>
                {values.map((v, c) => <td className="zb-num" key={c}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failed && <p className="zb-note">{text.failed}</p>}
    </BlockFrame>
  );
}

export default ChartV2;
