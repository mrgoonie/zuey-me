import { useEffect, useRef, useState } from 'react';
import type { ChartBlock as ChartBlockData } from '../../lib/blocks/schema';

const PALETTE = ['#d97706', '#1c1917', '#0f766e', '#be123c', '#4338ca', '#65a30d', '#c2410c', '#0369a1', '#a21caf', '#57534e', '#ca8a04', '#15803d'];

/**
 * SSR renders an accessible data table; on the client, Chart.js is loaded lazily
 * (dynamic import inside the effect only, so it never enters the server bundle)
 * and the table becomes screen-reader-only once the canvas is drawn.
 */
export function ChartBlock({ block }: { block: ChartBlockData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | undefined;
    // Statically false in the SSR bundle so the bundler drops chart.js from the edge worker.
    if (import.meta.env.SSR) return;
    import('chart.js/auto')
      .then(({ default: Chart }) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const circular = block.kind === 'pie' || block.kind === 'doughnut';
        const chart = new Chart(canvas, {
          type: block.kind,
          data: {
            labels: block.labels,
            datasets: block.series.map((s, i) => ({
              label: s.name,
              data: s.data,
              backgroundColor: circular ? block.labels.map((_, j) => PALETTE[j % PALETTE.length]) : PALETTE[i % PALETTE.length],
              borderColor: circular ? '#fffdf9' : PALETTE[i % PALETTE.length],
              borderWidth: circular ? 2 : 2,
              tension: 0.3,
            })),
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : undefined,
            plugins: { legend: { display: circular || block.series.length > 1 } },
          },
        });
        destroy = () => chart.destroy();
        setReady(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [block]);

  const caption = block.title || `${block.kind} chart`;
  return (
    <figure className="zb-figure zb-chart">
      {block.title && <figcaption className="zb-h zb-h3" style={{ marginBottom: '0.5rem' }}>{block.title}</figcaption>}
      <canvas ref={canvasRef} aria-hidden="true" style={ready ? undefined : { display: 'none' }} />
      <div className={ready ? 'zb-sr-only' : 'zb-scroll'}>
        <table className="zb-table">
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Label</th>
              {block.series.map(s => <th scope="col" key={s.name}>{s.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {block.labels.map((label, i) => (
              <tr key={`${label}-${i}`}>
                <th scope="row">{label}</th>
                {block.series.map(s => <td className="zb-num" key={s.name}>{s.data[i]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failed && <p className="zb-note">Không tải được biểu đồ; dữ liệu hiển thị dạng bảng.</p>}
    </figure>
  );
}
