/**
 * Parses AnyMD's YouTube Markdown (frontmatter + `## Transcript` with `**m:ss** · text` paragraphs)
 * into metadata and a compact stored transcript ("m:ss text" per line). Pure functions, no I/O.
 */
import type { TranscriptSegment } from './types';

export interface ParsedAnyMdVideo {
  title: string;
  author: string;
  description: string;
  thumbnail_url: string | null;
  /** Compact transcript, one "m:ss text" line per segment; null when the video has no captions. */
  transcript: string | null;
  word_count: number;
}

/** Reads `key: value` pairs from a leading YAML frontmatter block (scalar values only). */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        const parsed: unknown = JSON.parse(value);
        value = typeof parsed === 'string' ? parsed : value.slice(1, -1);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    out[kv[1]] = value;
  }
  return out;
}

const TIMESTAMP_RE = /^\*\*(\d{1,2}(?::\d{2}){1,2})\*\*\s*[·•\-–—:]?\s*(.*)$/;

/** Seconds for "m:ss" or "h:mm:ss"; NaN when malformed. */
export function timestampSeconds(label: string): number {
  const parts = label.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function transcriptSection(markdown: string): string | null {
  const idx = markdown.search(/^##\s+Transcript\s*$/m);
  if (idx < 0) return null;
  const rest = markdown.slice(idx).replace(/^##\s+Transcript\s*$/m, '');
  const next = rest.search(/^##\s+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/** Converts the transcript section into compact lines; null when AnyMD reported no captions. */
export function compactTranscript(markdown: string): string | null {
  const section = transcriptSection(markdown);
  if (!section || /transcript unavailable/i.test(section)) return null;
  const lines: string[] = [];
  for (const para of section.split(/\r?\n\s*\r?\n/)) {
    const text = para.replace(/\s+/g, ' ').trim();
    if (!text || text.startsWith('>')) continue;
    const m = text.match(TIMESTAMP_RE);
    if (m) {
      const body = m[2].trim();
      if (body) lines.push(`${m[1]} ${body}`);
    } else {
      lines.push(text);
    }
  }
  return lines.length ? lines.join('\n') : null;
}

const SEGMENT_RE = /^(\d{1,2}(?::\d{2}){1,2})\s+(.*)$/;

/** Splits a stored transcript back into timestamped segments (lines without a stamp continue the previous one). */
export function transcriptSegments(transcript: string | null | undefined): TranscriptSegment[] {
  if (!transcript) return [];
  const out: TranscriptSegment[] = [];
  for (const line of transcript.split('\n')) {
    const m = line.match(SEGMENT_RE);
    const start = m ? timestampSeconds(m[1]) : NaN;
    if (m && Number.isFinite(start)) out.push({ start, label: m[1], text: m[2] });
    else if (out.length) out[out.length - 1].text += ` ${line.trim()}`;
    else if (line.trim()) out.push({ start: 0, label: '0:00', text: line.trim() });
  }
  return out;
}

/** Transcript text without timestamps (search indexing, AI passages, word counts). */
export function transcriptPlainText(transcript: string | null | undefined): string {
  return transcriptSegments(transcript).map(s => s.text).join('\n');
}

export function parseAnyMdVideo(markdown: string): ParsedAnyMdVideo {
  const fm = parseFrontmatter(markdown);
  const heading = markdown.match(/^#\s+(.+)$/m);
  const transcript = compactTranscript(markdown);
  const fmWords = Number(fm.word_count);
  const plain = transcriptPlainText(transcript);
  const description = fm.description && fm.description !== fm.title ? fm.description : '';
  return {
    title: fm.title || (heading ? heading[1].trim() : ''),
    author: fm.author || '',
    description,
    thumbnail_url: fm.image || null,
    transcript,
    word_count: transcript ? (Number.isFinite(fmWords) && fmWords > 0 ? Math.floor(fmWords) : plain.split(/\s+/).filter(Boolean).length) : 0,
  };
}
