import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Command, Eye, EyeOff, User } from 'lucide-react';
import type { LinkItem, Profile } from '../../db/types';
import type { PublicNotice } from '../../lib/experience/notices';
import type { WeatherReport } from '../../lib/experience/weather';
import type { Locale } from '../../lib/i18n/locales';
import { ProfileView } from '../ProfileView';
import { LanguageSwitch } from '../LanguageSwitch';
import { homeStrings } from './home-i18n';
import { apiFetch, parseNotices } from './api-client';
import { loadGsap, prefersReducedMotion, useMediaQuery, useReducedMotion } from './motion';
import { STORAGE_KEYS, readStored, writeStored } from './storage';
import { addDismissed, nextNoticeChange, parseDismissed, pickNotice } from './notice-queue';
import { Mascot } from './Mascot';
import { WeatherControl } from './WeatherControl';
import { WeatherBackdrop } from './WeatherBackdrop';
import { CommandPalette } from './CommandPalette';
import { McpDialog } from './McpDialog';
import { GithubActivity } from './GithubActivity';
import { OfferCards } from './OfferCards';
import './home.css';

export type HomeTab = 'ai' | 'profile' | 'knowledges';
const TABS: HomeTab[] = ['ai', 'profile', 'knowledges'];
const isTab = (v: unknown): v is HomeTab => v === 'ai' || v === 'profile' || v === 'knowledges';
const TABS_QUERY = '(max-width: 1279px)';
const NOTICE_REFRESH_MS = 5 * 60 * 1000;

interface HomeShellProps {
  locale: Locale;
  profile: Profile;
  links: LinkItem[];
  /** Left column / "Zuey AI" tab. Rendered by the page (Astro named slot `aiPanel`). */
  aiPanel?: React.ReactNode;
  /** Right column / "Knowledges" tab. Rendered by the page (Astro named slot `knowledgePanel`). */
  knowledgePanel?: React.ReactNode;
}

/**
 * Homepage shell: three columns from 1280px (Zuey AI · profile · Knowledges), a hash-synced
 * tab bar below that, the global bar (weather, locale, commands, account, companion), the
 * membership/business offers and the GitHub activity section. Pane visibility is CSS-driven
 * from `html[data-home-tab]` (set before first paint), so switching never shifts layout.
 */
export const HomeShell: React.FC<HomeShellProps> = ({ locale, profile, links, aiPanel, knowledgePanel }) => {
  const s = homeStrings(locale);
  const reduced = useReducedMotion();
  const tabsMode = useMediaQuery(TABS_QUERY);
  const [tab, setTab] = useState<HomeTab>('profile');
  const [weather, setWeather] = useState<WeatherReport | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mascotHidden, setMascotHidden] = useState(true);
  const [notices, setNotices] = useState<PublicNotice[]>([]);
  const [dismissed, setDismissed] = useState<ReturnType<typeof parseDismissed>>([]);
  const [clock, setClock] = useState(() => Date.now());
  const [shortcut, setShortcut] = useState('Ctrl K');
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const tabRef = useRef<HTMLDivElement>(null);

  // ---------- Tabs ----------
  const applyTab = useCallback((next: HomeTab, opts: { focus?: boolean; updateHash?: boolean } = {}) => {
    setTab(prev => {
      if (prev !== next && !prefersReducedMotion() && window.matchMedia(TABS_QUERY).matches) {
        const dir = TABS.indexOf(next) > TABS.indexOf(prev) ? 1 : -1;
        void loadGsap().then(gsap => {
          const pane = document.getElementById(`home-pane-${next}`);
          if (gsap && pane) gsap.fromTo(pane, { opacity: 0, x: 28 * dir }, { opacity: 1, x: 0, duration: 0.34, ease: 'power3.out', clearProps: 'transform,opacity' });
        });
      }
      return next;
    });
    document.documentElement.setAttribute('data-home-tab', next);
    if (opts.updateHash) {
      const url = new URL(window.location.href);
      url.hash = next;
      window.history.replaceState(window.history.state, '', url);
    }
    if (opts.focus) document.getElementById(`home-tab-${next}`)?.focus();
  }, []);

  useEffect(() => {
    const initial = document.documentElement.getAttribute('data-home-tab');
    if (isTab(initial)) setTab(initial);
    const onHash = () => {
      const h = window.location.hash.slice(1);
      if (isTab(h)) applyTab(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [applyTab]);

  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    let next: HomeTab | null = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    applyTab(next, { focus: true, updateHash: true });
  };

  // Deliberate horizontal swipes switch tabs; vertical scrolling, inputs and horizontal scrollers are left alone.
  useEffect(() => {
    const el = workspaceRef.current;
    if (!el || !tabsMode) return;
    let start: { x: number; y: number; t: number } | null = null;
    const onStart = (e: TouchEvent) => {
      const target = e.target;
      if (e.touches.length !== 1 || !(target instanceof Element)) { start = null; return; }
      // Leave screen edges to the system back/forward gestures.
      const x = e.touches[0].clientX;
      if (x < 24 || x > window.innerWidth - 24) { start = null; return; }
      if (target.closest('input, textarea, select, [contenteditable="true"], [data-no-swipe], .home-graph')) { start = null; return; }
      for (let n: Element | null = target; n && n !== el; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX !== 'visible') { start = null; return; }
      }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    };
    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      const quick = Date.now() - start.t < 700;
      start = null;
      if (!quick || Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 2) return;
      const i = TABS.indexOf(tab);
      const next = TABS[i + (dx < 0 ? 1 : -1)];
      if (next) applyTab(next, { updateHash: true });
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
    };
  }, [tabsMode, tab, applyTab]);

  // ---------- Page-load choreography + micro-interactions ----------
  useEffect(() => {
    const html = document.documentElement;
    if (!html.classList.contains('home-motion-pending')) return;
    let cancelled = false;
    void loadGsap().then(gsap => {
      if (cancelled) return;
      const els = Array.from(document.querySelectorAll<HTMLElement>('.home-reveal'));
      // Too late (the CSS safety net is already revealing) or no GSAP: just hand over to CSS.
      if (!gsap || performance.now() > 1000) {
        html.classList.remove('home-motion-pending');
        return;
      }
      gsap.set(els, { opacity: 0 });
      html.classList.remove('home-motion-pending');
      const vh = window.innerHeight;
      const visible = els.filter(el => el.getBoundingClientRect().top < vh && el.offsetParent !== null);
      const later = els.filter(el => !visible.includes(el));
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      const [bar, ...rest] = visible;
      if (bar) tl.fromTo(bar, { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: 0.45, clearProps: 'transform' });
      if (rest.length) tl.fromTo(rest, { opacity: 0, y: 26, scale: 0.985 }, { opacity: 1, y: 0, scale: 1, duration: 0.7, stagger: 0.09, clearProps: 'transform' }, '-=0.2');
      if (later.length === 0) return;
      const io = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          gsap.fromTo(entry.target, { opacity: 0, y: 32 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out', clearProps: 'transform' });
        }
      }, { rootMargin: '0px 0px -8% 0px' });
      later.forEach(el => io.observe(el));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reduced) return;
    let gsapRef: Awaited<ReturnType<typeof loadGsap>> = null;
    void loadGsap().then(g => { gsapRef = g; });
    const pressTarget = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-press]') : null);
    let pressed: HTMLElement | null = null;
    const onDown = (e: PointerEvent) => {
      pressed = pressTarget(e);
      if (pressed && gsapRef) gsapRef.to(pressed, { scale: 0.95, duration: 0.12, ease: 'power2.out' });
    };
    const onUp = () => {
      if (pressed && gsapRef) gsapRef.to(pressed, { scale: 1, duration: 0.6, ease: 'elastic.out(1, 0.45)', clearProps: 'scale' });
      pressed = null;
    };
    const fineHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const onOver = (e: PointerEvent) => {
      if (!fineHover || !gsapRef || !(e.target instanceof Element)) return;
      const el = e.target.closest<HTMLElement>('[data-lift]');
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) gsapRef.to(el, { y: -4, duration: 0.25, ease: 'power2.out' });
    };
    const onOut = (e: PointerEvent) => {
      if (!fineHover || !gsapRef || !(e.target instanceof Element)) return;
      const el = e.target.closest<HTMLElement>('[data-lift]');
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) gsapRef.to(el, { y: 0, duration: 0.35, ease: 'power2.out', clearProps: 'transform' });
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
    };
  }, [reduced]);

  // The ambient background video stops under reduced motion (and resumes when that changes).
  useEffect(() => {
    const video = document.querySelector<HTMLVideoElement>('body video');
    if (!video) return;
    if (reduced) video.pause();
    else void video.play().catch(() => undefined);
  }, [reduced]);

  const fadeOut = useCallback(async () => {
    if (prefersReducedMotion()) return;
    const gsap = await loadGsap();
    if (!gsap || !rootRef.current) return;
    await new Promise<void>(resolve => {
      gsap.to(rootRef.current, { opacity: 0, y: 6, duration: 0.2, ease: 'power1.in', onComplete: resolve });
    });
  }, []);

  // Restore the content when returning through the back/forward cache after a locale switch.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && rootRef.current) {
        rootRef.current.style.opacity = '';
        rootRef.current.style.transform = '';
      }
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  // ---------- Command palette ----------
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setShortcut('⌘K');
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMcpOpen(false);
        setPaletteOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeMcp = useCallback(() => setMcpOpen(false), []);
  const openMcp = useCallback(() => setMcpOpen(true), []);
  const showActivity = useCallback(() => {
    const el = document.getElementById('activity');
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
    const url = new URL(window.location.href);
    url.hash = 'activity';
    window.history.replaceState(window.history.state, '', url);
  }, []);

  // ---------- Companion visibility ----------
  useEffect(() => {
    setMascotHidden(readStored(STORAGE_KEYS.mascotHidden) === true);
  }, []);

  const setHidden = useCallback((hidden: boolean) => {
    setMascotHidden(hidden);
    writeStored(STORAGE_KEYS.mascotHidden, hidden);
  }, []);
  const hideMascot = useCallback(() => {
    setHidden(true);
    document.getElementById('home-mascot-toggle')?.focus();
  }, [setHidden]);

  // ---------- Duy notices ----------
  useEffect(() => {
    setDismissed(parseDismissed(readStored(STORAGE_KEYS.dismissedNotices), Date.now()));
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      const res = await apiFetch(`/api/v1/notices/active?lang=${locale}`, parseNotices);
      if (!cancelled && res.ok) {
        setNotices(res.data);
        setClock(Date.now());
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), NOTICE_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [locale]);

  // Re-evaluate exactly when a notice starts or expires (TTL is enforced client-side too).
  useEffect(() => {
    const wait = nextNoticeChange(notices, clock);
    if (wait === null) return;
    const timer = window.setTimeout(() => setClock(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [notices, clock]);

  const notice = pickNotice(notices, dismissed, clock);

  const dismissNotice = useCallback((id: string) => {
    const now = Date.now();
    const target = notices.find(n => n.id === id);
    const stored = parseDismissed(readStored(STORAGE_KEYS.dismissedNotices), now);
    const next = target ? addDismissed(stored, target, now) : stored;
    writeStored(STORAGE_KEYS.dismissedNotices, next);
    setDismissed(next);
  }, [notices]);

  const tabLabel: Record<HomeTab, string> = { ai: s.tabAi, profile: s.tabProfile, knowledges: s.tabKnowledge };
  const paneProps = (pane: HomeTab) => (tabsMode
    ? { role: 'tabpanel' as const, 'aria-labelledby': `home-tab-${pane}`, tabIndex: -1 }
    : { 'aria-label': tabLabel[pane] });
  const toggleLabel = mascotHidden ? (notice ? `${s.showZuey} (${s.noticeWaiting})` : s.showZuey) : s.hideZuey;

  return (
    <div ref={rootRef} className="home-root">
      <a href="#home-main" className="home-skip">{s.skip}</a>
      <WeatherBackdrop report={weather} reduced={reduced} />

      <header className="home-topbar home-reveal" data-mascot-avoid>
        <a href="/" className="home-wordmark" aria-label="zuey.me — Duy Nguyen">
          zuey.me <small aria-hidden="true">Duy Nguyen</small>
        </a>
        <div className="home-actions">
          <WeatherControl strings={s.weather} locale={locale} onReport={setWeather} />
          <LanguageSwitch locale={locale} label={s.language} beforeNavigate={fadeOut} />
          <button
            type="button"
            className="home-chip"
            aria-haspopup="dialog"
            aria-keyshortcuts="Control+K Meta+K"
            aria-label={s.commands}
            onClick={() => setPaletteOpen(true)}
            data-press
          >
            <Command aria-hidden="true" className="w-4 h-4" />
            <span className="home-chip-label">{s.commands}</span>
            <kbd aria-hidden="true">{shortcut}</kbd>
          </button>
          <a href="/account" className="home-chip" aria-label={s.account} data-press>
            <User aria-hidden="true" className="w-4 h-4" />
            <span className="home-chip-label">{s.account}</span>
          </a>
          <button
            id="home-mascot-toggle"
            type="button"
            className="home-chip"
            aria-pressed={!mascotHidden}
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={() => setHidden(!mascotHidden)}
            data-press
          >
            {mascotHidden ? <Eye aria-hidden="true" className="w-4 h-4" /> : <EyeOff aria-hidden="true" className="w-4 h-4" />}
            {mascotHidden && notice && <span className="home-chip-dot" aria-hidden="true" />}
          </button>
        </div>
      </header>

      <nav className="home-tabs home-reveal" aria-label={s.tabsLabel} data-mascot-avoid>
        <div ref={tabRef} className="home-tablist" role="tablist" aria-label={s.tabsLabel} onKeyDown={onTabKey}>
          <span className="home-tab-indicator" aria-hidden="true" />
          {TABS.map(t => (
            <button
              key={t}
              id={`home-tab-${t}`}
              type="button"
              role="tab"
              className="home-tab"
              aria-selected={tab === t}
              aria-controls={`home-pane-${t}`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => applyTab(t, { updateHash: true })}
            >
              {tabLabel[t]}
            </button>
          ))}
        </div>
      </nav>

      <main ref={workspaceRef} id="home-main" className="home-workspace" tabIndex={-1}>
        <section id="home-pane-ai" data-pane="ai" className="home-pane home-reveal" {...paneProps('ai')}>
          {aiPanel}
        </section>
        <section id="home-pane-profile" data-pane="profile" className="home-pane home-reveal" {...paneProps('profile')}>
          <ProfileView initialProfile={profile} initialLinks={links} locale={locale} />
        </section>
        <section id="home-pane-knowledges" data-pane="knowledges" className="home-pane home-reveal" {...paneProps('knowledges')}>
          {knowledgePanel}
        </section>
      </main>

      <div className="home-below">
        <OfferCards strings={s.offer} />
        <GithubActivity strings={s.activity} locale={locale} />
        <p className="text-center text-[12px] text-stone-400">
          <a href="/privacy" className="underline underline-offset-2 hover:text-stone-200">{s.privacy}</a>
        </p>
      </div>

      {!mascotHidden && (
        <Mascot
          strings={s.mascot}
          locale={locale}
          weather={weather}
          notice={notice}
          onDismissNotice={dismissNotice}
          onHide={hideMascot}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        strings={s.palette}
        locale={locale}
        onOpenMcp={openMcp}
        onShowActivity={showActivity}
      />
      <McpDialog open={mcpOpen} onClose={closeMcp} strings={s.mcp} />
    </div>
  );
};

export default HomeShell;
