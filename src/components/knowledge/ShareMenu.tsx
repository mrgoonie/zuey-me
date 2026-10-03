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

const AI_TARGETS: Array<{ name: string; url: (prompt: string) => string }> = [
  { name: 'ChatGPT', url: p => `https://chatgpt.com/?q=${encodeURIComponent(p)}` },
  { name: 'Claude', url: p => `https://claude.ai/new?q=${encodeURIComponent(p)}` },
  { name: 'Gemini', url: p => `https://gemini.google.com/app?q=${encodeURIComponent(p)}` },
];

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(text);
}

/**
 * Share actions. "Copy Markdown" always copies the PUBLIC Markdown (fetched without cookies), so a member
 * never leaks paid text by accident; the private full copy is a separate, explicit action for entitled readers.
 * AI deep links carry only the public URL in a prefilled prompt.
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
  const prompt = t.aiPrompt(publicUrl);

  return (
    <div className="relative inline-block" ref={rootRef}>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3.5 py-1.5 text-xs font-bold text-stone-800 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="4" cy="8" r="2" /><circle cx="12" cy="4" r="2" /><circle cx="12" cy="12" r="2" /><path d="M5.8 7l4.4-2M5.8 9l4.4 2" />
        </svg>
        {t.share}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-2xl border border-stone-200 bg-white p-1.5 shadow-modal">
          <button type="button" className={itemClass} onClick={() => run(async () => copyText(await fetchMarkdown('omit')))}>{t.copyMarkdown}</button>
          <button type="button" className={itemClass} onClick={() => run(() => copyText(markdownUrl))}>{t.copyMarkdownUrl}</button>
          {AI_TARGETS.map(target => (
            <a key={target.name} className={`${itemClass} block`} href={target.url(prompt)} target="_blank" rel="noopener noreferrer">{t.askAi(target.name)}</a>
          ))}
          {canNativeShare && (
            <button type="button" className={itemClass} onClick={() => { navigator.share({ title, url: publicUrl }).catch(() => undefined); }}>{t.nativeShare}</button>
          )}
          {canCopyPrivate && (
            <div className="mt-1 border-t border-stone-200 pt-1">
              <button type="button" className={itemClass} onClick={() => run(async () => copyText(await fetchMarkdown('same-origin')))}>{t.copyFullPrivate}</button>
              <p className="px-3 pb-1.5 text-[11px] text-stone-500">{t.copyFullHint}</p>
            </div>
          )}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">{status}</span>
      {status && <span aria-hidden="true" className="ml-2 text-xs font-semibold text-stone-600">{status}</span>}
    </div>
  );
}

export default ShareMenu;
