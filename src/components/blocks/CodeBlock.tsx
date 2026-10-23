import { Fragment, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { CodeBlock } from '../../lib/blocks/schema';
import {
  codeDisplay, codeRuns, codeSegments, copyText, displayLines, highlightSource, highlightedLines,
} from '../../lib/blocks/code-syntax';
import type { CodeHighlights, CodeSegment, DiffMark, TokenRuns } from '../../lib/blocks/code-syntax';
import { showToast } from '../feedback/toast-bus';

type CssVars = CSSProperties & { [key: `--${string}`]: string | number };

/** Studio previews re-highlight after typing pauses for this long. */
const LIVE_HIGHLIGHT_DELAY_MS = 150;
/** How long the copy button reports its result. */
const COPIED_MS = 2_000;
const COPIED_TEXT = 'Đã chép code';
const COPY_FAILED_TEXT = 'Không chép được, hãy chọn và chép tay';

function renderSegments(segments: CodeSegment[]): ReactNode[] {
  return segments.map(({ text, kind }, i) => (kind
    ? <span key={i} className={`zb-tk-${kind}`}>{text}</span>
    : <Fragment key={i}>{text}</Fragment>));
}

/** Splits highlighted segments at line breaks (a run may span several lines); the breaks themselves are dropped. */
function segmentLines(segments: CodeSegment[]): CodeSegment[][] {
  const lines: CodeSegment[][] = [[]];
  for (const { text, kind } of segments) {
    text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]?.push(kind ? { text: part, kind } : { text: part });
    });
  }
  return lines;
}

/** True when a block uses any option beyond language + code; plain blocks keep the markup stored articles always had. */
function hasOptions(block: CodeBlock): boolean {
  return Boolean(block.filename || block.lineNumbers || block.highlightLines || block.diff || block.wrap || block.collapseAfter);
}

const LINE_TAG: Record<DiffMark, 'ins' | 'del' | 'span'> = { add: 'ins', del: 'del', ctx: 'span' };

interface LinesProps { text: string; segments: CodeSegment[] | null; marks: DiffMark[] | null; highlighted: Set<number> }

/**
 * One element per line so the gutter, emphasis and diff colours can style whole lines. Each line keeps its own
 * line break, so the text of <code> is exactly the displayed code (numbers and markers are CSS, never text).
 * Added and removed lines are <ins>/<del>, which assistive technology can announce.
 */
function CodeLines({ text, segments, marks, highlighted }: LinesProps) {
  const lines = displayLines(text);
  const tokenLines = segments ? segmentLines(segments) : null;
  return (
    <>
      {lines.map((line, i) => {
        const Tag = LINE_TAG[marks?.[i] ?? 'ctx'];
        const classes = ['zb-line', marks ? `zb-line-${marks[i] ?? 'ctx'}` : '', highlighted.has(i + 1) ? 'zb-line-hl' : ''].filter(Boolean).join(' ');
        const tokens = tokenLines?.[i];
        const last = i === lines.length - 1;
        return (
          <Tag key={i} className={classes}>
            {tokens ? renderSegments(tokens) : line}
            {last && !text.endsWith('\n') ? null : '\n'}
          </Tag>
        );
      })}
    </>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function WrapIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4" /><path d="m16 16-2 2 2 2" /><path d="M3 18h7" />
    </svg>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Code block. Token runs come pre-computed from the server (`highlights`, so no-JS readers get colours and
 * hydration matches) or, in Studio previews, from the highlighter loaded lazily on the client. Runs only carry
 * lengths and kinds; the text is always sliced from the block's own code, and runs that do not cover it exactly
 * are ignored. Line endings are normalised to LF so the server HTML parses back to the same text.
 *
 * The toolbar (copy, wrap) and the expand button need script, so they appear once the block is hydrated; without
 * script the code is complete and selectable, and a collapsed block scrolls inside its own box.
 */
export function CodeView({ block, highlights, liveHighlight }: { block: CodeBlock; highlights?: CodeHighlights; liveHighlight: boolean }) {
  const { text, marks } = codeDisplay(block);
  const provided = codeRuns(highlights, block.id, text.length);
  const source = highlightSource(block);
  const key = source ? `${source.language}\u0000${source.text}` : '';
  const [live, setLive] = useState<{ key: string; runs: TokenRuns | null } | null>(null);
  const wantsLive = liveHighlight && !provided && source !== null;
  const [mounted, setMounted] = useState(false);
  const [wrap, setWrap] = useState(block.wrap === true);
  const [expanded, setExpanded] = useState(false);
  const [copy, setCopy] = useState<CopyState>('idle');
  /** Inline announcement, used only when no page Toaster took the message (so it is announced once). */
  const [announce, setAnnounce] = useState('');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setMounted(true);
    return () => clearTimeout(copyTimer.current);
  }, []);
  useEffect(() => { setWrap(block.wrap === true); }, [block.wrap]);

  useEffect(() => {
    if (!wantsLive || !source) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      import('../../lib/blocks/code-highlight')
        .then(m => { if (!cancelled) setLive({ key, runs: m.highlightCode(source.text, source.language) }); })
        // The highlighter chunk failed to load (offline, deploy skew): the preview keeps plain code.
        .catch(() => { if (!cancelled) setLive({ key, runs: null }); });
    }, LIVE_HIGHLIGHT_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
    // `key` stands for `source` (text and language), which is a new object on every render.
  }, [wantsLive, key]);

  const runs = provided ?? (live?.key === key ? live.runs : null);
  const segments = runs ? codeSegments(text, runs) : null;
  const options = hasOptions(block);
  const lang = block.language && !block.filename ? <span className="zb-code-lang">{block.language}</span> : null;

  // Plain blocks render exactly as before code options existed (stored articles keep their server HTML).
  if (!options && !mounted) {
    return (
      <pre className="zb-code">
        {lang}
        <code>{segments ? renderSegments(segments) : text}</code>
      </pre>
    );
  }

  const lineCount = displayLines(text).length;
  const lineMode = Boolean(block.lineNumbers || block.highlightLines || marks);
  const collapsible = block.collapseAfter !== undefined && lineCount > block.collapseAfter;
  const collapsed = collapsible && !expanded;
  const style: CssVars = {
    '--zb-gutter': block.lineNumbers ? `${String(lineCount).length}ch` : '0px',
    '--zb-mark': marks ? '1.5ch' : '0px',
    ...(collapsed ? { '--zb-code-rows': block.collapseAfter ?? 0 } : {}),
  };
  const preClass = ['zb-code', options && !block.filename ? 'zb-code-top' : '', lineMode ? 'zb-code-lines' : '', block.lineNumbers ? 'zb-code-numbered' : '', wrap ? 'zb-code-wrap' : '', collapsed ? 'zb-code-collapsed' : '']
    .filter(Boolean).join(' ');

  const onCopy = () => {
    clearTimeout(copyTimer.current);
    const done = (state: CopyState) => {
      const message = state === 'copied' ? COPIED_TEXT : COPY_FAILED_TEXT;
      setCopy(state);
      setAnnounce(showToast(message, state === 'copied' ? 'success' : 'error') ? '' : message);
      copyTimer.current = setTimeout(() => { setCopy('idle'); setAnnounce(''); }, COPIED_MS);
    };
    if (!navigator.clipboard) { done('failed'); return; }
    navigator.clipboard.writeText(copyText(block)).then(() => done('copied'), () => done('failed'));
  };
  const copyLabel = copy === 'copied' ? COPIED_TEXT : copy === 'failed' ? COPY_FAILED_TEXT : 'Chép code';

  return (
    <figure className="zb-codeblock">
      {block.filename && (
        <figcaption className="zb-code-head">
          <span className="zb-code-file">{block.filename}</span>
          {block.language && <span className="zb-code-lang">{block.language}</span>}
        </figcaption>
      )}
      {/* Focusable so keyboard users can scroll a collapsed or wide block. */}
      <pre className={preClass} style={style} tabIndex={collapsed || !wrap ? 0 : undefined}>
        {lang}
        <code>{lineMode ? <CodeLines text={text} segments={segments} marks={marks} highlighted={highlightedLines(block.highlightLines, lineCount)} /> : segments ? renderSegments(segments) : text}</code>
      </pre>
      {mounted && (
        <div className="zb-code-tools" role="toolbar" aria-label="Công cụ code">
          <button type="button" onClick={() => setWrap(w => !w)} aria-pressed={wrap} aria-label="Xuống dòng" title="Xuống dòng">
            <WrapIcon />
          </button>
          <button type="button" onClick={onCopy} aria-label="Chép code" title={copyLabel} data-state={copy}>
            {copy === 'copied' ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      )}
      {mounted && <span className="zb-sr-only" role="status">{announce}</span>}
      {mounted && collapsible && (
        <button type="button" className="zb-code-expand" aria-expanded={!collapsed} onClick={() => setExpanded(e => !e)}>
          {collapsed ? `Hiện toàn bộ ${lineCount} dòng` : 'Thu gọn'}
        </button>
      )}
    </figure>
  );
}
