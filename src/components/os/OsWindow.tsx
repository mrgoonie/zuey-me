import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ExternalLink, Minus, Plus, X } from 'lucide-react';
import type { AppDef, Rect } from './apps';
import type { OsStrings } from './os-i18n';
import { GAP, modeRect, type Area, type WinMode, type WinState } from './window-store';

const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
const EASE_SPRING = 'cubic-bezier(.2,1.15,.3,1)';
const EASE_GENIE = 'cubic-bezier(.55,0,.75,.3)';
const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Dir = (typeof DIRS)[number];

export interface ExpoPlacement { transform: string; scale: number; selected: boolean; fromDock: boolean }

interface OsWindowProps {
  app: AppDef;
  title: string;
  state: WinState;
  /** Placed rect in screen-layer pixels; null before the first client measurement (CSS default applies). */
  rect: Rect | null;
  focused: boolean;
  mobile: boolean;
  reduced: boolean;
  expo: ExpoPlacement | null;
  strings: OsStrings['win'];
  getArea: () => Area;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMax: () => void;
  onCommit: (rect: Rect, mode: WinMode) => void;
  onExpoPick: () => void;
  children: React.ReactNode;
}

const rectOf = (el: HTMLElement): Rect => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Where a window grows from / shrinks to: the dock icon, else the bottom centre of the screen. */
function dockTarget(id: string): DOMRect | null {
  const el = document.querySelector<HTMLElement>(`[data-dock-app="${id}"]`);
  return el && el.offsetWidth ? el.getBoundingClientRect() : null;
}

/** Last pressed control (within 700 ms), so a window grows out of whatever opened it. */
let lastPress: { r: DOMRect; t: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', e => {
    const t = e.target instanceof Element ? e.target.closest('button, a, [role="option"]') : null;
    if (t) lastPress = { r: t.getBoundingClientRect(), t: performance.now() };
  }, true);
}

function genieFrames(el: HTMLElement, target: DOMRect | null): Keyframe[] {
  const r = el.getBoundingClientRect();
  const t = target ?? new DOMRect(window.innerWidth / 2, window.innerHeight, 0, 0);
  const dx = t.left + t.width / 2 - (r.left + r.width / 2);
  const dy = t.top + t.height / 2 - (r.top + r.height / 2);
  return [
    { transform: 'none', opacity: 1 },
    { transform: `translate(${Math.round(dx * 0.1)}px,${Math.round(dy * 0.32)}px) scale(.84,.6)`, opacity: 1, offset: 0.38 },
    { transform: `translate(${Math.round(dx)}px,${Math.round(dy)}px) scale(${Math.max(0.04, 44 / r.width).toFixed(3)},${Math.max(0.03, 44 / r.height).toFixed(3)})`, opacity: 0.1 },
  ];
}

/**
 * One desktop window: title bar with traffic lights, drag to move (edges snap), 8-way resize,
 * double-click to zoom, and animated open / minimize / close. Geometry is mutated on the DOM
 * during a gesture and committed to state on pointerup. Below 768px it becomes a full-height
 * sheet with a back button that can be pulled down to dismiss. The body stays mounted while
 * hidden so hosted islands keep their state.
 */
export const OsWindow: React.FC<OsWindowProps> = ({
  app, title, state, rect, focused, mobile, reduced, expo, strings, getArea,
  onFocus, onClose, onMinimize, onToggleMax, onCommit, onExpoPick, children,
}) => {
  const ref = useRef<HTMLElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const visible = state.open && (!state.min || expo !== null);
  const [shown, setShown] = useState(visible);
  const prev = useRef({ visible, min: state.min });
  const prevExpo = useRef(expo !== null);
  const [busy, setBusy] = useState<'drag' | 'resize' | null>(null);
  const lastMode = useRef(state.mode);
  const glideTimer = useRef(0);

  // Apply committed geometry (outside gestures); a mode change (zoom, snap) glides between rects.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !rect || mobile || busy) return;
    if (lastMode.current !== state.mode && !reduced) {
      el.classList.add('osw--glide');
      window.clearTimeout(glideTimer.current);
      glideTimer.current = window.setTimeout(() => el.classList.remove('osw--glide'), 360);
    }
    lastMode.current = state.mode;
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
  }, [rect, mobile, busy, state.mode, reduced]);
  useEffect(() => () => window.clearTimeout(glideTimer.current), []);

  // Open / restore / minimize / close animations. The element stays rendered until its exit finishes.
  useLayoutEffect(() => {
    const el = ref.current;
    const was = prev.current;
    const wasExpo = prevExpo.current;
    prev.current = { visible, min: state.min };
    prevExpo.current = expo !== null;
    if (!el || was.visible === visible) return;
    // A minimized window leaving Exposé already flew to the dock with the Exposé transition.
    if (!visible && wasExpo) { setShown(false); return; }
    if (visible) {
      setShown(true);
      if (reduced || expo) return;
      el.hidden = false;
      if (mobile) {
        el.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 420, easing: EASE_OUT });
      } else if (was.min) {
        el.style.transformOrigin = '50% 50%';
        el.animate(genieFrames(el, dockTarget(app.id)).reverse().map(k => ({ ...k, offset: k.offset == null ? null : 1 - Number(k.offset) })), { duration: 420, easing: EASE_OUT });
      } else {
        const o = lastPress && performance.now() - lastPress.t < 700 ? lastPress.r : dockTarget(app.id);
        const r = el.getBoundingClientRect();
        el.style.transformOrigin = o ? `${Math.round(o.left + o.width / 2 - r.left)}px ${Math.round(o.top + o.height / 2 - r.top)}px` : '50% 30%';
        el.animate(
          o
            ? [{ opacity: 0, transform: 'scale(.16)' }, { opacity: 1, offset: 0.4 }, { opacity: 1, transform: 'none' }]
            : [{ opacity: 0, transform: 'translateY(18px) scale(.94)' }, { opacity: 1, transform: 'none' }],
          { duration: o ? 440 : 320, easing: EASE_SPRING },
        );
      }
      return;
    }
    if (reduced) { setShown(false); return; }
    let frames: Keyframe[];
    let opts: KeyframeAnimationOptions;
    if (mobile) {
      frames = [{ transform: el.style.transform || 'none' }, { transform: 'translateY(100%)' }];
      opts = { duration: 300, easing: EASE_OUT };
    } else if (state.min) {
      el.style.transformOrigin = '50% 50%';
      frames = genieFrames(el, dockTarget(app.id));
      opts = { duration: 480, easing: EASE_GENIE };
    } else {
      el.style.transformOrigin = '50% 40%';
      frames = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94) translateY(6px)' }];
      opts = { duration: 170, easing: 'ease-in' };
    }
    el.style.pointerEvents = 'none';
    const anim = el.animate(frames, { ...opts, fill: 'forwards' });
    anim.onfinish = () => {
      el.style.pointerEvents = '';
      el.style.transform = '';
      anim.cancel();
      if (!prev.current.visible) setShown(false);
    };
  }, [visible, state.min, mobile, reduced, expo, app.id]);


  /* ---------- title bar drag ---------- */
  const drag = useRef<null | { mob: true; sy: number; dy: number } | { mob: false; sx: number; sy: number; r: Rect; moved: boolean; zone: Exclude<WinMode, 'normal'> | null; top: number; freeW: number; freeH: number }>(null);

  const showGhost = (zone: Exclude<WinMode, 'normal'> | null) => {
    const g = ghostRef.current;
    if (!g) return;
    if (!zone) { g.classList.remove('on'); return; }
    const r = modeRect(zone, getArea());
    Object.assign(g.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    g.classList.add('on');
  };

  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.button !== 0 || (e.target instanceof Element && e.target.closest('button, a'))) return;
    if (mobile) {
      drag.current = { mob: true, sy: e.clientY, dy: 0 };
    } else {
      const top = el.offsetParent instanceof HTMLElement ? el.offsetParent.getBoundingClientRect().top : 0;
      drag.current = { mob: false, sx: e.clientX, sy: e.clientY, r: rectOf(el), moved: false, zone: null, top, freeW: state.rect?.w ?? el.offsetWidth, freeH: state.rect?.h ?? el.offsetHeight };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    if (d.mob) {
      d.dy = Math.max(0, e.clientY - d.sy);
      el.style.transform = d.dy ? `translateY(${d.dy}px)` : '';
      return;
    }
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      setBusy('drag');
      if (state.mode !== 'normal') {
        // Tear-off: shrink back to the free size, keeping the grab point under the cursor.
        const fx = (d.sx - d.r.x) / d.r.w;
        d.r = { x: Math.round(d.sx - d.freeW * fx), y: d.r.y, w: d.freeW, h: d.freeH };
        el.style.width = `${d.r.w}px`;
        el.style.height = `${d.r.h}px`;
      }
    }
    const a = getArea();
    el.style.left = `${clamp(d.r.x + e.clientX - d.sx, 120 - d.r.w, a.w - 120)}px`;
    el.style.top = `${clamp(d.r.y + e.clientY - d.sy, 0, a.h - 44)}px`;
    const zone = e.clientX <= 6 ? 'left' : e.clientX >= window.innerWidth - 7 ? 'right' : e.clientY <= d.top + 2 ? 'max' : null;
    if (zone !== d.zone) { d.zone = zone; showGhost(zone); }
  };
  const onBarUp = () => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || !el) return;
    if (d.mob) {
      if (d.dy > 110) onClose();
      else {
        if (d.dy && !reduced) el.animate([{ transform: `translateY(${d.dy}px)` }, { transform: 'none' }], { duration: 260, easing: EASE_SPRING });
        el.style.transform = '';
      }
      return;
    }
    showGhost(null);
    setBusy(null);
    if (!d.moved) return;
    const r = rectOf(el);
    if (d.zone) onCommit({ ...r, w: d.r.w, h: d.r.h }, d.zone);
    else onCommit(r, 'normal');
  };
  const onBarKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.target !== e.currentTarget || mobile) return;
    const step = e.shiftKey ? 60 : 20;
    const k: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = k[e.key];
    if (v && !e.altKey) {
      e.preventDefault();
      onCommit({ x: el.offsetLeft + v[0] * step, y: el.offsetTop + v[1] * step, w: el.offsetWidth, h: el.offsetHeight }, 'normal');
    } else if (e.key === 'Escape') onClose();
  };

  /* ---------- 8-way resize ---------- */
  const rs = useRef<{ d: Dir; sx: number; sy: number; r: Rect; a: Area } | null>(null);
  const onRzDown = (d: Dir) => (e: React.PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el || e.button !== 0 || mobile) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    rs.current = { d, sx: e.clientX, sy: e.clientY, r: rectOf(el), a: getArea() };
    setBusy('resize');
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onRzMove = (e: React.PointerEvent<HTMLElement>) => {
    const s = rs.current;
    const el = ref.current;
    if (!s || !el) return;
    const { r, a, d } = s;
    const m = app.min;
    const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
    const n = { ...r };
    if (d.includes('e')) n.w = Math.round(clamp(r.w + dx, m.w, a.w - r.x - 2));
    if (d.includes('s')) n.h = Math.round(clamp(r.h + dy, m.h, a.b - r.y));
    if (d.includes('w')) { n.w = Math.round(clamp(r.w - dx, m.w, r.x + r.w)); n.x = r.x + r.w - n.w; }
    if (d.includes('n')) { n.h = Math.round(clamp(r.h - dy, m.h, r.y + r.h)); n.y = r.y + r.h - n.h; }
    Object.assign(el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` });
  };
  const onRzUp = () => {
    const el = ref.current;
    if (!rs.current || !el) return;
    rs.current = null;
    setBusy(null);
    onCommit(rectOf(el), 'normal');
  };
  const onRzDouble = (d: Dir) => () => {
    const el = ref.current;
    if (!el) return;
    const a = getArea();
    const r = rectOf(el);
    if (d === 'n' || d === 's') onCommit({ ...r, y: GAP, h: a.b - GAP }, 'normal');
    else if (d === 'e' || d === 'w') onCommit({ ...r, x: GAP, w: a.w - 2 * GAP }, 'normal');
  };

  const cls = [
    'osw',
    `osw--${app.surface}`,
    rect ? '' : `osw--boot osw--boot-${app.id}`,
    focused ? 'is-focus' : '',
    busy === 'drag' ? 'is-dragging' : '',
    busy === 'resize' ? 'is-resizing' : '',
    expo ? 'is-expo' : '',
    expo?.selected ? 'is-expo-sel' : '',
  ].filter(Boolean).join(' ');

  const expoStyle: React.CSSProperties | undefined = expo
    ? { transform: expo.transform, transformOrigin: '0 0', ['--xs' as string]: String(expo.scale) }
    : undefined;

  return (
    <>
      <div ref={ghostRef} className="os-snap-ghost" aria-hidden="true" />
      <section
        ref={ref}
        className={cls}
        data-app={app.id}
        data-mode={state.mode}
        role="dialog"
        aria-label={title}
        hidden={!shown}
        style={{ zIndex: 10 + state.z, ...expoStyle }}
        onPointerDownCapture={expo ? undefined : onFocus}
        onClickCapture={expo ? e => { e.preventDefault(); e.stopPropagation(); onExpoPick(); } : undefined}
      >
        <div
          className="osw-bar"
          tabIndex={0}
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarUp}
          onDoubleClick={e => { if (!(e.target instanceof Element && e.target.closest('button, a'))) onToggleMax(); }}
          onKeyDown={onBarKey}
        >
          <div className="osw-lights">
            <button type="button" className="cl" aria-label={strings.close} title={`${strings.close} (Alt W)`} aria-keyshortcuts="Alt+W" onClick={onClose}><X aria-hidden /></button>
            <button type="button" className="mn" aria-label={strings.minimize} title={`${strings.minimize} (Alt M)`} aria-keyshortcuts="Alt+M" onClick={onMinimize}><Minus aria-hidden /></button>
            <button type="button" className="mx" aria-label={state.mode === 'max' ? strings.restore : strings.maximize} title={`${state.mode === 'max' ? strings.restore : strings.maximize} (Alt ↑)`} aria-keyshortcuts="Alt+ArrowUp" onClick={onToggleMax}><Plus aria-hidden /></button>
          </div>
          <button type="button" className="osw-back" onClick={onClose}><ChevronLeft aria-hidden /><span>{strings.back}</span></button>
          <h2 className="osw-title">{title}</h2>
          {!app.href.startsWith('/#') && (
            <a className="osw-page" href={app.href} title={strings.openPage} aria-label={`${strings.openPage}: ${title}`}><ExternalLink aria-hidden /></a>
          )}
          <span className="osw-grab" aria-hidden="true" />
        </div>
        <div className="osw-body">{children}</div>
        {DIRS.map(d => (
          <i
            key={d}
            className={`osw-rz ${d}`}
            aria-hidden="true"
            onPointerDown={onRzDown(d)}
            onPointerMove={onRzMove}
            onPointerUp={onRzUp}
            onPointerCancel={onRzUp}
            onDoubleClick={onRzDouble(d)}
          />
        ))}
      </section>
    </>
  );
};
