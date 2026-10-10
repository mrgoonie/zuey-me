import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DiagramBlock as DiagramBlockData } from '../../lib/blocks/schema';

let renderCounter = 0;

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const STEP = 1.4;

interface View { scale: number; x: number; y: number }
const FIT: View = { scale: 1, x: 0, y: 0 };

/** Keeps the zoomed content covering the viewport (transform-origin is the top-left corner). */
function clampView(view: View, width: number, height: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
  if (scale === MIN_SCALE) return FIT;
  return {
    scale,
    x: Math.min(0, Math.max(width * (1 - scale), view.x)),
    y: Math.min(0, Math.max(height * (1 - scale), view.y)),
  };
}

/** Zooms to `nextScale` while keeping the viewport point (px, py) fixed under the cursor/fingers. */
function zoomAt(view: View, nextScale: number, px: number, py: number): View {
  const ratio = nextScale / view.scale;
  return { scale: nextScale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

/**
 * SSR shows the Mermaid source as a code block. On the client Mermaid is imported lazily
 * (inside the effect only) and renders with securityLevel 'strict', which sanitizes the SVG.
 * The SVG always fits the column width; readers zoom (buttons, pinch, Ctrl/⌘ + wheel) and drag to inspect.
 */
export function DiagramBlock({ block }: { block: DiagramBlockData }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Statically false in the SSR bundle so the bundler drops mermaid from the edge worker.
    if (import.meta.env.SSR) return;
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        // Natural-size SVG; CSS scales it down to the column width and keeps small diagrams unstretched.
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false }, gantt: { useMaxWidth: false } });
        renderCounter += 1;
        const renderId = `zbm-${block.id.replace(/[^A-Za-z0-9_-]/g, '')}-${renderCounter}`;
        const result = await mermaid.render(renderId, block.source);
        if (!cancelled) setSvg(result.svg);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [block.id, block.source]);

  return (
    <figure className="zb-figure">
      {svg ? (
        <ZoomableDiagram svg={svg} label={block.caption || 'Diagram'} />
      ) : (
        <pre className="zb-code"><span className="zb-code-lang">mermaid</span><code>{block.source}</code></pre>
      )}
      {error && <p className="zb-note">Không vẽ được sơ đồ; hiển thị mã nguồn Mermaid.</p>}
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  );
}

function ZoomableDiagram({ svg, label }: { svg: string; label: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; dist: number; midX: number; midY: number; x: number; y: number } | null>(null);

  const update = useCallback((next: (current: View) => View) => {
    setView((current) => {
      const el = viewportRef.current;
      return el ? clampView(next(current), el.clientWidth, el.clientHeight) : current;
    });
  }, []);

  const zoomBy = (factor: number) => {
    const el = viewportRef.current;
    if (!el) return;
    update((v) => zoomAt(v, Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor)), el.clientWidth / 2, el.clientHeight / 2));
  };

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report the same way) zooms; plain wheel keeps scrolling the page.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.01);
      update((v) => zoomAt(v, Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor)), event.clientX - rect.left, event.clientY - rect.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [update]);

  // Re-clamp when the column resizes (rotation, window resize) so the content never drifts out of view.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update((v) => v));
    observer.observe(el);
    return () => observer.disconnect();
  }, [update]);

  const startGesture = (current: View) => {
    const el = viewportRef.current;
    const points = [...pointers.current.values()];
    if (!el || points.length === 0) { gesture.current = null; return; }
    const rect = el.getBoundingClientRect();
    const [a, b = a] = points;
    gesture.current = {
      view: current,
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      midX: (a.x + b.x) / 2 - rect.left,
      midY: (a.y + b.y) / 2 - rect.top,
      x: a.x,
      y: a.y,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // A single pointer only drags a zoomed diagram; at fit size the page keeps its normal scrolling.
    if (pointers.current.size === 1 && view.scale === MIN_SCALE) return;
    startGesture(view);
    // Capture keeps the drag alive outside the box; it throws for pointers the browser no longer tracks.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* drag still works inside the box */ }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;
    const el = viewportRef.current;
    if (!g || !el) return;
    const points = [...pointers.current.values()];
    if (points.length >= 2 && g.dist > 0) {
      const [a, b] = points;
      const rect = el.getBoundingClientRect();
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, g.view.scale * (Math.hypot(b.x - a.x, b.y - a.y) / g.dist)));
      const zoomed = zoomAt(g.view, nextScale, g.midX, g.midY);
      // Follow the fingers' midpoint so pinch also pans.
      const dx = (a.x + b.x) / 2 - rect.left - g.midX;
      const dy = (a.y + b.y) / 2 - rect.top - g.midY;
      update(() => ({ scale: zoomed.scale, x: zoomed.x + dx, y: zoomed.y + dy }));
    } else if (points.length === 1) {
      const [p] = points;
      update(() => ({ scale: g.view.scale, x: g.view.x + p.x - g.x, y: g.view.y + p.y - g.y }));
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    // Restart from the remaining finger so lifting one finger of a pinch does not jump the view.
    if (pointers.current.size > 0 && viewRef.current.scale > MIN_SCALE) startGesture(viewRef.current);
    else gesture.current = null;
  };

  const zoomed = view.scale > MIN_SCALE;
  const percent = Math.round(view.scale * 100);

  return (
    <div className="zb-diagram">
      <div
        ref={viewportRef}
        className={`zb-diagram-viewport${zoomed ? ' is-zoomed' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          update((v) => (v.scale > MIN_SCALE ? FIT : zoomAt(v, 2, event.clientX - rect.left, event.clientY - rect.top)));
        }}
      >
        <div
          className="zb-diagram-svg"
          role="img"
          aria-label={label}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          // Output of mermaid.render under securityLevel 'strict' (DOMPurify-sanitized SVG).
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="zb-diagram-tools" role="toolbar" aria-label="Phóng to sơ đồ">
        <button type="button" onClick={() => zoomBy(1 / STEP)} disabled={!zoomed} aria-label="Thu nhỏ" title="Thu nhỏ">−</button>
        <button type="button" onClick={() => update(() => FIT)} disabled={!zoomed} aria-label="Vừa khung" title="Vừa khung" className="zb-diagram-level">{percent}%</button>
        <button type="button" onClick={() => zoomBy(STEP)} disabled={view.scale >= MAX_SCALE} aria-label="Phóng to" title="Phóng to">+</button>
      </div>
    </div>
  );
}
