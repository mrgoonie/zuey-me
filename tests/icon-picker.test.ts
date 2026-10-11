import { describe, it, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { IconName } from '../src/lib/blocks/icons';

// The DOM must exist before react-dom/client loads, so the modules under test are imported dynamically.
GlobalRegistrator.register();
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { IconPicker, pickerMove, revealInList, PICKER_COLS } = await import('../src/components/studio/IconPicker');
const { ICON_NAMES } = await import('../src/lib/blocks/icons');

let root: Root | null = null;
let host: HTMLElement;
const scrollIntoView = mock(() => {});
const scrollTo = mock(() => {});

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  Element.prototype.scrollIntoView = scrollIntoView;
  window.scrollTo = scrollTo;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  scrollIntoView.mockClear();
  scrollTo.mockClear();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mount(value: string | undefined, onChange: (name: IconName | undefined) => void, noneLabel?: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  await act(async () => r.render(createElement(IconPicker, { label: 'Icon', value, onChange, noneLabel })));
}

const toggle = (): HTMLButtonElement => {
  const btn = Array.from(host.querySelectorAll('button')).find(b => b.hasAttribute('aria-expanded'));
  if (!btn) throw new Error('disclosure button missing');
  return btn;
};
const search = (): HTMLInputElement => {
  const input = host.querySelector('input[role="combobox"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('search input missing');
  return input;
};
const listbox = () => host.querySelector('[role="listbox"]');

async function key(target: HTMLElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

async function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('IconPicker disclosure', () => {
  it('mounts closed: chip and button only, no grid and no scrolling', async () => {
    await mount('rocket', () => {});
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(listbox()).toBeNull();
    expect(host.querySelectorAll('svg')).toHaveLength(1);
    expect(host.textContent).toContain('rocket');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('previews an alias typed in the JSON tab by its canonical icon and flags invalid names', async () => {
    await mount('idea', () => {});
    expect(host.querySelector('[data-icon-chip] svg')?.getAttribute('data-icon')).toBe('lightbulb');
    expect(host.textContent).toContain('lightbulb');
    await act(async () => root?.unmount());
    await mount('not-an-icon', () => {});
    expect(host.querySelector('[data-icon-chip] svg')).toBeNull();
    expect(host.textContent).toContain('không hợp lệ');
  });

  it('toggles the grid open and closed without scrolling the page or the list', async () => {
    await mount(undefined, () => {});
    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    const list = listbox();
    expect(list?.querySelectorAll('[role="option"]')).toHaveLength(ICON_NAMES.length);
    expect(document.activeElement).toBe(search());
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list instanceof HTMLElement ? list.scrollTop : -1).toBe(0);
    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(listbox()).toBeNull();
  });

  it('Escape clears the query first, then closes and returns focus to the button', async () => {
    await mount(undefined, () => {});
    await act(async () => toggle().click());
    await type(search(), 'arrow');
    expect(listbox()?.querySelectorAll('[role="option"]').length).toBeLessThan(ICON_NAMES.length);
    await key(search(), { key: 'Escape' });
    expect(search().value).toBe('');
    await key(search(), { key: 'Escape' });
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});

describe('IconPicker keyboard', () => {
  it('moves by row with arrows, picks with Enter and closes', async () => {
    const picked: (IconName | undefined)[] = [];
    await mount(undefined, name => picked.push(name));
    await act(async () => toggle().click());
    const down = await key(search(), { key: 'ArrowDown' });
    expect(down.defaultPrevented).toBe(true);
    expect(search().getAttribute('aria-activedescendant')).toContain(ICON_NAMES[PICKER_COLS]);
    await key(search(), { key: 'Enter' });
    expect(picked).toEqual([ICON_NAMES[PICKER_COLS]]);
    expect(listbox()).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('lets Alt/Meta+Arrow reach the block card (reorder shortcut)', async () => {
    await mount(undefined, () => {});
    await act(async () => toggle().click());
    const seen: string[] = [];
    host.addEventListener('keydown', e => { if (e.altKey || e.metaKey) seen.push(e.key); });
    const before = search().getAttribute('aria-activedescendant');
    const alt = await key(search(), { key: 'ArrowDown', altKey: true });
    const meta = await key(search(), { key: 'ArrowUp', metaKey: true });
    expect(alt.defaultPrevented).toBe(false);
    expect(meta.defaultPrevented).toBe(false);
    expect(seen).toEqual(['ArrowDown', 'ArrowUp']);
    expect(search().getAttribute('aria-activedescendant')).toBe(before);
  });

  it('leaves ArrowLeft/Right to the caret while a query is typed', async () => {
    await mount(undefined, () => {});
    await act(async () => toggle().click());
    const empty = await key(search(), { key: 'ArrowRight' });
    expect(empty.defaultPrevented).toBe(true);
    await type(search(), 'arrow');
    const typed = await key(search(), { key: 'ArrowLeft' });
    expect(typed.defaultPrevented).toBe(false);
  });
});

describe('IconPicker helpers', () => {
  const k = (key: string, mods: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) =>
    ({ key, altKey: false, metaKey: false, ctrlKey: false, ...mods });

  it('pickerMove clamps, respects modifiers and the caret', () => {
    expect(pickerMove(k('ArrowDown'), 0, 20, true)).toBe(PICKER_COLS);
    expect(pickerMove(k('ArrowDown'), 19, 20, true)).toBe(19);
    expect(pickerMove(k('ArrowUp'), 3, 20, true)).toBe(0);
    expect(pickerMove(k('End'), 0, 20, true)).toBe(19);
    expect(pickerMove(k('ArrowRight'), 0, 20, false)).toBeNull();
    expect(pickerMove(k('Home'), 5, 20, false)).toBeNull();
    expect(pickerMove(k('ArrowDown', { altKey: true }), 0, 20, true)).toBeNull();
    expect(pickerMove(k('ArrowDown', { ctrlKey: true }), 0, 20, true)).toBeNull();
    expect(pickerMove(k('ArrowDown'), 0, 0, true)).toBeNull();
    expect(pickerMove(k('a'), 0, 20, true)).toBeNull();
  });

  it('revealInList adjusts only the list scrollTop', () => {
    const list = document.createElement('ul');
    const option = document.createElement('li');
    Object.defineProperty(list, 'clientHeight', { value: 100 });
    Object.defineProperty(option, 'offsetHeight', { value: 32 });
    Object.defineProperty(option, 'offsetTop', { value: 200, configurable: true });
    revealInList(list, option);
    expect(list.scrollTop).toBe(132);
    Object.defineProperty(option, 'offsetTop', { value: 40 });
    revealInList(list, option);
    expect(list.scrollTop).toBe(40);
    revealInList(list, option);
    expect(list.scrollTop).toBe(40);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
