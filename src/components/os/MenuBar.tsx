import React, { useEffect, useId, useRef, useState } from 'react';
import { Command, Eye, EyeOff, Moon, Sun, User } from 'lucide-react';
import type { WeatherReport } from '../../lib/experience/weather';
import type { Locale } from '../../lib/i18n/locales';
import { LanguageSwitch } from '../LanguageSwitch';
import type { HomeStrings } from '../home/home-i18n';
import { WeatherControl } from '../home/WeatherControl';
import type { AppId } from './apps';
import type { OsStrings } from './os-i18n';

export interface MenuItem {
  key: string;
  label: string;
  kbd?: string;
  run: () => void;
}

interface MenuBarProps {
  locale: Locale;
  strings: OsStrings;
  homeStrings: HomeStrings;
  activeApp: AppId | null;
  dark: boolean;
  mascotHidden: boolean;
  noticeWaiting: boolean;
  signedIn: boolean;
  shortcut: string;
  menu: MenuItem[];
  onWeather: (r: WeatherReport | null) => void;
  onPalette: () => void;
  onToggleTheme: () => void;
  onToggleMascot: () => void;
  onAccount: () => void;
  beforeNavigate: () => Promise<void>;
}

function useClock(locale: Locale): string {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (!now) return '';
  return new Intl.DateTimeFormat(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(now);
}

/** Top bar: Zuey menu, the focused app's name, then weather, language, commands, theme, companion, account, clock. */
export const MenuBar: React.FC<MenuBarProps> = ({
  locale, strings, homeStrings, activeApp, dark, mascotHidden, noticeWaiting, signedIn, shortcut, menu,
  onWeather, onPalette, onToggleTheme, onToggleMascot, onAccount, beforeNavigate,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const clock = useClock(locale);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const i = items.findIndex(el => el === document.activeElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      if (e.key === 'Escape') { e.preventDefault(); btnRef.current?.focus(); }
      return;
    } else return;
    e.preventDefault();
    items[next]?.focus();
  };

  const mascotLabel = mascotHidden ? (noticeWaiting ? `${strings.showZuey} (${strings.noticeWaiting})` : strings.showZuey) : strings.hideZuey;

  return (
    <header className="os-menubar" data-mascot-avoid>
      <div ref={rootRef} className="os-mb-anchor">
        <button
          ref={btnRef}
          type="button"
          className="os-mb-btn os-mb-brand"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen(v => !v)}
        >
          <i aria-hidden="true">z</i>
          <span>zuey.me</span>
          <span className="sr-only">{strings.menu}</span>
        </button>
        {open && (
          <ul id={menuId} role="menu" aria-label={strings.menu} className="os-pop" onKeyDown={onMenuKey}>
            {menu.map(item => (
              <li key={item.key} role="none">
                <button type="button" role="menuitem" className="os-mi" onClick={() => { setOpen(false); item.run(); }}>
                  <span>{item.label}</span>
                  {item.kbd && <kbd>{item.kbd}</kbd>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {activeApp && <span className="os-mb-app" aria-live="polite">{strings.apps[activeApp]}</span>}
      <span className="os-mb-sp" />
      <div className="os-mb-tools">
        <WeatherControl strings={homeStrings.weather} locale={locale} onReport={onWeather} />
        <LanguageSwitch locale={locale} label={strings.language} beforeNavigate={beforeNavigate} />
        <button type="button" className="home-chip" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" aria-label={strings.commands} onClick={onPalette}>
          <Command aria-hidden className="w-4 h-4" />
          <kbd aria-hidden="true" className="os-mb-kbd">{shortcut}</kbd>
        </button>
        <button type="button" className="home-chip" aria-label={dark ? strings.toLight : strings.toDark} title={`${dark ? strings.toLight : strings.toDark} (Alt T)`} aria-keyshortcuts="Alt+T" onClick={onToggleTheme}>
          {dark ? <Sun aria-hidden className="w-4 h-4" /> : <Moon aria-hidden className="w-4 h-4" />}
        </button>
        <button
          id="home-mascot-toggle"
          type="button"
          className="home-chip"
          aria-pressed={!mascotHidden}
          aria-label={mascotLabel}
          title={mascotLabel}
          onClick={onToggleMascot}
        >
          {mascotHidden ? <Eye aria-hidden className="w-4 h-4" /> : <EyeOff aria-hidden className="w-4 h-4" />}
          {mascotHidden && noticeWaiting && <span className="home-chip-dot" aria-hidden="true" />}
        </button>
        <button type="button" className="os-mb-acct" onClick={onAccount}>
          <User aria-hidden className="w-4 h-4" />
          <span className="os-mb-label">{signedIn ? strings.account : strings.signIn}</span>
        </button>
        {clock && <time className="os-mb-clock" aria-hidden="true">{clock}</time>}
      </div>
    </header>
  );
};
