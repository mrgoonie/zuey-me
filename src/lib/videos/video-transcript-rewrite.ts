/**
 * AI cleanup of raw YouTube captions (OpenRouter and/or Workers AI, see video-transcript-rewrite-providers.ts).
 *
 * AnyMD often returns one long unpunctuated block per caption track, so the raw text is split into
 * chunks of roughly CHUNK_WORDS words, each chunk is rewritten into readable paragraphs (same
 * language, nothing summarized or added), and every paragraph gets a start time estimated from where
 * its words sit inside the chunk's time span. The output uses the stored transcript line format
 * ("m:ss text"), so the player, search and Zuey AI read it unchanged.
 */
import { AppError } from '../http';
import { transcriptSegments } from './anymd-transcript-parser';
import { glossaryPromptLines, type GlossaryTerm } from './video-transcript-glossary';
import type { TranscriptRewriter } from './video-transcript-rewrite-providers';

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

// "Roughly as long as the input" keeps smaller models from condensing; verified on real captions.
const SYSTEM_PROMPT = [
  'You are a transcript editor. Clean up raw auto-generated YouTube captions into readable text.',
  'This is light copy-editing, NOT summarizing: keep every sentence and every idea in the original order, in the original language. Do not shorten, paraphrase, translate, comment or add facts.',
  'Only fix punctuation, capitalization and obviously mis-heard words, remove filler words (uh, um, you know, like, à, ờ, thì là) and repeated false starts.',
  'Split the text into short readable paragraphs of 2-5 sentences. Your output should be roughly as long as the input.',
  'Output only the cleaned paragraphs separated by blank lines, with no headings, lists or notes.',
].join(' ');

/** Adds the video title and the proper-noun list so mis-heard names come back spelled right. */
export function buildSystemPrompt(opts: { title?: string | null; glossary?: GlossaryTerm[] } = {}): string {
  const parts = [SYSTEM_PROMPT];
  const title = opts.title?.trim();
  if (title) parts.push(`The video is titled: "${title}".`);
  if (opts.glossary?.length) {
    parts.push([
      'These proper nouns may appear; spell them exactly as listed. Replace a word with a listed name only when it is one of the',
      'mis-hearings given in brackets or differs from the name only in spacing, case or one letter. Never map an unfamiliar name',
      'to a listed name just because it sounds a little alike: keep unknown names as they appear, and never add names that are not spoken.',
      'Keep every other name, model name, version and number exactly as it appears in the captions (for example "GPT 5.6" stays "GPT 5.6"), even if it looks wrong to you.',
      ...glossaryPromptLines(opts.glossary).map(l => `- ${l}`),
    ].join('\n'));
  }
  return parts.join('\n\n');
}

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

/**
 * Cleans one chunk, trying each provider in order (a single provider gets one retry).
 * Returns the paragraphs and the label of the provider that produced them.
 */
async function rewriteChunk(rewriters: TranscriptRewriter[], system: string, chunk: TranscriptChunk): Promise<{ paragraphs: string[]; label: string }> {
  const attempts = rewriters.length === 1 ? [rewriters[0], rewriters[0]] : rewriters;
  const errors: string[] = [];
  for (const rewriter of attempts) {
    try {
      const paragraphs = parseParagraphs(await withTimeout(rewriter.complete(system, chunk.text, MAX_TOKENS), CALL_TIMEOUT_MS));
      const ratio = paragraphs.reduce((n, p) => n + words(p).length, 0) / chunk.words;
      if (ratio >= MIN_WORD_RATIO && ratio <= MAX_WORD_RATIO) return { paragraphs, label: rewriter.label };
      errors.push(`${rewriter.label}: output kept ${Math.round(ratio * 100)}% of the words`);
    } catch (err) {
      errors.push(`${rewriter.label}: ${err instanceof Error ? err.message : 'request failed'}`);
    }
  }
  throw new AppError(502, 'rewrite_failed', `AI rewrite failed: ${errors[errors.length - 1] ?? 'no provider'}`);
}

export interface RewriteOutcome {
  transcript: string;
  /** Provider label(s) that produced the text, comma-separated when a fallback handled some chunks. */
  model: string;
}

/** Rewrites a stored raw transcript; throws AppError when any chunk cannot be cleaned (the caller keeps the raw text). */
export async function rewriteTranscript(
  rewriters: TranscriptRewriter[], source: string,
  opts: { durationSeconds?: number | null; title?: string | null; glossary?: GlossaryTerm[] } = {},
): Promise<RewriteOutcome> {
  if (rewriters.length === 0) throw new AppError(503, 'llm_unconfigured', 'No AI provider is configured for transcript rewrites');
  const chunks = chunkTranscript(source, opts.durationSeconds);
  if (chunks.length === 0) throw new AppError(409, 'transcript_empty', 'There is no transcript text to rewrite');
  const system = buildSystemPrompt(opts);
  const results: string[][] = new Array(chunks.length);
  const labels = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const out = await rewriteChunk(rewriters, system, chunks[i]);
      labels.add(out.label);
      results[i] = placeParagraphs(chunks[i], out.paragraphs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return { transcript: results.flat().join('\n'), model: [...labels].join(', ') };
}
