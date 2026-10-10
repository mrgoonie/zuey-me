import { useEffect, useRef, useState } from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { knowledgeStrings } from './strings';

interface Props {
  locale: Locale;
  title: string;
  /** Public canonical URL of this edition. */
  publicUrl: string;
  /** Public Markdown URL of this edition. */
  markdownUrl: string;
  /** True only when the signed-in reader may read this paid article in full. */
  canCopyPrivate: boolean;
}

/** Web share intents: each carries only the public URL (and title), never article text. */
const SOCIAL_TARGETS: Array<{ name: string; url: (url: string, title: string) => string }> = [
  { name: 'Facebook', url: u => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}` },
  { name: 'X', url: (u, t) => `https://x.com/intent/post?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
  { name: 'LinkedIn', url: u => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(u)}` },
  { name: 'Threads', url: (u, t) => `https://www.threads.net/intent/post?text=${encodeURIComponent(`${t} ${u}`)}` },
  { name: 'Telegram', url: (u, t) => `https://t.me/share/url?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
  { name: 'Reddit', url: (u, t) => `https://www.reddit.com/submit?url=${encodeURIComponent(u)}&title=${encodeURIComponent(t)}` },
];

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(text);
}

/**
 * Share actions, opened upward from the sticky article action bar. "Copy Markdown" always copies the
 * PUBLIC Markdown (fetched without cookies), so a member never leaks paid text by accident; the private
 * full copy is a separate, explicit action for entitled readers.
 */
export function ShareMenu({ locale, title, publicUrl, markdownUrl, canCopyPrivate }: Props) {
  const t = knowledgeStrings(locale);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [canNativeShare, setCanNativeShare] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [open]);

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      setStatus(t.copied);
    } catch {
      setStatus(t.copyFailed);
    }
    window.setTimeout(() => setStatus(''), 2500);
  };

  const fetchMarkdown = async (credentials: RequestCredentials): Promise<string> => {
    const res = await fetch(markdownUrl, { credentials, headers: { Accept: 'text/markdown' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };

  const itemClass = 'w-full text-left rounded-lg px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus:bg-stone-100 focus:outline-none';

  return (
    // No positioning here: the popover and toast anchor to the fixed, screen-centred action bar.
    <div className="inline-flex" ref={rootRef}>
      <button
        type="button"
        className="zab-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t.share}
        title={t.share}
        onClick={() => setOpen(v => !v)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="4" cy="8" r="2" /><circle cx="12" cy="4" r="2" /><circle cx="12" cy="12" r="2" /><path d="M5.8 7l4.4-2M5.8 9l4.4 2" />
        </svg>
        <span className="hidden sm:inline">{t.share}</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-1/2 z-30 mb-3 w-64 max-w-[calc(100vw-2rem)] -translate-x-1/2 max-h-[70vh] overflow-y-auto rounded-2xl border border-stone-200 bg-white p-1.5 shadow-modal">
          <p className="px-3 pt-1.5 pb-1 text-[11px] font-bold uppercase tracking-wider text-stone-500">{t.shareTo}</p>
          <div className="grid grid-cols-2">
            {SOCIAL_TARGETS.map(target => (
              <a key={target.name} className={`${itemClass} block`} href={target.url(publicUrl, title)} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>{target.name}</a>
            ))}
          </div>
          <div className="mt-1 border-t border-stone-200 pt-1">
            <button type="button" className={itemClass} onClick={() => run(() => copyText(publicUrl))}>{t.copyLink}</button>
            <button type="button" className={itemClass} onClick={() => run(async () => copyText(await fetchMarkdown('omit')))}>{t.copyMarkdown}</button>
            <button type="button" className={itemClass} onClick={() => run(() => copyText(markdownUrl))}>{t.copyMarkdownUrl}</button>
            {canNativeShare && (
              <button type="button" className={itemClass} onClick={() => { navigator.share({ title, url: publicUrl }).catch(() => undefined); }}>{t.nativeShare}</button>
            )}
          </div>
          {canCopyPrivate && (
            <div className="mt-1 border-t border-stone-200 pt-1">
              <button type="button" className={itemClass} onClick={() => run(async () => copyText(await fetchMarkdown('same-origin')))}>{t.copyFullPrivate}</button>
              <p className="px-3 pb-1.5 text-[11px] text-stone-500">{t.copyFullHint}</p>
            </div>
          )}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">{status}</span>
      {status && <span aria-hidden="true" className="zab-toast">{status}</span>}
    </div>
  );
}

export default ShareMenu;
