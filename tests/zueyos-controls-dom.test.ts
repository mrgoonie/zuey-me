import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import type { Profile } from '../src/db/types';

// Zuey OS controls in happy-dom: roles and accessible names (windows, dock, menu, phone home,
// appearance), menu keyboard support, Escape closing the focused window, transform/opacity-only
// window motion, the shared toast and the shared skeleton. Installs happy-dom as process globals:
// never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');

let React: ReactModule;
let client: ClientModule;
let os: typeof import('../src/components/os/ZueyOS');
let win: typeof import('../src/components/os/OsWindow');
let dock: typeof import('../src/components/os/Dock');
let menubar: typeof import('../src/components/os/MenuBar');
let mobile: typeof import('../src/components/os/MobileHome');
let appearance: typeof import('../src/components/os/AppearancePanel');
let apps: typeof import('../src/components/os/apps');
let store: typeof import('../src/components/os/window-store');
let i18n: typeof import('../src/components/os/os-i18n');
let homeI18n: typeof import('../src/components/home/home-i18n');
let look: typeof import('../src/components/os/look');
let toaster: typeof import('../src/components/feedback/Toaster');
let toastBus: typeof import('../src/components/feedback/toast-bus');
let skeleton: typeof import('../src/components/feedback/Skeleton');

const originalFetch = globalThis.fetch;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
/** Keyframes passed to Element.animate, to check which properties window motion touches. */
const recorded: Keyframe[][] = [];

const profile: Profile = { id: 'p', name: 'Duy', handle: 'duy', email: 'duy@example.com', avatar_url: '/avatar.png', intro_en: 'Hi', intro_vi: 'Chào', theme: 'default' };

/** Minimal Web Animation: finishes on the next task, like a very short real one. */
class FakeAnimation extends EventTarget {
  onfinish: (() => void) | null = null;
  finished = Promise.resolve();
  constructor() {
    super();
    setTimeout(() => this.onfinish?.(), 0);
  }
  cancel(): void {}
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await React.act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

function mount(el: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(el));
  mounted.push({ root, container });
  return container;
}

function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  React.act(() => { target.dispatchEvent(e); });
  return e;
}

/** The accessible name from aria-labelledby (space-separated ids) or aria-label. */
function nameOf(el: Element): string {
  const ids = el.getAttribute('aria-labelledby');
  if (ids) return ids.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://zuey.me/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(frames: Keyframe[]) {
      recorded.push(frames);
      return new FakeAnimation();
    },
  });
  React = await import('react');
  client = await import('react-dom/client');
  os = await import('../src/components/os/ZueyOS');
  win = await import('../src/components/os/OsWindow');
  dock = await import('../src/components/os/Dock');
  menubar = await import('../src/components/os/MenuBar');
  mobile = await import('../src/components/os/MobileHome');
  appearance = await import('../src/components/os/AppearancePanel');
  apps = await import('../src/components/os/apps');
  store = await import('../src/components/os/window-store');
  i18n = await import('../src/components/os/os-i18n');
  homeI18n = await import('../src/components/home/home-i18n');
  look = await import('../src/components/os/look');
  toaster = await import('../src/components/feedback/Toaster');
  toastBus = await import('../src/components/feedback/toast-bus');
  skeleton = await import('../src/components/feedback/Skeleton');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.root.unmount());
    m.container.remove();
  }
  globalThis.fetch = originalFetch;
  recorded.length = 0;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Fetch that answers every API call with an honest 503, so panels settle into their empty state. */
function offlineFetch() {
  globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(JSON.stringify({ success: false, error: { code: 'unavailable', message: 'x' } }), { status: 503, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

function windowProps(overrides: Partial<Parameters<typeof win.OsWindow>[0]> = {}): Parameters<typeof win.OsWindow>[0] {
  const s = i18n.osStrings('en');
  const state = store.initialWins(['reads']).reads;
  return {
    app: apps.APPS.reads, title: s.apps.reads, state, rect: { x: 20, y: 20, w: 600, h: 400 }, focused: true, mobile: false, reduced: false,
    expo: null, strings: s.win, getArea: () => ({ w: 1440, h: 860, b: 790 }),
    onFocus: () => {}, onClose: () => {}, onMinimize: () => {}, onToggleMax: () => {}, onCommit: () => {}, onExpoPick: () => {},
    children: null,
    ...overrides,
  };
}

describe('Zuey OS window', () => {
  test('is a dialog named by its visible title, with labelled controls and a labelled title bar', () => {
    const root = mount(React.createElement(win.OsWindow, windowProps()));
    const dialog = root.querySelector('section.osw');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog && nameOf(dialog)).toBe('Zuey Reads');
    expect(dialog?.querySelector(`#${CSS.escape(dialog.getAttribute('aria-labelledby') ?? '')}`)?.tagName).toBe('H2');
    const bar = root.querySelector('.osw-bar');
    expect(bar?.getAttribute('role')).toBe('group');
    expect(bar?.getAttribute('tabindex')).toBe('0');
    expect(bar && nameOf(bar)).toBe('Zuey Reads');
    expect(document.getElementById(bar?.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Escape');
    const controls = Array.from(root.querySelectorAll('.osw-lights button')).map(b => b.getAttribute('aria-label'));
    expect(controls).toEqual(['Close', 'Minimize', 'Maximize']);
    expect(root.querySelector('.osw-back')?.textContent).toBe('Home');
    expect(root.querySelector('.osw-page')?.getAttribute('aria-label')).toBe('Open as page: Zuey Reads');
  });

  test('every app window, Activity Monitor included, is a dialog named by its title with labelled controls', () => {
    const s = i18n.osStrings('en');
    for (const id of Object.keys(apps.APPS) as Array<keyof typeof apps.APPS>) {
      const root = mount(React.createElement(win.OsWindow, windowProps({ app: apps.APPS[id], title: s.apps[id], state: store.initialWins([id])[id] })));
      const dialog = root.querySelector('section.osw');
      expect(dialog?.getAttribute('role')).toBe('dialog');
      expect(dialog && nameOf(dialog)).toBe(s.apps[id]);
      for (const b of Array.from(root.querySelectorAll('button, a'))) expect(nameOf(b).length).toBeGreaterThan(0);
    }
    expect(Object.keys(apps.APPS)).toContain('activity-monitor');
  });

  test('Escape closes the window when focus is inside it, but not while typing or with a popup open', () => {
    let closed = 0;
    const root = mount(React.createElement(win.OsWindow, windowProps({ onClose: () => { closed += 1; } })));
    const body = root.querySelector('.osw-body');
    if (!body) throw new Error('window body missing');
    const button = document.createElement('button');
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    body.append(button, input, textarea, checkbox);

    expect(key(button, { key: 'Escape' }).defaultPrevented).toBe(true);
    expect(closed).toBe(1);
    key(root.querySelector('.osw-bar') ?? button, { key: 'Escape' });
    expect(closed).toBe(2);
    key(checkbox, { key: 'Escape' });
    expect(closed).toBe(3);

    key(input, { key: 'Escape' });
    key(textarea, { key: 'Escape' });
    expect(closed).toBe(3);

    // Something inside already handled Escape.
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    React.act(() => { button.dispatchEvent(handled); });
    expect(closed).toBe(3);

    // An open popup menu takes Escape first; a plain disclosure (filters panel) does not.
    const menuButton = document.createElement('button');
    menuButton.setAttribute('aria-haspopup', 'true');
    menuButton.setAttribute('aria-expanded', 'true');
    body.append(menuButton);
    key(button, { key: 'Escape' });
    expect(closed).toBe(3);
    menuButton.setAttribute('aria-expanded', 'false');
    const disclosure = document.createElement('button');
    disclosure.setAttribute('aria-expanded', 'true');
    body.append(disclosure);
    key(button, { key: 'Escape' });
    expect(closed).toBe(4);

    // Escape outside the window is not the window's business.
    key(document.body, { key: 'Escape' });
    expect(closed).toBe(4);
  });

  test('open, minimize, restore and close animate only transform and opacity', async () => {
    const props = windowProps();
    const closedState = { ...props.state, open: false, min: false };
    const root = mount(React.createElement(win.OsWindow, { ...props, state: closedState }));
    const render = (state: typeof props.state) => React.act(() => mounted[0].root.render(React.createElement(win.OsWindow, { ...props, state })));
    render({ ...props.state, open: true, min: false });
    await settle(2);
    render({ ...props.state, open: true, min: true });
    await settle(2);
    render({ ...props.state, open: true, min: false });
    await settle(2);
    render({ ...props.state, open: false, min: false });
    await settle(2);
    render({ ...props.state, open: true, min: false, mode: 'max' });
    await settle(2);
    expect(recorded.length).toBeGreaterThanOrEqual(5);
    const props_ = new Set(recorded.flatMap(frames => frames.flatMap(f => Object.keys(f))));
    for (const p of props_) expect(['transform', 'opacity', 'offset']).toContain(p);
    expect(root.querySelector('section.osw')).not.toBeNull();
  });

  test('reduced motion opens and closes without animating', async () => {
    const props = windowProps({ reduced: true });
    mount(React.createElement(win.OsWindow, { ...props, state: { ...props.state, open: false } }));
    React.act(() => mounted[0].root.render(React.createElement(win.OsWindow, props)));
    React.act(() => mounted[0].root.render(React.createElement(win.OsWindow, { ...props, state: { ...props.state, open: false } })));
    await settle(2);
    expect(recorded).toEqual([]);
    expect(mounted[0].container.querySelector('section.osw')?.hasAttribute('hidden')).toBe(true);
  });
});

describe('Zuey OS dock, menu bar, phone home and appearance', () => {
  test('dock is a labelled navigation landmark of labelled buttons', () => {
    const s = i18n.osStrings('en');
    const wins = store.winReducer(store.initialWins(['about', 'ai']), { type: 'minimize', id: 'about' });
    const root = mount(React.createElement(dock.Dock, { wins, avatar: '/a.png', expoOn: false, reduced: false, strings: s, onLaunch: () => {}, onExpo: () => {} }));
    const nav = root.querySelector('nav.os-dock');
    expect(nav?.getAttribute('aria-label')).toBe(s.dock);
    const items = Array.from(root.querySelectorAll<HTMLElement>('.os-di'));
    expect(items.length).toBe(apps.DOCK_APPS.length + 3);
    for (const item of items) expect(nameOf(item).length).toBeGreaterThan(0);
    expect(root.querySelector('[data-dock-app="about"]')?.getAttribute('aria-label')).toBe(`${s.apps.about} (${s.expo.minimized})`);
    expect(root.querySelector('[data-dock-app="ai"]')?.getAttribute('aria-current')).toBe('true');
    expect(root.querySelector('[data-dock-app="reads"]')?.getAttribute('aria-keyshortcuts')).toBe('Alt+4');
    const expose = items.find(i => i.getAttribute('aria-keyshortcuts') === 'Alt+O');
    expect(expose?.getAttribute('aria-pressed')).toBe('false');
  });

  test('menu button opens a keyboard-operable menu of menuitems', async () => {
    offlineFetch();
    const s = i18n.osStrings('en');
    const ran: string[] = [];
    const menu = ['about', 'theme', 'privacy'].map(k => ({ key: k, label: k, run: () => { ran.push(k); } }));
    const root = mount(React.createElement(menubar.MenuBar, {
      locale: 'en', strings: s, homeStrings: homeI18n.homeStrings('en'), activeApp: 'ai', dark: true, mascotHidden: true, noticeWaiting: false,
      signedIn: false, shortcut: 'Ctrl K', menu, onWeather: () => {}, onPalette: () => {}, onToggleTheme: () => {}, onToggleMascot: () => {},
      onAccount: () => {}, beforeNavigate: async () => {},
    }));
    await settle(2);
    const btn = root.querySelector<HTMLButtonElement>('.os-mb-brand');
    if (!btn) throw new Error('menu button missing');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toContain(s.menu);

    btn.focus();
    key(btn, { key: 'ArrowDown' });
    const list = root.querySelector('[role="menu"]');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(list?.getAttribute('aria-label')).toBe(s.menu);
    expect(btn.getAttribute('aria-controls')).toBe(list?.id ?? null);
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.map(i => i.textContent)).toEqual(['about', 'theme', 'privacy']);
    for (const i of items) expect(i.getAttribute('tabindex')).toBe('-1');
    expect(items.every(i => i.parentElement?.getAttribute('role') === 'none')).toBe(true);
    expect(document.activeElement).toBe(items[0]);

    key(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    key(items[2], { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    key(items[0], { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    key(items[2], { key: 'Escape' });
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(btn);

    // ArrowUp opens on the last item; activating an item runs it and closes the menu.
    key(btn, { key: 'ArrowUp' });
    const reopened = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(document.activeElement).toBe(reopened[2]);
    React.act(() => reopened[1].click());
    expect(ran).toEqual(['theme']);
    expect(root.querySelector('[role="menu"]')).toBeNull();

    // Every menubar tool button has a name.
    for (const b of Array.from(root.querySelectorAll('header button'))) expect(nameOf(b).length).toBeGreaterThan(0);
  });

  test('phone home icons are named buttons and links; the activity widget shows the shared skeleton', async () => {
    offlineFetch();
    const s = i18n.osStrings('en');
    const root = mount(React.createElement(mobile.MobileHome, { locale: 'en', profile, strings: s, homeStrings: homeI18n.homeStrings('en'), onOpen: () => {} }));
    const icons = Array.from(root.querySelectorAll<HTMLElement>('.os-home-apps button, .os-home-apps a'));
    expect(icons.length).toBe(apps.DOCK_APPS.length + 3);
    for (const icon of icons) expect(icon.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // Inside the widget button the skeleton is decorative, so the button's name stays its own text.
    const widget = root.querySelector<HTMLElement>('.os-home-widget');
    const skel = widget?.querySelector('.zf-skel');
    expect(skel?.getAttribute('aria-hidden')).toBe('true');
    expect(skel?.getAttribute('role')).toBeNull();
    expect(widget?.textContent).not.toContain(homeI18n.homeStrings('en').activity.loading);
  });

  test('appearance controls are labelled radio groups of named radios', () => {
    const s = i18n.osStrings('en');
    const changes: unknown[] = [];
    const root = mount(React.createElement(appearance.AppearancePanel, {
      look: look.DEFAULT_LOOK, hasImage: false, strings: s.look, onChange: p => { changes.push(p); }, onImage: () => {}, onReset: () => {},
    }));
    const groups = Array.from(root.querySelectorAll('[role="radiogroup"]'));
    expect(groups.map(g => nameOf(g))).toEqual([s.look.mode, s.look.accent, s.look.wallpaper]);
    for (const g of groups) {
      const radios = Array.from(g.querySelectorAll('[role="radio"]'));
      expect(radios.length).toBeGreaterThan(1);
      expect(radios.filter(r => r.getAttribute('aria-checked') === 'true').length).toBe(1);
      for (const r of radios) expect(nameOf(r).length).toBeGreaterThan(0);
    }
    const light = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(r => r.textContent === s.look.modes.light);
    React.act(() => light?.click());
    expect(changes).toEqual([{ mode: 'light' }]);
  });
});

describe('Zuey OS feedback', () => {
  test('toast bus validates payloads', () => {
    expect(toastBus.parseToastDetail({ message: '  Saved ', tone: 'success' })).toEqual({ message: 'Saved', tone: 'success' });
    expect(toastBus.parseToastDetail({ message: 'x', tone: 'loud' })).toEqual({ message: 'x', tone: 'info' });
    expect(toastBus.parseToastDetail({ message: '   ' })).toBeNull();
    expect(toastBus.parseToastDetail({ message: 3 })).toBeNull();
    expect(toastBus.parseToastDetail('Saved')).toBeNull();
    expect(toastBus.parseToastDetail(null)).toBeNull();
  });

  test('one polite live region shows each toast, replaces the previous one and hides it', async () => {
    const root = mount(React.createElement(toaster.Toaster, { label: 'Notifications' }));
    const region = root.querySelector('.zf-toaster');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('');
    React.act(() => toastBus.showToast('Copied'));
    expect(region?.textContent).toBe('Copied');
    expect(region?.querySelector('.zf-toast')?.classList.contains('is-on')).toBe(true);
    React.act(() => toastBus.showToast('Copy failed', 'error'));
    expect(region?.querySelectorAll('.zf-toast').length).toBe(1);
    expect(region?.querySelector('.zf-toast--error')?.textContent).toBe('Copy failed');
    // Foreign or malformed events are ignored.
    React.act(() => { window.dispatchEvent(new CustomEvent(toastBus.TOAST_EVENT, { detail: { nope: true } })); });
    expect(region?.textContent).toBe('Copy failed');
    await React.act(async () => { await new Promise(r => setTimeout(r, toaster.TOAST_MS.error + 50)); });
    expect(region?.querySelector('.zf-toast')?.classList.contains('is-on')).toBe(false);
    expect(region?.querySelector('.zf-toast')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('skeleton is a status with a single label and one bar per row', () => {
    const root = mount(React.createElement(skeleton.Skeleton, { label: 'Loading…', rows: [112, 20] }));
    const el = root.querySelector('.zf-skel');
    expect(el?.getAttribute('role')).toBe('status');
    expect(el?.hasAttribute('aria-busy')).toBe(false);
    expect(el?.hasAttribute('aria-label')).toBe(false);
    expect(el?.textContent).toBe('Loading…');
    expect(Array.from(root.querySelectorAll<HTMLElement>('.zf-skel-bar')).map(b => b.style.height)).toEqual(['112px', '20px']);
  });
});

describe('Zuey OS desktop keyboard flow', () => {
  test('Escape in the About window closes the open share modal first, then the window', async () => {
    offlineFetch();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const root = mount(React.createElement(os.ZueyOS, { locale: 'en', profile, links: [], signedIn: false }));
    await settle();
    React.act(() => { window.location.hash = '#about'; });
    await settle();
    const about = () => root.querySelector<HTMLElement>('.osw[data-app="about"]');
    expect(about()?.hidden).toBe(false);

    const share = about()?.querySelector<HTMLButtonElement>('button[aria-label="Share profile"]');
    if (!share) throw new Error('No share button');
    share.focus();
    React.act(() => share.click());
    await settle(2);
    const modal = () => about()?.querySelector('[role="dialog"][aria-modal="true"]') ?? null;
    expect(modal()).not.toBeNull();

    key(share, { key: 'Escape' });
    await settle(2);
    expect(modal()).toBeNull();
    expect(about()?.hidden).toBe(false);

    key(share, { key: 'Escape' });
    await settle();
    expect(about()?.hidden).toBe(true);
  });

  test('Alt+4 opens Reads with focus inside it, and Escape closes it again', async () => {
    offlineFetch();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const root = mount(React.createElement(os.ZueyOS, { locale: 'en', profile, links: [], signedIn: false }));
    await settle();
    const reads = () => root.querySelector<HTMLElement>('.osw[data-app="reads"]');
    const readsDock = () => root.querySelector('[data-dock-app="reads"]');
    expect(apps.DOCK_APPS[3]).toBe('reads');
    expect(readsDock()?.classList.contains('is-run')).toBe(false);

    key(window, { key: '4', code: 'Digit4', altKey: true });
    await settle();
    expect(reads()?.hidden).toBe(false);
    expect(readsDock()?.classList.contains('is-run')).toBe(true);
    expect(reads()?.contains(document.activeElement)).toBe(true);

    key(document.activeElement ?? document.body, { key: 'Escape' });
    await settle();
    expect(readsDock()?.classList.contains('is-run')).toBe(false);
    expect(reads()?.hidden).toBe(true);
    // Focus moves on to the window now on top instead of being dropped on <body>.
    expect(document.activeElement?.closest('.osw')?.getAttribute('data-app')).toBe('ai');

    // Appearance changes and resets confirm through the shared toast.
    key(window, { key: 'o', code: 'KeyO', altKey: true });
    await settle(2);
    key(window, { key: 'Escape' });
    await settle(2);
    React.act(() => { window.location.hash = '#appearance'; });
    await settle();
    const region = root.querySelector('.zf-toaster');
    const reset = Array.from(root.querySelectorAll<HTMLButtonElement>('.osw[data-app="appearance"] button')).find(b => b.textContent === i18n.osStrings('en').look.reset);
    React.act(() => reset?.click());
    await settle(2);
    expect(region?.textContent).toBe(i18n.osStrings('en').look.resetDone);
  });
});
