import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Shared shell for rich blocks (charts, diagrams, galleries, …): title, caption, a toolbar
 * (fullscreen, copy, download) and loading / error states around an accessible fallback.
 *
 * The server and the first client render emit only the frame and its content, so hydration always
 * matches and readers without JavaScript keep the fallback; the toolbar appears after mount, and
 * only with the actions this browser supports.
 */

export type BlockFrameState = 'ready' | 'loading' | 'error';

export interface BlockDownload {
  filename: string;
  /** File contents; strings are saved as UTF-8 text. */
  data: string | Blob;
  /** Media type for string data (default text/plain). */
  type?: string;
}

export interface BlockFrameLabels {
  fullscreen: string;
  exitFullscreen: string;
  copy: string;
  copied: string;
  download: string;
  loading: string;
  error: string;
}

export const BLOCK_FRAME_LABELS: BlockFrameLabels = {
  fullscreen: 'Toàn màn hình',
  exitFullscreen: 'Thoát toàn màn hình',
  copy: 'Sao chép',
  copied: 'Đã sao chép',
  download: 'Tải xuống',
  loading: 'Đang tải…',
  error: 'Không hiển thị được nội dung này.',
};

export interface BlockFrameProps {
  title?: ReactNode;
  caption?: ReactNode;
  /** Extra class names on the frame (block-specific styling). */
  className?: string;
  /** `ready` shows the children; `loading` and `error` show the fallback instead. */
  state?: BlockFrameState;
  /** Accessible, no-JS equivalent of the block (e.g. a data table for a chart). */
  fallback?: ReactNode;
  /** Message shown above the fallback in the error state (defaults to labels.error). */
  errorMessage?: string;
  /** Offer a fullscreen button (when the browser supports it). */
  fullscreen?: boolean;
  /** Text copied by the copy button (computed on click). */
  copyText?: () => string;
  /** File saved by the download button (computed on click). */
  download?: () => BlockDownload;
  labels?: Partial<BlockFrameLabels>;
  children?: ReactNode;
}

/** True when the reader asked the system to reduce motion; false on the server and before mount. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

interface Capabilities { fullscreen: boolean; copy: boolean; download: boolean }

function detectCapabilities(): Capabilities {
  return {
    fullscreen: typeof document !== 'undefined' && document.fullscreenEnabled === true,
    copy: typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function',
    download: typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function',
  };
}

function saveFile({ filename, data, type }: BlockDownload): void {
  const blob = typeof data === 'string' ? new Blob([data], { type: type ?? 'text/plain;charset=utf-8' }) : data;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BlockFrame({
  title, caption, className, state = 'ready', fallback, errorMessage, fullscreen = false, copyText, download, labels, children,
}: BlockFrameProps) {
  const text = { ...BLOCK_FRAME_LABELS, ...labels };
  const frameRef = useRef<HTMLElement>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCaps(detectCapabilities());
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const showFullscreen = Boolean(caps?.fullscreen && fullscreen);
  const showCopy = Boolean(caps?.copy && copyText);
  const showDownload = Boolean(caps?.download && download);
  const hasToolbar = showFullscreen || showCopy || showDownload;

  const toggleFullscreen = () => {
    const frame = frameRef.current;
    if (!frame) return;
    if (document.fullscreenElement === frame) void document.exitFullscreen().catch(() => undefined);
    else void frame.requestFullscreen().catch(() => undefined);
  };
  const copy = () => {
    if (!copyText) return;
    navigator.clipboard.writeText(copyText()).then(() => setCopied(true), () => setCopied(false));
  };

  let body: ReactNode = children;
  if (state === 'loading') {
    body = fallback ?? <div className="zb-frame-loading" role="status" aria-label={text.loading} />;
  } else if (state === 'error') {
    body = <><p className="zb-frame-error" role="status">{errorMessage ?? text.error}</p>{fallback}</>;
  }

  return (
    <figure ref={frameRef} className={className ? `zb-frame ${className}` : 'zb-frame'} aria-busy={state === 'loading' ? true : undefined}>
      {(title || hasToolbar) && (
        <div className="zb-frame-head">
          {title && <div className="zb-frame-title">{title}</div>}
          {hasToolbar && (
            <div className="zb-frame-toolbar">
              {showCopy && (
                <button type="button" className="zb-frame-btn" onClick={copy}>{copied ? text.copied : text.copy}</button>
              )}
              {showDownload && download && (
                <button type="button" className="zb-frame-btn" onClick={() => saveFile(download())}>{text.download}</button>
              )}
              {showFullscreen && (
                <button type="button" className="zb-frame-btn" onClick={toggleFullscreen}>
                  {isFullscreen ? text.exitFullscreen : text.fullscreen}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {showCopy && <span className="zb-sr-only" role="status">{copied ? text.copied : ''}</span>}
      <div className="zb-frame-body">{body}</div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
