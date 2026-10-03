import { useEffect, useState } from 'react';
import type { DiagramBlock as DiagramBlockData } from '../../lib/blocks/schema';

let renderCounter = 0;

/**
 * SSR shows the Mermaid source as a code block. On the client Mermaid is imported lazily
 * (inside the effect only) and renders with securityLevel 'strict', which sanitizes the SVG.
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
        // useMaxWidth:false renders at natural size; .zb-diagram-svg scrolls wide diagrams instead of shrinking labels.
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
        // Output of mermaid.render under securityLevel 'strict' (DOMPurify-sanitized SVG).
        <div className="zb-diagram-svg" role="img" aria-label={block.caption || 'Diagram'} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <pre className="zb-code"><span className="zb-code-lang">mermaid</span><code>{block.source}</code></pre>
      )}
      {error && <p className="zb-note">Không vẽ được sơ đồ; hiển thị mã nguồn Mermaid.</p>}
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  );
}
