import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { MathBlock } from '../../lib/blocks/schema';
import type { MathResult } from '../../lib/blocks/math';
import { BlockFrame } from './BlockFrame';
import type { BlockFrameState } from './BlockFrame';

/** Studio previews re-typeset after typing pauses for this long. */
const LIVE_MATH_DELAY_MS = 150;

const LABELS = { copy: 'Chép TeX', copied: 'Đã chép TeX' };
const SOURCE_LABEL = 'Mã TeX';
const ERROR_MESSAGE = 'Không hiển thị được công thức này; đây là mã TeX gốc.';

/** The TeX source, exposed to assistive technology as math (the fallback when nothing was typeset). */
function TexSource({ tex }: { tex: string }) {
  return <code className="zb-math-source" role="math" aria-label={tex}>{tex}</code>;
}

interface MathViewProps {
  block: MathBlock;
  /** Server-typeset KaTeX markup for this block, when available. */
  html: string | null;
  /** Equation number of a numbered display formula. */
  number?: number;
  /** Typeset on the client by lazy-loading KaTeX (Studio previews) when no server markup was given. */
  live: boolean;
}

/**
 * Math block. Readers get KaTeX markup typeset on the server (HTML for the eye, MathML for screen readers),
 * so the island hydrates with identical markup and never loads KaTeX itself. The TeX source stays one click
 * away (`<details>`, works without JavaScript) and is copyable from the toolbar once hydrated. Without server
 * markup the source is shown instead; Studio previews typeset live and surface KaTeX's error message.
 */
export function MathView({ block, html, number, live }: MathViewProps) {
  const mode = block.mode ?? 'display';
  const source = `${mode}\u0000${block.tex}`;
  const [rendered, setRendered] = useState<{ source: string; result: MathResult } | null>(null);
  const wantsLive = live && !html;

  useEffect(() => {
    if (!wantsLive) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      import('../../lib/blocks/math-render')
        .then(m => { if (!cancelled) setRendered({ source, result: m.renderTex(block.tex, mode) }); })
        // The KaTeX chunk failed to load (offline, deploy skew): the preview keeps the source.
        .catch(() => { if (!cancelled) setRendered({ source, result: { ok: false, error: 'KaTeX could not be loaded' } }); });
    }, LIVE_MATH_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [wantsLive, source, block.tex, mode]);

  const current = rendered?.source === source ? rendered.result : null;
  const markup = html ?? (current?.ok ? current.html : null);
  let state: BlockFrameState = 'ready';
  let errorMessage: string | undefined;
  if (!markup && wantsLive) {
    if (!current) state = 'loading';
    else if (!current.ok) { state = 'error'; errorMessage = `${ERROR_MESSAGE} ${current.error}`; }
  }

  const body: ReactNode = markup
    // Trusted markup: produced by KaTeX from validated TeX with `trust: false` (see math-render.ts).
    ? <div className="zb-math-formula" dangerouslySetInnerHTML={{ __html: markup }} />
    : <TexSource tex={block.tex} />;

  return (
    <BlockFrame
      className={`zb-math zb-math-${mode}${markup ? '' : ' zb-math-raw'}`}
      caption={block.caption}
      copyText={() => block.tex}
      labels={LABELS}
      state={state}
      errorMessage={errorMessage}
      fallback={<TexSource tex={block.tex} />}
    >
      <div className="zb-math-row">
        {body}
        {number !== undefined && <span className="zb-math-number">({number})</span>}
      </div>
      {markup && (
        <details className="zb-math-tex">
          <summary>{SOURCE_LABEL}</summary>
          <pre><code>{block.tex}</code></pre>
        </details>
      )}
    </BlockFrame>
  );
}
