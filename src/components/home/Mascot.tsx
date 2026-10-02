import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Megaphone, Pause, Play, X, EyeOff } from 'lucide-react';
import type { PublicNotice } from '../../lib/experience/notices';
import type { WeatherReport } from '../../lib/experience/weather';
import type { HomeStrings } from './home-i18n';
import { fmt } from './home-i18n';
import type { MascotManifest, SpriteAnimation } from './mascot-manifest';
import { WEATHER_EXPRESSION, framePosition, parseMascotManifest } from './mascot-manifest';
import { loadGsap, useReducedMotion } from './motion';
import { STORAGE_KEYS, isRecord, readStored, writeStored } from './storage';

interface MascotProps {
  strings: HomeStrings['mascot'];
  locale: string;
  weather: WeatherReport | null;
  notice: PublicNotice | null;
  onDismissNotice: (id: string) => void;
  onHide: () => void;
}

type Bubble =
  | { kind: 'ambient'; text: string }
  | { kind: 'duy'; notice: PublicNotice };

interface Point { x: number; y: number }

const EDGE = 8;
const WALK_PX_PER_SEC = 110;
const TYPING_GRACE_MS = 2500;
const AMBIENT_MS = 7000;
const MAX_TIPS_PER_VISIT = 4;
const EDITABLE_SELECTOR = 'input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select, [contenteditable="true"]';

function isEditable(el: EventTarget | null): el is HTMLElement {
  return el instanceof HTMLElement && el.matches(EDITABLE_SELECTOR);
}

function overlapArea(a: DOMRect | { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function viewport(): { w: number; h: number } {
  return { w: document.documentElement.clientWidth || window.innerWidth, h: window.innerHeight };
}

function random<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Sprite companion driven by public/mascot/manifest.json. Wanders within the viewport while
 * avoiding inputs and marked hotspots, can be dragged (pointer/touch), clicked or driven by the
 * keyboard, and speaks through an overhead bubble: ambient tips vs. labelled notices from Duy.
 */
export const Mascot: React.FC<MascotProps> = ({ strings, locale, weather, notice, onDismissNotice, onHide }) => {
  const reduced = useReducedMotion();
  const [manifest, setManifest] = useState<MascotManifest | null>(null);
  const [ready, setReady] = useState(false);
  const [anim, setAnim] = useState('idle');
  const [facingLeft, setFacingLeft] = useState(false);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [placement, setPlacement] = useState<{ below: boolean; alignRight: boolean }>({ below: false, alignRight: true });
  const [paused, setPaused] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const spriteRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<Point>({ x: -999, y: -999 });
  const tweenRef = useRef<{ kill: () => void } | null>(null);
  const walkingRef = useRef(false);
  const typingUntilRef = useRef(0);
  const engagedRef = useRef(false);
  const dragRef = useRef<{ id: number; startX: number; startY: number; offX: number; offY: number; moved: boolean } | null>(null);
  const tipsShownRef = useRef(0);
  const ambientTimerRef = useRef<number | undefined>(undefined);
  const shownWeatherRef = useRef<string | null>(null);

  const size = () => wrapperRef.current?.offsetWidth || 112;

  const bounds = useCallback(() => {
    const { w, h } = viewport();
    const s = size();
    const bar = document.querySelector('[data-home-topbar]');
    const top = bar ? bar.getBoundingClientRect().bottom + EDGE : EDGE;
    return { minX: EDGE, maxX: Math.max(EDGE, w - s - EDGE), minY: Math.min(top, h - s - EDGE), maxY: Math.max(top, h - s - EDGE - 40) };
  }, []);

  const clamp = useCallback((p: Point): Point => {
    const b = bounds();
    return { x: Math.min(Math.max(p.x, b.minX), b.maxX), y: Math.min(Math.max(p.y, b.minY), b.maxY) };
  }, [bounds]);

  const updatePlacement = useCallback(() => {
    const { w } = viewport();
    const p = posRef.current;
    setPlacement({ below: p.y < 220, alignRight: p.x + size() / 2 > w / 2 });
  }, []);

  const apply = useCallback(() => {
    const el = wrapperRef.current;
    if (el) el.style.transform = `translate3d(${Math.round(posRef.current.x)}px, ${Math.round(posRef.current.y)}px, 0)`;
  }, []);

  const persist = useCallback((nextPaused?: boolean) => {
    const { w, h } = viewport();
    writeStored(STORAGE_KEYS.mascot, {
      rx: posRef.current.x / Math.max(1, w),
      ry: posRef.current.y / Math.max(1, h),
      paused: nextPaused ?? paused,
    });
  }, [paused]);

  /** Bounding boxes the companion should not cover: form fields, marked hotspots and the focused element. */
  const hotspots = useCallback(() => {
    const { w, h } = viewport();
    const els = Array.from(document.querySelectorAll(`${EDITABLE_SELECTOR}, [data-mascot-avoid]`));
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) els.push(document.activeElement);
    return els
      .filter(el => !wrapperRef.current?.contains(el))
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < h && r.right > 0 && r.left < w)
      .map(r => ({ left: r.left - 16, top: r.top - 16, right: r.right + 16, bottom: r.bottom + 16 }));
  }, []);

  const pickSpot = useCallback((): Point => {
    const b = bounds();
    const s = size();
    const spots = hotspots();
    const here = posRef.current;
    const candidates: Point[] = [
      { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }, { x: b.maxX, y: (b.minY + b.maxY) / 2 }, { x: b.minX, y: (b.minY + b.maxY) / 2 },
    ];
    for (let i = 0; i < 28; i += 1) candidates.push({ x: b.minX + Math.random() * (b.maxX - b.minX), y: b.minY + Math.random() * (b.maxY - b.minY) });
    let best = candidates[0];
    let bestScore = Infinity;
    for (const c of candidates) {
      // Only the silhouette (middle half of the cell) matters for covering content.
      const box = { left: c.x + s * 0.25, top: c.y, right: c.x + s * 0.75, bottom: c.y + s };
      const covered = spots.reduce((sum, r) => sum + overlapArea(box, r), 0);
      const travel = Math.hypot(c.x - here.x, c.y - here.y);
      const score = covered + travel * 0.6 + (travel < 60 ? 4000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return clamp(best);
  }, [bounds, clamp, hotspots]);

  const moveTo = useCallback(async (target: Point, opts: { walk?: boolean; durationScale?: number } = {}) => {
    const to = clamp(target);
    tweenRef.current?.kill();
    const from = { ...posRef.current };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (Math.abs(to.x - from.x) > 2) setFacingLeft(to.x < from.x);
    const gsap = reduced ? null : await loadGsap();
    if (!gsap || distance < 2 || opts.walk === false) {
      posRef.current = to;
      apply();
      updatePlacement();
      persist();
      return;
    }
    walkingRef.current = true;
    setAnim('walk');
    const tween = gsap.to(posRef.current, {
      x: to.x,
      y: to.y,
      duration: Math.min(6, Math.max(0.5, distance / WALK_PX_PER_SEC)) * (opts.durationScale ?? 1),
      ease: 'sine.inOut',
      onUpdate: apply,
      onComplete: () => {
        walkingRef.current = false;
        setAnim('idle');
        updatePlacement();
        persist();
      },
    });
    tweenRef.current = { kill: () => { tween.kill(); walkingRef.current = false; } };
  }, [apply, clamp, persist, reduced, updatePlacement]);

  const isTyping = () => Date.now() < typingUntilRef.current;

  /** Plays a UI state (manifest `expressions` key such as wave, talking, happy) as its animation. */
  const play = useCallback((state: string) => {
    setAnim(manifest?.expressions[state] ?? (manifest?.animations[state] ? state : 'idle'));
  }, [manifest]);

  const say = useCallback((text: string, state?: string) => {
    window.clearTimeout(ambientTimerRef.current);
    updatePlacement();
    setBubble(prev => (prev?.kind === 'duy' ? prev : { kind: 'ambient', text }));
    if (state) play(state);
    ambientTimerRef.current = window.setTimeout(() => setBubble(prev => (prev?.kind === 'ambient' ? null : prev)), AMBIENT_MS);
  }, [play, updatePlacement]);

  // Auto-hide the touch toolbar a few seconds after a tap.
  useEffect(() => {
    if (!toolsOpen) return;
    const t = window.setTimeout(() => setToolsOpen(false), 6000);
    return () => window.clearTimeout(t);
  }, [toolsOpen]);

  // Load and validate the manifest, then decode the atlas before showing anything.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/mascot/manifest.json', { cache: 'force-cache' });
        if (!res.ok) return;
        const parsed = parseMascotManifest(await res.json());
        if (!parsed || cancelled) return;
        const img = new Image();
        img.src = parsed.imageWebp;
        try {
          await img.decode();
        } catch {
          parsed.imageWebp = parsed.imagePng;
        }
        if (!cancelled) setManifest(parsed);
      } catch {
        // No manifest, no companion: the page is complete without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore position/pause state and make an entrance.
  useEffect(() => {
    if (!manifest) return;
    const stored = readStored(STORAGE_KEYS.mascot);
    const { w, h } = viewport();
    const b = bounds();
    let target: Point = { x: b.maxX - 12, y: b.maxY };
    if (isRecord(stored)) {
      if (typeof stored.rx === 'number' && typeof stored.ry === 'number') target = clamp({ x: stored.rx * w, y: stored.ry * h });
      if (stored.paused === true) setPaused(true);
    }
    if (reduced) {
      posRef.current = target;
      apply();
      updatePlacement();
      setReady(true);
      return;
    }
    posRef.current = { x: w + 10, y: target.y };
    apply();
    setReady(true);
    void moveTo(target, { durationScale: 0.8 });
    // Runs once per manifest load; later reduced-motion changes are handled by the frame player.
  }, [manifest]);

  // Frame player: manifest durations, loops, and the reduced-motion still frame.
  useEffect(() => {
    if (!manifest) return;
    const animation: SpriteAnimation = manifest.animations[anim] ?? manifest.animations.idle;
    const show = (frameIndex: number) => {
      const frame = animation.frames[frameIndex];
      if (spriteRef.current) spriteRef.current.style.backgroundPosition = framePosition(frame, manifest);
    };
    if (reduced || (paused && anim === 'idle')) {
      if (spriteRef.current) spriteRef.current.style.backgroundPosition = framePosition(animation.reducedMotionFrame, manifest);
      if (reduced && !animation.loop && anim !== 'idle') {
        const t = window.setTimeout(() => setAnim(walkingRef.current ? 'walk' : 'idle'), 1400);
        return () => window.clearTimeout(t);
      }
      return;
    }
    let i = 0;
    let timer: number | undefined;
    // Expression loops (e.g. talking) settle back to idle; only idle and walk loop indefinitely.
    const settleAt = anim === 'idle' || anim === 'walk' ? Infinity : Date.now() + 2600;
    const step = () => {
      show(i);
      timer = window.setTimeout(() => {
        i += 1;
        if (i >= animation.frames.length) {
          if (!animation.loop || Date.now() >= settleAt) {
            setAnim(walkingRef.current ? 'walk' : 'idle');
            return;
          }
          i = 0;
        }
        step();
      }, animation.frames[i].durationMs);
    };
    step();
    return () => window.clearTimeout(timer);
  }, [anim, manifest, paused, reduced]);

  // Autonomous wandering (never while paused, reduced, dragged, engaged, typing or showing Duy's notice).
  useEffect(() => {
    if (!ready || paused || reduced) return;
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(() => {
        const busy = document.hidden || dragRef.current || engagedRef.current || isTyping() || walkingRef.current;
        if (!busy && bubble?.kind !== 'duy') void moveTo(pickSpot());
        schedule();
      }, 14000 + Math.random() * 12000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [ready, paused, reduced, bubble, moveTo, pickSpot]);

  // Ambient tips, rate limited and never while typing or paused.
  useEffect(() => {
    if (!ready || paused) return;
    let timer: number | undefined;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        if (tipsShownRef.current >= MAX_TIPS_PER_VISIT) return;
        if (!document.hidden && !isTyping() && !dragRef.current && !bubble) {
          tipsShownRef.current += 1;
          say(random(strings.tips), 'talking');
        }
        schedule(60000 + Math.random() * 30000);
      }, delay);
    };
    schedule(tipsShownRef.current === 0 ? 22000 : 60000);
    return () => window.clearTimeout(timer);
  }, [ready, paused, bubble, say, strings.tips]);

  // Typing avoidance: step away from the focused field and keep quiet while the visitor types.
  useEffect(() => {
    if (!ready) return;
    const sidestep = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const s = size();
      const me = { left: posRef.current.x + s * 0.2, top: posRef.current.y, right: posRef.current.x + s * 0.8, bottom: posRef.current.y + s };
      if (overlapArea(me, { left: r.left - 24, top: r.top - 24, right: r.right + 24, bottom: r.bottom + 24 }) > 0) void moveTo(pickSpot());
    };
    const onFocus = (e: FocusEvent) => {
      if (!isEditable(e.target)) return;
      typingUntilRef.current = Date.now() + TYPING_GRACE_MS;
      sidestep(e.target);
    };
    const onType = (e: Event) => {
      if (!isEditable(e.target)) return;
      typingUntilRef.current = Date.now() + TYPING_GRACE_MS;
      setBubble(prev => (prev?.kind === 'ambient' ? null : prev));
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onType, true);
    document.addEventListener('input', onType, true);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onType, true);
      document.removeEventListener('input', onType, true);
    };
  }, [ready, moveTo, pickSpot]);

  // Keep inside the viewport on resize/rotate.
  useEffect(() => {
    if (!ready) return;
    const onResize = () => {
      tweenRef.current?.kill();
      posRef.current = clamp(posRef.current);
      apply();
      updatePlacement();
      setAnim(a => (a === 'walk' ? 'idle' : a));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [ready, clamp, apply, updatePlacement]);

  // Duy's notice: shown as soon as the visitor is not typing; hidden at its expiry.
  useEffect(() => {
    if (!ready) return;
    if (!notice) {
      setBubble(prev => (prev?.kind === 'duy' ? null : prev));
      return;
    }
    let waitTimer: number | undefined;
    const show = () => {
      if (isTyping() || dragRef.current) {
        waitTimer = window.setTimeout(show, 1000);
        return;
      }
      window.clearTimeout(ambientTimerRef.current);
      updatePlacement();
      setBubble({ kind: 'duy', notice });
      play(notice.expression ?? 'talking');
    };
    show();
    const msLeft = Date.parse(notice.expires_at) - Date.now();
    const expiry = window.setTimeout(() => setBubble(prev => (prev?.kind === 'duy' && prev.notice.id === notice.id ? null : prev)), Math.max(0, Math.min(msLeft, 2 ** 31 - 1)));
    return () => {
      window.clearTimeout(waitTimer);
      window.clearTimeout(expiry);
    };
  }, [notice, ready, play, updatePlacement]);

  // Weather reaction (provenance mapping: clear → happy, rain → thinking, snow → surprised).
  useEffect(() => {
    if (!ready || !weather || !manifest) return;
    const key = `${weather.condition}:${weather.latitude},${weather.longitude}`;
    if (shownWeatherRef.current === key) return;
    shownWeatherRef.current = key;
    const state = WEATHER_EXPRESSION[weather.condition] ?? 'idle';
    const line = strings.weather[weather.condition];
    if (line && !isTyping()) say(line, state);
    else play(state);
  }, [weather, ready, manifest, play, say, strings.weather]);

  const greet = () => {
    play('wave');
    if (bubble?.kind !== 'duy') say(random(strings.greetings));
    setToolsOpen(true);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, offX: e.clientX - posRef.current.x, offY: e.clientY - posRef.current.y, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      tweenRef.current?.kill();
      play('surprised');
    }
    posRef.current = clamp({ x: e.clientX - drag.offX, y: e.clientY - drag.offY });
    apply();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (drag.moved) {
      play('happy');
      updatePlacement();
      persist();
    } else {
      greet();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 72 : 24;
    const moves: Record<string, Point> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    const delta = moves[e.key];
    if (delta) {
      e.preventDefault();
      void moveTo({ x: posRef.current.x + delta.x, y: posRef.current.y + delta.y }, { durationScale: 0.6 });
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      greet();
      return;
    }
    if (e.key === 'Escape' && bubble?.kind === 'ambient') setBubble(null);
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    persist(next);
    if (next) tweenRef.current?.kill();
    setAnim('idle');
  };

  const dismiss = (id: string) => {
    setBubble(null);
    setAnim('idle');
    onDismissNotice(id);
  };

  const timeFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const flip = anim === 'walk' && facingLeft === (manifest?.walkFacing === 'right');

  return (
    <div
      ref={wrapperRef}
      className="zm-companion"
      data-ready={ready ? 'true' : 'false'}
      data-tools={toolsOpen ? 'open' : 'closed'}
      onPointerEnter={() => { engagedRef.current = true; }}
      onPointerLeave={() => { engagedRef.current = false; }}
      onFocus={() => { engagedRef.current = true; }}
      onBlur={() => { engagedRef.current = false; }}
    >
      <div className="zm-bubble-region" role="status" aria-live="polite">
        {bubble && (
          <div className={`zm-bubble ${placement.below ? 'is-below' : ''} ${placement.alignRight ? 'is-right' : 'is-left'} ${bubble.kind === 'duy' ? 'is-duy' : ''}`}>
            {bubble.kind === 'duy' ? (
              <>
                <div className="zm-bubble-head">
                  <span className="zm-duy-badge"><Megaphone aria-hidden="true" className="w-3.5 h-3.5" />{strings.duyBadge}</span>
                </div>
                <p className="zm-bubble-text" lang={bubble.notice.locale}><strong className="zm-bubble-author">{strings.duy}:</strong> {bubble.notice.text}</p>
                <div className="zm-bubble-foot">
                  <span>{fmt(strings.until, { time: timeFmt.format(new Date(bubble.notice.expires_at)) })}</span>
                  <button type="button" className="zm-bubble-dismiss" onClick={() => dismiss(bubble.notice.id)} data-press>
                    {strings.dismiss}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="zm-bubble-head">
                  <span className="zm-bubble-author">{strings.ambient}</span>
                  <button type="button" className="zm-bubble-close" aria-label={strings.closeBubble} onClick={() => setBubble(null)}>
                    <X aria-hidden="true" className="w-4 h-4" />
                  </button>
                </div>
                <p className="zm-bubble-text">{bubble.text}</p>
              </>
            )}
          </div>
        )}
      </div>
      <div ref={spriteRef} className="zm-sprite" aria-hidden="true" style={{ backgroundImage: manifest ? `url(${manifest.imageWebp})` : undefined, transform: flip ? 'scaleX(-1)' : undefined }} />
      <button
        type="button"
        className="zm-body"
        aria-label={strings.label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = null; }}
        onKeyDown={onKeyDown}
      />
      <div className="zm-tools">
        <button type="button" onClick={togglePause} aria-pressed={paused} aria-label={paused ? strings.resume : strings.pause} title={paused ? strings.resume : strings.pause}>
          {paused ? <Play aria-hidden="true" className="w-4 h-4" /> : <Pause aria-hidden="true" className="w-4 h-4" />}
        </button>
        <button type="button" onClick={onHide} aria-label={strings.hide} title={strings.hide}>
          <EyeOff aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
