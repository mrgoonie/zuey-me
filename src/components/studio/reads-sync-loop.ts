import type { ReadsSyncRun } from '../../lib/reads/store';

export interface Envelope {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads the `{ success, data, error }` envelope; a non-JSON or non-2xx response is never a success. */
export async function readEnvelope(res: Response): Promise<Envelope> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { success: false, error: { message: `HTTP ${res.status}` } };
  }
  if (!isRecord(body)) return { success: false, error: { message: `HTTP ${res.status}` } };
  const err = isRecord(body.error) ? body.error : undefined;
  return {
    success: body.success === true && res.ok,
    data: body.data,
    error: err
      ? { code: typeof err.code === 'string' ? err.code : undefined, message: typeof err.message === 'string' ? err.message : undefined }
      : undefined,
  };
}

type SyncBatchResponse = ReadsSyncRun & { next_offset: number | null };

function isSyncBatch(v: unknown): v is SyncBatchResponse {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.status === 'string' &&
    typeof v.started_at === 'string' &&
    typeof v.fetched === 'number' &&
    typeof v.hidden === 'number' &&
    typeof v.tagged === 'number' &&
    typeof v.summarized === 'number' &&
    typeof v.unchanged === 'number' &&
    (v.next_offset === null || typeof v.next_offset === 'number')
  );
}

export interface ReadsSyncProgress {
  /** 1-based batch number that just finished. */
  batch: number;
  /** Tagged items processed so far. */
  done: number;
  /** Tagged items in this pass. */
  total: number;
}

/** The whole manual sync, shaped like one run: the final batch's run plus totals across every batch. */
export type ReadsSyncLoopResult = ReadsSyncRun & { batches: number };

export interface ReadsSyncLoopOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Tagged items per request; keeps each request under Cloudflare's ~100 s origin timeout. */
  limit?: number;
  onProgress?: (p: ReadsSyncProgress) => void;
  /** Safety stop against a server that never reports the end; defaults to the batches the reported total needs plus a margin. */
  maxBatches?: number;
}

/** Same as the server's DEFAULT_SYNC_BATCH_LIMIT (not imported to keep server code out of the Studio bundle). */
const DEFAULT_LIMIT = 3;
/** Extra batches allowed beyond `ceil(tagged / limit)`, for items tagged while a pass runs. */
const BATCH_CAP_MARGIN = 20;

/**
 * Studio's manual Reads sync: posts `{ offset, limit }` to `/api/v1/reads/sync` until `next_offset` is null.
 * Stops at the first failed batch; items of earlier batches stay synced and a new run is safe to start.
 */
export async function runReadsSyncBatches(opts: ReadsSyncLoopOptions = {}): Promise<ReadsSyncLoopResult> {
  const fetchImpl = opts.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const limit = opts.limit ?? DEFAULT_LIMIT;
  let maxBatches = opts.maxBatches ?? BATCH_CAP_MARGIN;
  let offset = 0;
  let summarized = 0;
  let unchanged = 0;
  let partial = false;
  const errors: string[] = [];

  for (let batch = 1; batch <= maxBatches; batch++) {
    const where = `Sync stopped at batch ${batch} (offset ${offset})`;
    const hint = offset > 0 ? ` Items before offset ${offset} were synced; press Sync now to run again.` : '';
    let env: Envelope;
    try {
      const res = await fetchImpl('/api/v1/reads/sync', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, limit }),
      });
      env = await readEnvelope(res);
    } catch (e) {
      throw new Error(`${where}: ${e instanceof Error ? e.message : 'network error'}.${hint}`);
    }
    if (!env.success || !isSyncBatch(env.data)) {
      const reason = env.error ? `${env.error.code ?? 'error'}: ${env.error.message ?? ''}` : 'unexpected response';
      throw new Error(`${where}: ${reason}.${hint}`);
    }
    const run = env.data;
    if (opts.maxBatches === undefined) maxBatches = Math.ceil(run.tagged / limit) + BATCH_CAP_MARGIN;
    summarized += run.summarized;
    unchanged += run.unchanged;
    if (run.status !== 'success') partial = true;
    if (run.error) errors.push(run.error);
    opts.onProgress?.({ batch, done: run.next_offset ?? run.tagged, total: run.tagged });
    if (run.next_offset === null) {
      return {
        id: run.id,
        started_at: run.started_at,
        finished_at: run.finished_at,
        fetched: run.fetched,
        tagged: run.tagged,
        hidden: run.hidden,
        status: partial ? 'partial' : run.status,
        summarized,
        unchanged,
        error: errors.length ? errors.join('\n') : null,
        batches: batch,
      };
    }
    if (run.next_offset <= offset) throw new Error(`${where}: next_offset ${run.next_offset} did not advance.${hint}`);
    offset = run.next_offset;
  }
  throw new Error(`Sync stopped after ${maxBatches} batches without reaching the end; press Sync now to run again.`);
}

export interface SyncAndReloadOptions<T> {
  sync: () => Promise<T>;
  /** Reloads the list; it may clear the error state, so the sync error is set again afterwards. */
  reload: () => Promise<void>;
  setError: (message: string | null) => void;
}

/**
 * Runs the sync, always reloads the list (earlier batches are saved even when a later one fails), then
 * shows the sync error last so the reload cannot wipe the "Sync stopped at batch N" message.
 * Returns the sync result, or null when it failed.
 */
export async function syncAndReload<T>(opts: SyncAndReloadOptions<T>): Promise<T | null> {
  opts.setError(null);
  let result: T | null = null;
  let failure: string | null = null;
  try {
    result = await opts.sync();
  } catch (e) {
    failure = e instanceof Error ? e.message : 'Sync failed';
  }
  await opts.reload();
  if (failure) opts.setError(failure);
  return result;
}