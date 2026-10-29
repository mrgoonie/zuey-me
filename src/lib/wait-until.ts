/** Cloudflare `ctx.waitUntil`, so work continues after the response is sent. */
export type WaitUntil = (promise: Promise<unknown>) => void;

/** Runs best-effort work after the response when the runtime allows it (waitUntil), otherwise inline. Never rejects. */
export async function deferBestEffort(work: Promise<unknown>, waitUntil?: WaitUntil): Promise<void> {
  const safe = work.catch(() => null);
  if (waitUntil) waitUntil(safe);
  else await safe;
}
