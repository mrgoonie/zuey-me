import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import type { LinkItem, Profile } from '../src/db/types';

// Copy actions in the profile link cards, the profile share modal and the article share menu report
// through the one shared toast. Without a mounted Toaster (the standalone article page) they fall
// back to their own feedback, so a screen reader hears each confirmation exactly once.
// Installs happy-dom as process globals: never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');

let React: ReactModule;
let client: ClientModule;
let toaster: typeof import('../src/components/feedback/Toaster');
let toastBus: typeof import('../src/components/feedback/toast-bus');
let linkCard: typeof import('../src/components/LinkCard');
let shareModal: typeof import('../src/components/ShareModal');
let shareMenu: typeof import('../src/components/knowledge/ShareMenu');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
/** Text written to the stubbed clipboard; `clipboardFails` makes the next writes reject. */
const written: string[] = [];
let clipboardFails = false;

const item: LinkItem = { id: 'l1', section: 'blogs', title_en: 'Blog', title_vi: 'Blog', url: 'https://example.com/blog', order_index: 0, is_active: true };
const profile: Profile = { id: 'p', name: 'Duy', handle: 'duy', email: 'duy@example.com', avatar_url: '/avatar.png', intro_en: 'Hi', intro_vi: 'Chào', theme: 'default' };

function mount(el: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(el));
  mounted.push({ root, container });
  return container;
}

async function click(el: Element) {
  await React.act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
  });
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find(b => b.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

/** The shared toast's live region and its visible message (empty when nothing is shown). */
function toastText(): string {
  return document.querySelector('.zf-toaster .zf-toast.is-on')?.textContent?.trim() ?? '';
}

function mountToaster() {
  mount(React.createElement(toaster.Toaster, { label: 'Notifications' }));
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://zuey.me/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text: string) {
        if (clipboardFails) throw new Error('denied');
        written.push(text);
      },
    },
  });
  React = await import('react');
  client = await import('react-dom/client');
  toaster = await import('../src/components/feedback/Toaster');
  toastBus = await import('../src/components/feedback/toast-bus');
  linkCard = await import('../src/components/LinkCard');
  shareModal = await import('../src/components/ShareModal');
  shareMenu = await import('../src/components/knowledge/ShareMenu');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.root.unmount());
    m.container.remove();
  }
  written.length = 0;
  clipboardFails = false;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('showToast', () => {
  test('reports whether a mounted Toaster displayed the toast', () => {
    expect(toastBus.showToast('Nobody listening')).toBe(false);
    mountToaster();
    let shown = false;
    React.act(() => { shown = toastBus.showToast('Saved'); });
    expect(shown).toBe(true);
    expect(toastText()).toBe('Saved');
  });
});

describe('profile link card', () => {
  test('copy link shows the shared toast, closes the menu and keeps focus on its trigger', async () => {
    mountToaster();
    const card = mount(React.createElement(linkCard.LinkCard, { item, lang: 'en' }));
    const trigger = card.querySelector<HTMLButtonElement>('button[aria-label="More options"]');
    if (!trigger) throw new Error('No menu trigger');
    await click(trigger);
    await click(buttonByText(card, 'Copy link'));
    expect(written).toEqual([item.url]);
    expect(toastText()).toBe('Link copied');
    expect(card.textContent).not.toContain('Copy link');
    expect(document.activeElement).toBe(trigger);
  });

  test('a failed copy shows an error toast instead of failing silently', async () => {
    mountToaster();
    clipboardFails = true;
    const card = mount(React.createElement(linkCard.LinkCard, { item, lang: 'en' }));
    await click(card.querySelector('button[aria-label="More options"]') ?? card);
    await click(buttonByText(card, 'Copy link'));
    expect(toastText()).toBe('Could not copy link');
    expect(document.querySelector('.zf-toast--error')).not.toBeNull();
  });
});

describe('profile share modal', () => {
  const props = { isOpen: true, onClose: () => {}, profile, lang: 'en' as const, onOpenQr: () => {} };

  test('copy shows the shared toast and not a second inline banner', async () => {
    mountToaster();
    const modal = mount(React.createElement(shareModal.ShareModal, props));
    await click(buttonByText(modal, 'Copy Profile URL'));
    expect(written).toEqual(['https://zuey.me']);
    expect(toastText()).toBe('Profile link copied to clipboard!');
    expect(modal.textContent).not.toContain('Profile link copied to clipboard!');
    expect(modal.textContent).toContain('✓ Copied!');
  });

  test('without a Toaster the inline confirmation is kept', async () => {
    const modal = mount(React.createElement(shareModal.ShareModal, props));
    await click(buttonByText(modal, 'Copy Profile URL'));
    expect(modal.textContent).toContain('Profile link copied to clipboard!');
  });
});

describe('article share menu', () => {
  const props = { locale: 'en' as const, title: 'Post', publicUrl: 'https://zuey.me/articles/post', markdownUrl: 'https://zuey.me/articles/post.md', canCopyPrivate: false };
  const inlineStatus = (root: HTMLElement) => root.querySelector('[role="status"]')?.textContent ?? '';

  test('with a Toaster, copy link uses the shared toast and leaves its own live region silent', async () => {
    mountToaster();
    const menu = mount(React.createElement(shareMenu.ShareMenu, props));
    await click(menu.querySelector('button[aria-haspopup]') ?? menu);
    await click(buttonByText(menu, 'Copy link'));
    expect(written).toEqual([props.publicUrl]);
    expect(toastText()).toBe('Copied');
    expect(inlineStatus(menu)).toBe('');
    expect(menu.querySelector('.zab-toast')).toBeNull();
  });

  test('without a Toaster (standalone article page), its inline live region announces success and failure', async () => {
    const menu = mount(React.createElement(shareMenu.ShareMenu, props));
    await click(menu.querySelector('button[aria-haspopup]') ?? menu);
    await click(buttonByText(menu, 'Copy link'));
    expect(inlineStatus(menu)).toBe('Copied');
    clipboardFails = true;
    await click(buttonByText(menu, 'Copy link'));
    expect(inlineStatus(menu)).toBe('Could not copy');
  });
});
