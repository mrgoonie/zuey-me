/**
 * Escape closes the Zuey OS window that holds keyboard focus, unless something inside the window
 * is using Escape itself: a text field (clear / cancel editing), an IME composition, or an open
 * popup (menu, listbox, nested dialog) that Escape should dismiss first.
 */

/** Input types that take typed text; Escape there belongs to the field, not the window. */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * Popups inside a window that consume Escape before the window does. Plain disclosures
 * (`aria-expanded` without `aria-haspopup`, e.g. a filters panel) stay open and do not block.
 */
const OPEN_POPUP = '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"], [role="combobox"][aria-expanded="true"], [aria-modal="true"], dialog[open]';

export function isTextEntry(el: Element): boolean {
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const role = el.getAttribute('role');
  return role !== null && TEXT_ROLES.has(role);
}

interface EscapeLike {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  target: EventTarget | null;
}

/** True when this keydown should close `win` (the window element containing the event target). */
export function shouldCloseOnEscape(e: EscapeLike, win: Element): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return false;
  const target = e.target;
  if (!(target instanceof Element) || !win.contains(target)) return false;
  if (isTextEntry(target)) return false;
  return win.querySelector(OPEN_POPUP) === null;
}
