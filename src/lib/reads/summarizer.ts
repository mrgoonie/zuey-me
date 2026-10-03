import { AppError } from '../http';
import type { WorkersAiLike } from '../../env';

export const DEFAULT_SUMMARY_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
export const MAX_SUMMARY_INPUT_CHARS = 12000;

export interface SummaryInput {
  title: string;
  url: string;
  language: string | null;
  markdown: string;
}

export interface Summarizer {
  summarize(input: SummaryInput): Promise<string>;
}

function isVietnamese(language: string | null): boolean {
  return !!language && language.toLowerCase().startsWith('vi');
}

export function buildSummaryMessages(input: SummaryInput): Array<{ role: 'system' | 'user'; content: string }> {
  const lang = isVietnamese(input.language) ? 'Vietnamese' : 'English';
  return [
    {
      role: 'system',
      content: `You summarize articles for a personal reading list. Write a neutral 2-3 sentence summary in ${lang}. Output only the summary text: no preamble, no headings, no quotes.`,
    },
    {
      role: 'user',
      content: `Title: ${input.title}\nURL: ${input.url}\n\n${input.markdown.slice(0, MAX_SUMMARY_INPUT_CHARS)}`,
    },
  ];
}

/** Workers AI implementation; throws instead of ever returning a fabricated summary. */
export class WorkersAiSummarizer implements Summarizer {
  constructor(private ai: WorkersAiLike, private model: string = DEFAULT_SUMMARY_MODEL) {}

  async summarize(input: SummaryInput): Promise<string> {
    let result: unknown;
    try {
      result = await this.ai.run(this.model, { messages: buildSummaryMessages(input), max_tokens: 320 });
    } catch (err) {
      throw new AppError(502, 'llm_error', `Workers AI call failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    if (typeof result !== 'object' || result === null || !('response' in result) || typeof result.response !== 'string') {
      throw new AppError(502, 'llm_bad_response', 'Workers AI returned an unexpected response shape');
    }
    const text = result.response.trim();
    if (!text) throw new AppError(502, 'llm_empty', 'Workers AI returned an empty summary');
    return text;
  }
}

export function createSummarizer(ai: WorkersAiLike | undefined, model?: string): Summarizer {
  if (!ai) {
    throw new AppError(503, 'llm_unconfigured', 'Workers AI binding (AI) is not configured; summaries cannot be generated');
  }
  return new WorkersAiSummarizer(ai, model?.trim() || DEFAULT_SUMMARY_MODEL);
}
