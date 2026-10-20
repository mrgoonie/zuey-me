import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Popups (modals, menus) that are open right now, newest last. Only the newest one handles
 * Escape, so one press closes one popup even when several are stacked.
 */
const openPopups: symbol[] = [];

interface PopupFocusOptions {
  /** Focused when the popup opens (a dialog's close button), so keyboard users start inside it. */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Where focus goes back when the popup closes. Defaults to whatever was focused when it opened;
   * pass one when the popup was opened from another popup that is gone by now.
   */
  returnFocus?: HTMLElement | null;
}

/** Focus fell out of the page (the focused popup content unmounted), so it is safe to move it back. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/**
 * While `active`, Escape anywhere on the page calls `onClose` for the newest open popup. Listens on
 * the document, so it runs after a Zuey OS window's own Escape listener; the window leaves Escape
 * alone while it contains an open `aria-modal` dialog or `aria-haspopup` trigger, so the popup
 * closes first and the window stays open.
 *
 * Focus follows the popup: it moves to `initialFocus` on open and back to the opener (or
 * `returnFocus`) on close, so the next Escape still lands inside the window that owns it.
 * Returns a getter for that return target, for a popup that hands over to another one.
 */
export function useEscapeToClose(active: boolean, onClose: () => void, options: PopupFocusOptions = {}): () => HTMLElement | null {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const token = Symbol('popup');
    openPopups.push(token);
    const opener = document.activeElement;
    openerRef.current = opener instanceof HTMLElement && opener !== document.body ? opener : null;
    optionsRef.current.initialFocus?.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (openPopups[openPopups.length - 1] !== token) return;
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openPopups.splice(openPopups.indexOf(token), 1);
      const explicit = optionsRef.current.returnFocus;
      const target = explicit?.isConnected ? explicit : openerRef.current;
      if (target?.isConnected && focusIsLost()) target.focus({ preventScroll: true });
    };
  }, [active]);

  return useCallback(() => {
    const explicit = optionsRef.current.returnFocus;
    return explicit?.isConnected ? explicit : openerRef.current;
  }, []);
}
