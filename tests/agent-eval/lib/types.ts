/** Shared shapes for the agent eval suite (fetch, mcp and browser lanes). */

export type Lane = 'fetch' | 'mcp' | 'browser';

/** One machine-checkable condition. Patterns are case-insensitive regex sources. */
export type Matcher =
  | { link: string }
  | { text: string }
  | { notText: string };

export interface Expectation {
  matchers: Matcher[];
  /** At least this many matchers must hold (default: all). */
  min?: number;
}

export interface TaskBase {
  id: string;
  lane: Lane;
  /** The natural-language prompt an agent would receive. */
  prompt: string;
}

export interface FetchTask extends TaskBase {
  lane: 'fetch';
  /** Entry points an agent would try first; defaults to DEFAULT_ENTRIES. */
  entries?: string[];
  /** Links whose URL or anchor text matches this regex are followed (agent intent). */
  follow: string;
  maxHops: number;
  /** Ground truth resolved at run time (e.g. latest article title); must appear in fetched text. */
  truth?: 'latest-article-title';
  expect: Expectation;
}

export interface McpTask extends TaskBase {
  lane: 'mcp';
  /** `tools/list` or a read-only tool name. */
  tool: string;
  args?: Record<string, unknown>;
  expect: Expectation;
}

export interface BrowserTask extends TaskBase {
  lane: 'browser';
  steps: string[];
  /** Observable results the browser agent must confirm. */
  expected: string[];
}

export interface TaskResult {
  id: string;
  lane: Lane;
  passed: boolean;
  reason: string;
}

export interface Link {
  /** Absolute URL (fragment kept). */
  href: string;
  text: string;
}

export interface Page {
  url: string;
  text: string;
  links: Link[];
}

export const DEFAULT_ENTRIES = ['/', '/llms.txt', '/index.md'];
