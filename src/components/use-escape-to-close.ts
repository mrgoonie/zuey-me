import { useEffect, useRef } from 'react';

/**
 * While `active`, Escape anywhere on the page calls `onClose` (a modal, popover or menu dismissing
 * itself). Listens on the document, so it runs after a Zuey OS window's own Escape listener; the
 * window leaves Escape alone while it contains an open `aria-modal` dialog or `aria-haspopup`
 * trigger, so the popup closes first and the window stays open.
 */
export function useEscapeToClose(active: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);
}
