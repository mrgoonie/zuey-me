/**
 * AI cleanup of raw YouTube captions with Workers AI.
 *
 * AnyMD often returns one long unpunctuated block per caption track, so the raw text is split into
 * chunks of roughly CHUNK_WORDS words, each chunk is rewritten into readable paragraphs (same
 * language, nothing summarized or added), and every paragraph gets a start time estimated from where
 * its words sit inside the chunk's time span. The output uses the stored transcript line format
 * ("m:ss text"), so the player, search and Zuey AI read it unchanged.
 */
import type { WorkersAiLike } from '../../env';
import { AppError } from '../http';
import { transcriptSegments } from './anymd-transcript-parser';

export const DEFAULT_REWRITE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const CHUNK_WORDS = 600;
/** Speaking rate used when the end of the last caption is unknown (no video duration). */
const WORDS_PER_SECOND = 2.5;
const CONCURRENCY = 4;
const CALL_TIMEOUT_MS = 90_000;
const MAX_TOKENS = 2048;
/** A cleaned chunk must keep most of the words; fewer means the model summarized. */
const MIN_WORD_RATIO = 0.55;
/** Far more words than the input means the model added content. */
const MAX_WORD_RATIO = 1.6;

const SYSTEM_PROMPT = [
  'You clean up raw auto-generated YouTube captions.',
  'Keep the original language and meaning. Do not summarize, translate, comment or add facts.',
  'Fix punctuation, capitalization and obviously mis-heard words, remove filler words (uh, um, you know, à, ờ, thì là) and false starts,',
  'and split the text into short readable paragraphs of 2-5 sentences.',
  'Output only the cleaned paragraphs separated by blank lines, with no headings, lists or notes.',
].join(' ');

interface TimedWord { word: string; time: number; segment: number }

export interface TranscriptChunk {
  /** Seconds where the chunk's first word is spoken. */
  start: number;
  /** Seconds where the next chunk starts (or the transcript ends). */
  end: number;
  text: string;
  words: number;
}

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** Gives every caption word a time, interpolated linearly across its caption segment. */
export function timedWords(transcript: string, durationSeconds: number | null | undefined): TimedWord[] {
  const segments = transcriptSegments(transcript);
  const out: TimedWord[] = [];
  segments.forEach((seg, i) => {
    const list = words(seg.text);
    if (list.length === 0) return;
    const next = segments[i + 1]?.start;
    const estimatedEnd = seg.start + list.length / WORDS_PER_SECOND;
    const end = next !== undefined && next > seg.start ? next
      : durationSeconds && durationSeconds > seg.start ? durationSeconds : estimatedEnd;
    list.forEach((word, j) => out.push({ word, time: seg.start + ((end - seg.start) * j) / list.length, segment: i }));
  });
  return out;
}

/** Splits timed words into chunks, preferring to cut at a caption-segment boundary near the size limit. */
export function chunkTranscript(transcript: string, durationSeconds: number | null | undefined, size = CHUNK_WORDS): TranscriptChunk[] {
  const all = timedWords(transcript, durationSeconds);
  const last = all[all.length - 1];
  const lastTime = last ? last.time + 1 / WORDS_PER_SECOND : 0;
  const finalEnd = durationSeconds && durationSeconds > lastTime ? durationSeconds : lastTime;
  const cuts: number[] = [];
  let from = 0;
  while (all.length - from > size) {
    let cut = from + size;
    for (let i = from + size; i > from + Math.floor(size * 0.75); i--) {
      if (all[i].segment !== all[i - 1].segment) { cut = i; break; }
    }
    cuts.push(cut);
    from = cut;
  }
  const bounds = [0, ...cuts, all.length];
  const chunks: TranscriptChunk[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const slice = all.slice(bounds[k], bounds[k + 1]);
    if (slice.length === 0) continue;
    const nextStart = all[bounds[k + 1]]?.time;
    chunks.push({ start: slice[0].time, end: nextStart ?? finalEnd, text: slice.map(w => w.word).join(' '), words: slice.length });
  }
  return chunks;
}

/** "m:ss" or "h:mm:ss", matching the labels AnyMD uses. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Turns one chunk's cleaned paragraphs into transcript lines with estimated start times. */
export function placeParagraphs(chunk: TranscriptChunk, paragraphs: string[]): string[] {
  const total = paragraphs.reduce((n, p) => n + words(p).length, 0) || 1;
  let before = 0;
  return paragraphs.map(p => {
    const time = chunk.start + ((chunk.end - chunk.start) * before) / total;
    before += words(p).length;
    return `${formatTimestamp(time)} ${p}`;
  });
}

/** Text from a Workers AI chat result: Llama-style `response` or OpenAI-style `choices`. */
function responseText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  if ('response' in result && typeof result.response === 'string') return result.response;
  if ('choices' in result && Array.isArray(result.choices)) {
    const first: unknown = result.choices[0];
    if (typeof first === 'object' && first !== null && 'message' in first) {
      const message: unknown = first.message;
      if (typeof message === 'object' && message !== null && 'content' in message && typeof message.content === 'string') return message.content;
    }
  }
  return null;
}

/** Splits model output into single-line paragraphs, dropping markdown headings or list markers it may add. */
export function parseParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map(p => p.replace(/^\s*(?:#+\s+|[-*]\s+)/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function rewriteChunk(ai: WorkersAiLike, model: string, chunk: TranscriptChunk): Promise<string[]> {
  let lastError = 'unknown error';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await withTimeout(ai.run(model, {
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: chunk.text }],
        max_tokens: MAX_TOKENS,
      }), CALL_TIMEOUT_MS);
      const text = responseText(result);
      if (!text) { lastError = 'unexpected response shape'; continue; }
      const paragraphs = parseParagraphs(text);
      const ratio = paragraphs.reduce((n, p) => n + words(p).length, 0) / chunk.words;
      if (ratio < MIN_WORD_RATIO || ratio > MAX_WORD_RATIO) { lastError = `output kept ${Math.round(ratio * 100)}% of the words`; continue; }
      return paragraphs;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'request failed';
    }
  }
  throw new AppError(502, 'rewrite_failed', `AI rewrite failed: ${lastError}`);
}

export interface RewriteOutcome { transcript: string; model: string }

/** Rewrites a stored raw transcript; throws AppError when any chunk cannot be cleaned (the caller keeps the raw text). */
export async function rewriteTranscript(
  ai: WorkersAiLike, source: string, opts: { durationSeconds?: number | null; model?: string } = {},
): Promise<RewriteOutcome> {
  const model = opts.model?.trim() || DEFAULT_REWRITE_MODEL;
  const chunks = chunkTranscript(source, opts.durationSeconds);
  if (chunks.length === 0) throw new AppError(409, 'transcript_empty', 'There is no transcript text to rewrite');
  const results: string[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      results[i] = placeParagraphs(chunks[i], await rewriteChunk(ai, model, chunks[i]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return { transcript: results.flat().join('\n'), model };
}
