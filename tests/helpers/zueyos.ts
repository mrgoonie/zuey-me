import type { Profile } from '../../src/db/types';

/**
 * Shared happy-dom helpers for the Zuey OS DOM tests. They install nothing by themselves: each test file
 * registers happy-dom, then calls `trackHashChanges()` once.
 */

export const profile: Profile = { id: 'p', name: 'Duy', handle: 'duy', email: 'duy@example.com', avatar_url: '/avatar.png', intro_en: 'Hi', intro_vi: 'Chào', theme: 'default' };

/** How long a condition may take to hold. Tests get room for a few such waits, so load slows them instead of failing them. */
export const WAIT_MS = 10_000;

/** Minimal Web Animation: finishes on the next task, like a very short real one. */
export class FakeAnimation extends EventTarget {
  onfinish: (() => void) | null = null;
  finished = Promise.resolve();
  constructor() {
    super();
    setTimeout(() => this.onfinish?.(), 0);
  }
  cancel(): void {}
}

/** One React flush that also lets already-queued tasks (zero-delay timers, frames, fetch replies) run. */
export async function flush(): Promise<void> {
  const { act } = await import('react');
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

/**
 * happy-dom delivers `hashchange` as a later task for every hash change (`history.replaceState`
 * included), and Zuey OS opens the named window when it lands. Until then the change is unfinished
 * work: a late one would reopen a window the test just closed.
 */
let deliveredHash = '';
const hashSettled = () => deliveredHash === window.location.hash;

/** Records delivered hash changes on the current happy-dom window; call once after registering it. */
export function trackHashChanges(): void {
  deliveredHash = window.location.hash;
  window.addEventListener('hashchange', e => { deliveredHash = new URL(e.newURL).hash; });
}

/**
 * Flushes until `ready()` holds and no hashchange is queued, instead of sleeping a fixed time, so a
 * loaded machine waits longer rather than failing. Throws with `condition` when it still does not hold
 * after `timeoutMs`, so a stuck step names itself instead of ending in the test's own timeout.
 */
export async function waitFor(condition: string, ready: () => boolean, timeoutMs = WAIT_MS): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(hashSettled() && ready())) {
    if (Date.now() >= until) {
      const pending = hashSettled() ? '' : ` (hashchange to "${window.location.hash}" not delivered yet)`;
      throw new Error(`waitFor timed out after ${timeoutMs} ms: ${condition}${pending}`);
    }
    await flush();
  }
}
