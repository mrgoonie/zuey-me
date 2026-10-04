import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import type { LinkItem, Profile } from '../../db/types';
import type { PublicNotice } from '../../lib/experience/notices';
import type { WeatherReport } from '../../lib/experience/weather';
import type { Locale } from '../../lib/i18n/locales';
import { ProfileView } from '../ProfileView';
import { apiFetch, parseNotices } from '../home/api-client';
import { CommandPalette } from '../home/CommandPalette';
import { GithubActivity } from '../home/GithubActivity';
import { homeStrings } from '../home/home-i18n';
import { Mascot } from '../home/Mascot';
import { McpGuide } from '../home/McpGuide';
import { useMediaQuery, useReducedMotion } from '../home/motion';
import { addDismissed, nextNoticeChange, parseDismissed, pickNotice } from '../home/notice-queue';
import { STORAGE_KEYS, readStored, writeStored } from '../home/storage';
import { WeatherBackdrop } from '../home/WeatherBackdrop';
import { APPS, DOCK_APPS, SLOT_APPS, appFromHash, type AppId, type Rect, type SlotAppId } from './apps';
import { AppGlyph } from './AppGlyph';
import { AppearancePanel } from './AppearancePanel';
import { Dock } from './Dock';
import {
  DEFAULT_LOOK, applyLook, imageFileToWallpaper, readLook, readWallImage, resolvedTheme, writeLook, writeWallImage, type Look,
} from './look';
import { MenuBar, type MenuItem } from './MenuBar';
import { MobileHome } from './MobileHome';
import { osStrings } from './os-i18n';
import { OsWindow, type ExpoPlacement } from './OsWindow';
import {
  BOOT_APPS, GAP, expoLayout, initialWins, placedRect, readLayout, readOpen, topId, visibleIds, winReducer, writeLayout, writeOpen,
  type Area, type WinMode,
} from './window-store';
import '../home/home.css';
import './os.css';

const PHONE_QUERY = '(max-width: 767px)';
const NOTICE_REFRESH_MS = 5 * 60 * 1000;
const EXPO_MS = 420;

type Slots = Partial<Record<SlotAppId, React.ReactNode>>;

interface ZueyOSProps extends Slots {
  locale: Locale;
  profile: Profile;
  links: LinkItem[];
  signedIn: boolean;
}

interface ExpoState {
  order: AppId[];
  cols: number;
  sel: number;
  placements: Partial<Record<AppId, ExpoPlacement>>;
  labels: { id: AppId; x: number; y: number; maxW: number; min: boolean }[];
  leaving: boolean;
  prevTop: AppId | null;
}

/**
 * zuey.me as a small desktop: menubar, wallpaper (+ live weather), windows hosting the real
 * panels, a dock, Exposé (every window as a live thumbnail), and appearance settings. Below
 * 768px it becomes a phone home screen whose apps open as full-height sheets.
 */
export const ZueyOS: React.FC<ZueyOSProps> = ({ locale, profile, links, signedIn, ...slots }) => {
  const s = osStrings(locale);
  const hs = homeStrings(locale);
  const reduced = useReducedMotion();
  const mobile = useMediaQuery(PHONE_QUERY);
  const [wins, dispatch] = useReducer(winReducer, BOOT_APPS, initialWins);
  const [ready, setReady] = useState(false);
  const [area, setArea] = useState<Area | null>(null);
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  const [wallImage, setWallImage] = useState<string | null>(null);
  const [lookMsg, setLookMsg] = useState('');
  const [dropping, setDropping] = useState(false);
  const [expo, setExpo] = useState<ExpoState | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcut, setShortcut] = useState('Ctrl K');
  const [weather, setWeather] = useState<WeatherReport | null>(null);
  const [mascotHidden, setMascotHidden] = useState(true);
  const [notices, setNotices] = useState<PublicNotice[]>([]);
  const [dismissed, setDismissed] = useState<ReturnType<typeof parseDismissed>>([]);
  const [clock, setClock] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const winsRef = useRef(wins);
  winsRef.current = wins;

  /* ---------- work area ---------- */
  const measure = useCallback((): Area => {
    const el = screenRef.current;
    const w = el?.clientWidth ?? window.innerWidth;
    const h = el?.clientHeight ?? window.innerHeight;
    const dock = document.querySelector<HTMLElement>('.os-dock');
    const dockH = dock && dock.offsetWidth ? window.innerHeight - dock.getBoundingClientRect().top + 10 : GAP;
    return { w, h, b: h - dockH };
  }, []);
  const getArea = useCallback(() => area ?? measure(), [area, measure]);

  useLayoutEffect(() => {
    setArea(measure());
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setArea(measure()));
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf); };
  }, [measure]);

  /* ---------- restore session: layout, open windows, hash, look ---------- */
  useEffect(() => {
    const phone = window.matchMedia(PHONE_QUERY).matches;
    const hashApp = appFromHash(window.location.hash);
    const saved = readOpen();
    let open = phone ? [] : (saved ?? (window.innerWidth >= 1500 ? [...BOOT_APPS, 'knowledges' as const] : BOOT_APPS));
    if (hashApp) open = [...open.filter(id => id !== hashApp), hashApp];
    dispatch({ type: 'restore', open, layout: readLayout() });
    setLook(readLook());
    setWallImage(readWallImage());
    setMascotHidden(readStored(STORAGE_KEYS.mascotHidden) === true);
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setShortcut('⌘K');
    document.documentElement.setAttribute('data-os-ready', '');
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    writeLayout(wins);
    if (!window.matchMedia(PHONE_QUERY).matches) writeOpen(wins);
  }, [wins, ready]);

  /* ---------- look ---------- */
  useEffect(() => {
    if (!ready) return;
    applyLook(look);
    writeLook(look);
    if (look.mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyLook(look);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [look, ready]);

  useEffect(() => {
    const root = document.documentElement;
    if (wallImage) root.style.setProperty('--wp-img', `url("${wallImage}")`);
    else root.style.removeProperty('--wp-img');
  }, [wallImage]);

  const changeLook = useCallback((patch: Partial<Look>) => {
    const apply = () => setLook(prev => ({ ...prev, ...patch }));
    const vt = 'startViewTransition' in document && !reduced && document.visibilityState === 'visible' ? document.startViewTransition.bind(document) : null;
    if (!vt) { apply(); return; }
    // A tab that is not painting never runs the transition callback: apply the change anyway.
    let done = false;
    const once = () => { if (!done) { done = true; apply(); } };
    vt(once);
    window.setTimeout(once, 400);
  }, [reduced]);

  const setImage = useCallback(async (file: File) => {
    try {
      const url = await imageFileToWallpaper(file);
      const kept = writeWallImage(url);
      setWallImage(url);
      setLookMsg(kept ? '' : s.look.tooLarge);
      changeLook({ wallpaper: 'image' });
    } catch (err) {
      setLookMsg(err instanceof Error && err.message === 'not_image' ? s.look.notImage : s.look.unreadable);
    }
  }, [changeLook, s.look]);

  const resetLook = useCallback(() => {
    writeWallImage(null);
    setWallImage(null);
    setLookMsg('');
    changeLook({ ...DEFAULT_LOOK });
  }, [changeLook]);

  const dark = ready ? resolvedTheme(look.mode) === 'dark' : true;
  const toggleTheme = useCallback(() => changeLook({ mode: dark ? 'light' : 'dark' }), [changeLook, dark]);

  // Video wallpaper: plays only when chosen and motion is allowed.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (look.wallpaper === 'video' && !reduced) void v.play().catch(() => undefined);
    else v.pause();
  }, [look.wallpaper, reduced]);

  // Drop an image anywhere on the desktop to make it the wallpaper.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    let depth = 0;
    const onEnter = (e: DragEvent) => { if (!hasFiles(e)) return; depth += 1; setDropping(true); };
    const onLeave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDropping(false); };
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      const file = e.dataTransfer?.files[0];
      if (file) void setImage(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [setImage]);

  /* ---------- window actions ---------- */
  const setHash = useCallback((id: AppId | null) => {
    const url = new URL(window.location.href);
    url.hash = id ?? '';
    window.history.replaceState(window.history.state, '', url.hash ? url : url.pathname + url.search);
  }, []);

  const openApp = useCallback((id: AppId) => {
    setExpo(null);
    dispatch({ type: 'open', id });
    setHash(id);
  }, [setHash]);

  const closeApp = useCallback((id: AppId) => {
    dispatch({ type: 'close', id });
    if (appFromHash(window.location.hash) === id) setHash(null);
  }, [setHash]);

  const minimizeApp = useCallback((id: AppId) => {
    if (window.matchMedia(PHONE_QUERY).matches) closeApp(id);
    else dispatch({ type: 'minimize', id });
  }, [closeApp]);

  const toggleMax = useCallback((id: AppId) => {
    if (window.matchMedia(PHONE_QUERY).matches) return;
    dispatch({ type: 'mode', id, mode: winsRef.current[id].mode === 'max' ? 'normal' : 'max' });
  }, []);

  const snap = useCallback((id: AppId, side: 'left' | 'right') => {
    dispatch({ type: 'mode', id, mode: winsRef.current[id].mode === side ? 'normal' : side });
  }, []);

  const launch = useCallback((id: AppId) => {
    const w = winsRef.current[id];
    if (w.open && !w.min && topId(winsRef.current) === id) minimizeApp(id);
    else openApp(id);
  }, [minimizeApp, openApp]);

  const commit = useCallback((id: AppId, rect: Rect, mode: WinMode) => {
    dispatch({ type: 'rect', id, rect, mode });
  }, []);

  // Hash navigation (#ai, #knowledges, legacy #profile / #activity) opens the matching window.
  useEffect(() => {
    const onHash = () => {
      const id = appFromHash(window.location.hash);
      if (id) openApp(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [openApp]);

  /* ---------- Exposé ---------- */
  const enterExpo = useCallback(() => {
    if (window.matchMedia(PHONE_QUERY).matches) return;
    const a = measure();
    const all = (Object.keys(winsRef.current) as AppId[]).filter(id => winsRef.current[id].open);
    if (!all.length) return;
    const rectOf = (id: AppId): Rect => {
      const el = screenRef.current?.querySelector<HTMLElement>(`.osw[data-app="${id}"]`);
      if (el && !el.hidden && el.offsetWidth) return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      return placedRect(winsRef.current[id], id, a);
    };
    const rects = new Map(all.map(id => [id, rectOf(id)]));
    const band = (id: AppId) => Math.round((rects.get(id)?.y ?? 0) / 220);
    const live = all.filter(id => !winsRef.current[id].min).sort((p, q) => band(p) - band(q) || (rects.get(p)?.x ?? 0) - (rects.get(q)?.x ?? 0));
    const order = [...live, ...all.filter(id => winsRef.current[id].min)];
    const { cols, slots } = expoLayout(order.map(id => rects.get(id) ?? { x: 0, y: 0, w: 1, h: 1 }), a);
    const top = topId(winsRef.current);
    const sel = Math.max(0, order.indexOf(top ?? order[0]));
    const placements: ExpoState['placements'] = {};
    const labels: ExpoState['labels'] = [];
    order.forEach((id, i) => {
      const r = rects.get(id) ?? { x: 0, y: 0, w: 1, h: 1 };
      const sl = slots[i];
      placements[id] = {
        transform: `translate(${Math.round(sl.cx - (r.w * sl.s) / 2 - r.x)}px,${Math.round(sl.cy - (r.h * sl.s) / 2 - r.y)}px) scale(${sl.s.toFixed(4)})`,
        scale: sl.s,
        selected: i === sel,
        fromDock: winsRef.current[id].min,
      };
      labels.push({ id, x: Math.round(sl.cx), y: Math.round(sl.cy + (r.h * sl.s) / 2 + 10), maxW: Math.round(sl.cw), min: winsRef.current[id].min });
    });
    setExpo({ order, cols, sel, placements, labels, leaving: false, prevTop: top });
  }, [measure]);

  const exitExpo = useCallback((pick: AppId | null) => {
    setExpo(prev => {
      if (!prev || prev.leaving) return prev;
      if (pick) {
        dispatch({ type: 'open', id: pick });
        setHash(pick);
      }
      const placements: ExpoState['placements'] = {};
      for (const id of prev.order) {
        const p = prev.placements[id];
        if (!p) continue;
        const staysMin = winsRef.current[id].min && id !== pick;
        placements[id] = { ...p, selected: false, transform: staysMin ? `${p.transform} translateY(40px)` : 'none', fromDock: staysMin };
      }
      return { ...prev, placements, leaving: true };
    });
    window.setTimeout(() => setExpo(prev => (prev?.leaving ? null : prev)), reduced ? 0 : EXPO_MS);
  }, [reduced, setHash]);

  const toggleExpo = useCallback(() => {
    if (expo) exitExpo(null);
    else enterExpo();
  }, [enterExpo, exitExpo, expo]);

  const moveExpoSel = useCallback((next: (sel: number, n: number, cols: number) => number) => {
    setExpo(prev => {
      if (!prev || prev.leaving) return prev;
      const sel = next(prev.sel, prev.order.length, prev.cols);
      const placements = { ...prev.placements };
      prev.order.forEach((id, i) => { const p = placements[id]; if (p) placements[id] = { ...p, selected: i === sel }; });
      return { ...prev, sel, placements };
    });
  }, []);

  // Exposé keys run before everything else while it is open.
  useEffect(() => {
    if (!expo || expo.leaving) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      let handled = true;
      if (k === 'Escape' || (e.altKey && e.code === 'KeyO')) exitExpo(null);
      else if (k === 'Enter' || k === ' ') exitExpo(expo.order[expo.sel] ?? null);
      else if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) moveExpoSel((i, n) => (i + 1) % n);
      else if (k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey)) moveExpoSel((i, n) => (i - 1 + n) % n);
      else if (k === 'ArrowDown') moveExpoSel((i, n, c) => Math.min(n - 1, i + c));
      else if (k === 'ArrowUp') moveExpoSel((i, _n, c) => Math.max(0, i - c));
      else if (/^[1-9]$/.test(k) && Number(k) <= expo.order.length) exitExpo(expo.order[Number(k) - 1]);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', () => exitExpo(null), { once: true });
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expo, exitExpo, moveExpoSel]);

  /* ---------- global shortcuts ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(v => !v);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || paletteOpen) return;
      const top = topId(winsRef.current);
      const digit = /^Digit([1-9])$/.exec(e.code);
      let handled = true;
      if (digit) {
        const id = DOCK_APPS[Number(digit[1]) - 1];
        if (id) openApp(id);
      } else if (e.code === 'KeyO') toggleExpo();
      else if (e.code === 'KeyT') toggleTheme();
      else if (e.code === 'KeyW' && top) closeApp(top);
      else if (e.code === 'KeyM' && top) minimizeApp(top);
      else if (e.key === 'ArrowUp' && top) toggleMax(top);
      else if (e.key === 'ArrowDown' && top) {
        if (winsRef.current[top].mode !== 'normal') dispatch({ type: 'mode', id: top, mode: 'normal' });
        else minimizeApp(top);
      } else if (e.key === 'ArrowLeft' && top) snap(top, 'left');
      else if (e.key === 'ArrowRight' && top) snap(top, 'right');
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeApp, minimizeApp, openApp, paletteOpen, snap, toggleExpo, toggleMax, toggleTheme]);

  /* ---------- companion & Duy notices ---------- */
  const setHidden = useCallback((hidden: boolean) => {
    setMascotHidden(hidden);
    writeStored(STORAGE_KEYS.mascotHidden, hidden);
  }, []);
  const hideMascot = useCallback(() => {
    setHidden(true);
    document.getElementById('home-mascot-toggle')?.focus();
  }, [setHidden]);

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

  /* ---------- locale switch fade, bfcache restore ---------- */
  const fadeOut = useCallback(async () => {
    const el = rootRef.current;
    if (!el || reduced) return;
    await el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => undefined);
  }, [reduced]);
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) rootRef.current?.getAnimations().forEach(a => a.cancel());
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  /* ---------- menus & palette ---------- */
  const menu: MenuItem[] = useMemo(() => [
    { key: 'about', label: s.apps.about, run: () => openApp('about') },
    { key: 'appearance', label: s.appearance, run: () => openApp('appearance') },
    { key: 'theme', label: dark ? s.toLight : s.toDark, kbd: 'Alt T', run: toggleTheme },
    { key: 'expo', label: s.allWindows, kbd: 'Alt O', run: enterExpo },
    { key: 'arrange', label: s.arrange, run: () => dispatch({ type: 'arrange', area: measure() }) },
    { key: 'close', label: s.closeAll, run: () => { dispatch({ type: 'closeAll' }); setHash(null); } },
    { key: 'mascot', label: mascotHidden ? s.showZuey : s.hideZuey, run: () => setHidden(!mascotHidden) },
    { key: 'docs', label: s.links.docs, run: () => window.location.assign('/docs') },
    { key: 'privacy', label: s.privacy, run: () => window.location.assign('/privacy') },
  ], [s, dark, mascotHidden, toggleTheme, enterExpo, measure, openApp, setHash, setHidden]);

  const paletteOverrides = useMemo(() => ({
    chat: () => openApp('ai'),
    pricing: () => openApp('pricing'),
    business: () => openApp('business'),
    account: () => openApp('account'),
  }), [openApp]);

  const top = topId(wins);
  const anyVisible = visibleIds(wins).length > 0;

  /* ---------- window contents ---------- */
  const content = (id: AppId): React.ReactNode => {
    if ((SLOT_APPS as AppId[]).includes(id)) return slots[id as SlotAppId] ?? null;
    switch (id) {
      case 'about':
        return <ProfileView initialProfile={profile} initialLinks={links} locale={locale} framed={false} />;
      case 'github':
        return <GithubActivity strings={hs.activity} locale={locale} variant="window" />;
      case 'mcp':
        return <McpGuide strings={hs.mcp} />;
      case 'appearance':
        return (
          <AppearancePanel
            look={look}
            hasImage={wallImage !== null}
            message={lookMsg}
            strings={s.look}
            onChange={changeLook}
            onImage={f => void setImage(f)}
            onReset={resetLook}
          />
        );
      default:
        return null;
    }
  };

  const placed = (id: AppId): Rect | null => (ready && area && !mobile ? placedRect(wins[id], id, area) : null);

  return (
    <div
      ref={rootRef}
      className={`os-root${anyVisible ? ' has-sheet' : ''}${expo && !expo.leaving ? ' is-expo' : ''}`}
    >
      <a href="#os-screen" className="os-skip">{s.skip}</a>

      <div className="os-desk" aria-hidden="true">
        <video ref={videoRef} muted loop playsInline preload="none" src={look.wallpaper === 'video' ? '/loop.mp4' : undefined} />
        <span className="os-wordmark">zuey</span>
      </div>
      <WeatherBackdrop report={weather} reduced={reduced} />

      <MenuBar
        locale={locale}
        strings={s}
        homeStrings={hs}
        activeApp={top}
        dark={dark}
        mascotHidden={mascotHidden}
        noticeWaiting={notice !== null}
        signedIn={signedIn}
        shortcut={shortcut}
        menu={menu}
        onWeather={setWeather}
        onPalette={() => setPaletteOpen(true)}
        onToggleTheme={toggleTheme}
        onToggleMascot={() => setHidden(!mascotHidden)}
        onAccount={() => openApp('account')}
        beforeNavigate={fadeOut}
      />

      <MobileHome locale={locale} profile={profile} strings={s} homeStrings={hs} onOpen={openApp} />

      <main id="os-screen" ref={screenRef} className="os-screen" aria-label={s.desktop} tabIndex={-1}>
        {expo && (
          <div
            className={`os-expo${expo.leaving ? ' is-leaving' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label={s.expo.title}
            onClick={() => exitExpo(null)}
          >
            <p className="os-expo-hint"><b>{s.expo.title}</b><span>{s.expo.hint}</span></p>
            {expo.labels.map((l, i) => (
              <button
                key={l.id}
                type="button"
                tabIndex={-1}
                className={`os-expo-lbl${i === expo.sel ? ' on' : ''}`}
                style={{ left: l.x, top: l.y, maxWidth: l.maxW }}
                onClick={e => { e.stopPropagation(); exitExpo(l.id); }}
              >
                {i < 9 && <i>{i + 1}</i>}
                <AppGlyph id={l.id} avatar={profile.avatar_url} />
                <span>{s.apps[l.id]}</span>
                {l.min && <small>{s.expo.minimized}</small>}
              </button>
            ))}
            <p className="sr-only" aria-live="polite">{`${expo.sel + 1}/${expo.order.length} · ${s.apps[expo.order[expo.sel]]}`}</p>
          </div>
        )}

        {(Object.keys(APPS) as AppId[]).filter(id => wins[id].mounted || (SLOT_APPS as AppId[]).includes(id)).map(id => (
          <OsWindow
            key={id}
            app={APPS[id]}
            title={s.apps[id]}
            state={wins[id]}
            rect={placed(id)}
            focused={top === id}
            mobile={mobile}
            reduced={reduced}
            expo={expo?.placements[id] ?? null}
            strings={s.win}
            getArea={getArea}
            onFocus={() => { if (top !== id) dispatch({ type: 'focus', id }); }}
            onClose={() => closeApp(id)}
            onMinimize={() => minimizeApp(id)}
            onToggleMax={() => toggleMax(id)}
            onCommit={(r, m) => commit(id, r, m)}
            onExpoPick={() => exitExpo(id)}
          >
            {content(id)}
          </OsWindow>
        ))}
      </main>

      <Dock wins={wins} avatar={profile.avatar_url} expoOn={expo !== null && !expo.leaving} reduced={reduced} strings={s} onLaunch={launch} onExpo={toggleExpo} />

      {dropping && (
        <div className="os-drop" aria-hidden="true">
          <div><ImagePlus aria-hidden /><b>{s.look.drop}</b><span>{s.look.uploadHint}</span></div>
        </div>
      )}

      {!mascotHidden && (
        <Mascot strings={hs.mascot} locale={locale} weather={weather} notice={notice} onDismissNotice={dismissNotice} onHide={hideMascot} />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        strings={hs.palette}
        locale={locale}
        onOpenMcp={() => openApp('mcp')}
        onShowActivity={() => openApp('github')}
        actionOverrides={paletteOverrides}
      />
    </div>
  );
};

export default ZueyOS;
