import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Globe } from 'lucide-react';
import type { Locale } from '../lib/i18n/locales';
import { LOCALES, LOCALE_LABELS, localeCookieValue } from '../lib/i18n/locales';
import { trackEvent } from '../lib/posthog';

interface LanguageSwitchProps {
  locale: Locale;
  /** Accessible name of the trigger, in the current locale. */
  label: string;
  /** Optional hook that runs before navigation (e.g. a short fade-out). */
  beforeNavigate?: () => Promise<void>;
}

function allHrefs(build: (l: Locale) => string): Record<Locale, string> {
  return { en: build('en'), vi: build('vi'), zh: build('zh'), ko: build('ko'), ja: build('ja') };
}

function hrefFor(locale: Locale): string {
  if (typeof window === 'undefined') return `?lang=${locale}`;
  const url = new URL(window.location.href);
  url.searchParams.set('lang', locale);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Site locale menu (EN/VI/ZH/KO/JA). Each option is a real link carrying `?lang=` so it works
 * without JavaScript; with JavaScript it also stores the locale cookie before navigating so the
 * server renders every panel in the same language.
 */
export const LanguageSwitch: React.FC<LanguageSwitchProps> = ({ locale, label, beforeNavigate }) => {
  const [open, setOpen] = useState(false);
  const [hrefs, setHrefs] = useState<Record<Locale, string>>(() => allHrefs(l => `?lang=${l}`));
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setHrefs(allHrefs(hrefFor));
    const current = rootRef.current?.querySelector<HTMLAnchorElement>('a[aria-current="true"]');
    current?.focus();
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = async (e: React.MouseEvent<HTMLAnchorElement>, next: Locale) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setOpen(false);
    if (next === locale) {
      triggerRef.current?.focus();
      return;
    }
    try {
      document.cookie = localeCookieValue(next);
    } catch {
      // Cookies disabled: the ?lang= query still selects the locale for this page.
    }
    trackEvent('language_changed', { language: next });
    if (beforeNavigate) await beforeNavigate().catch(() => undefined);
    window.location.assign(hrefFor(next));
  };

  const onMenuKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const links = Array.from(rootRef.current?.querySelectorAll<HTMLAnchorElement>('[data-locale-option]') ?? []);
    const index = links.findIndex(a => a === document.activeElement);
    const nextIndex = e.key === 'Home' ? 0
      : e.key === 'End' ? links.length - 1
        : (index + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links[nextIndex]?.focus();
  };

  return (
    <div ref={rootRef} className="home-popover-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="home-chip"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${label}: ${LOCALE_LABELS[locale].native}`}
        onClick={() => setOpen(v => !v)}
        data-press
      >
        <Globe aria-hidden="true" className="w-4 h-4" />
        <span aria-hidden="true">{locale.toUpperCase()}</span>
      </button>
      {open && (
        <div className="home-popover" id={menuId}>
          <ul className="home-menu-list" aria-label={label} onKeyDown={onMenuKey}>
            {LOCALES.map(l => (
              <li key={l}>
                <a
                  href={hrefs[l]}
                  hrefLang={LOCALE_LABELS[l].htmlLang}
                  lang={LOCALE_LABELS[l].htmlLang}
                  className="home-menu-item"
                  aria-current={l === locale ? 'true' : undefined}
                  data-locale-option
                  onClick={e => void choose(e, l)}
                >
                  <span>{LOCALE_LABELS[l].native}</span>
                  {l === locale ? <Check aria-hidden="true" className="w-4 h-4" /> : <small>{l.toUpperCase()}</small>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
