/**
 * Spaces out automatic starts of sandboxed interactive frames: a long article whose widgets all reach the
 * viewport at once (a jump to the end, an opened toggle) starts them one by one instead of building every
 * frame in the same event-loop turn. Starts never run synchronously from the caller.
 */

/** Minimum gap between two automatic frame starts. */
export const FRAME_START_GAP_MS = 150;

const queue: Array<() => void> = [];
let timer: ReturnType<typeof setTimeout> | null = null;

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

/** Starts still waiting for their turn (tests and diagnostics). */
export function pendingFrameStarts(): number {
  return queue.length;
}
