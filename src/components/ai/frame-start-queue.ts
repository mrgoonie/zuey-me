/**
 * Bounds automatic starts of sandboxed interactive frames on one page:
 * - starts are spaced out, so a long article whose widgets all reach the viewport at once (a jump to the
 *   end, an opened toggle) starts them one by one instead of building every frame in the same event-loop
 *   turn; starts never run synchronously from the caller;
 * - at most `MAX_AUTO_RUNNING` auto-started frames run at once. A widget that reaches the viewport while
 *   that many run stays click-to-run (the reader can still start it); a slot frees when an auto-started
 *   frame stops, is halted or unmounts.
 */

/** Minimum gap between two automatic frame starts. */
export const FRAME_START_GAP_MS = 150;
/** Auto-started frames allowed to run at the same time on one page. */
export const MAX_AUTO_RUNNING = 6;

const queue: Array<() => void> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let autoRunning = 0;

function tick(): void {
  timer = null;
  const next = queue.shift();
  if (!next) return;
  next();
  // Cool down even after the last start, so a start requested right after it still waits its turn.
  timer = setTimeout(tick, FRAME_START_GAP_MS);
}

/** Queues `start`; the returned function cancels it if it has not run yet (unmount, manual start). */
export function scheduleFrameStart(start: () => void): () => void {
  const entry = () => start();
  queue.push(entry);
  if (timer === null) timer = setTimeout(tick, 0);
  return () => {
    const i = queue.indexOf(entry);
    if (i >= 0) queue.splice(i, 1);
  };
}

/** Takes one auto-run slot; false when `MAX_AUTO_RUNNING` auto-started frames already run. */
export function claimAutoRunSlot(): boolean {
  if (autoRunning >= MAX_AUTO_RUNNING) return false;
  autoRunning += 1;
  return true;
}

export function releaseAutoRunSlot(): void {
  autoRunning = Math.max(0, autoRunning - 1);
}

/** Starts still waiting for their turn (tests and diagnostics). */
export function pendingFrameStarts(): number {
  return queue.length;
}

/** Auto-started frames currently holding a slot (tests and diagnostics). */
export function autoRunningFrames(): number {
  return autoRunning;
}

/** Back to an idle queue with no slots taken (tests, where fake timers can be discarded). */
export function resetFrameStartQueue(): void {
  queue.length = 0;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  autoRunning = 0;
}
