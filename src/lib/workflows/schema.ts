import { AppError } from '../http';

export interface WorkflowStep {
  title: string;
  detail?: string;
}

export interface WorkflowMetric {
  label: string;
  value: string;
}

/** Editable workflow content (what is stored in draft_json / published_json). */
export interface WorkflowContent {
  name: string;
  slug: string;
  summary: string;
  tools: string[];
  trigger: string;
  steps: WorkflowStep[];
  metrics: WorkflowMetric[];
  tags: string[];
}

export type WorkflowStatus = 'draft' | 'published';

export const LIMITS = {
  name: 120,
  slug: 80,
  summary: 500,
  trigger: 500,
  toolsCount: 20,
  tool: 60,
  stepsMin: 1,
  stepsMax: 30,
  stepTitle: 160,
  stepDetail: 2000,
  metricsCount: 12,
  metricLabel: 60,
  metricValue: 120,
  tagsCount: 12,
  tag: 40,
} as const;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function invalid(field: string, message: string): AppError {
  return new AppError(400, 'invalid_workflow', `${field}: ${message}`, { field });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireText(v: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof v !== 'string') throw invalid(field, 'must be a string');
  const s = v.trim();
  if (!allowEmpty && s.length === 0) throw invalid(field, 'is required');
  if (s.length > max) throw invalid(field, `must be at most ${max} characters`);
  return s;
}

function stringList(v: unknown, field: string, maxCount: number, maxLen: number): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw invalid(field, 'must be an array of strings');
  if (v.length > maxCount) throw invalid(field, `must have at most ${maxCount} items`);
  return v.map((item, i) => requireText(item, `${field}[${i}]`, maxLen));
}

function parseSteps(v: unknown): WorkflowStep[] {
  if (!Array.isArray(v)) throw invalid('steps', 'must be an array');
  if (v.length < LIMITS.stepsMin || v.length > LIMITS.stepsMax) {
    throw invalid('steps', `must contain ${LIMITS.stepsMin}-${LIMITS.stepsMax} steps`);
  }
  return v.map((item, i) => {
    if (!isRecord(item)) throw invalid(`steps[${i}]`, 'must be an object');
    const step: WorkflowStep = { title: requireText(item.title, `steps[${i}].title`, LIMITS.stepTitle) };
    if (item.detail !== undefined && item.detail !== null) {
      const detail = requireText(item.detail, `steps[${i}].detail`, LIMITS.stepDetail, true);
      if (detail) step.detail = detail;
    }
    return step;
  });
}

function parseMetrics(v: unknown): WorkflowMetric[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw invalid('metrics', 'must be an array');
  if (v.length > LIMITS.metricsCount) throw invalid('metrics', `must have at most ${LIMITS.metricsCount} items`);
  return v.map((item, i) => {
    if (!isRecord(item)) throw invalid(`metrics[${i}]`, 'must be an object');
    return {
      label: requireText(item.label, `metrics[${i}].label`, LIMITS.metricLabel),
      value: requireText(item.value, `metrics[${i}].value`, LIMITS.metricValue),
    };
  });
}

export function parseSlug(v: unknown): string {
  const slug = requireText(v, 'slug', LIMITS.slug);
  if (!SLUG_PATTERN.test(slug)) throw invalid('slug', 'must be lowercase kebab-case (a-z, 0-9, -)');
  return slug;
}

/** Validates a complete workflow payload coming from REST/MCP/Studio. */
export function parseWorkflowContent(input: Record<string, unknown>): WorkflowContent {
  return {
    name: requireText(input.name, 'name', LIMITS.name),
    slug: parseSlug(input.slug),
    summary: requireText(input.summary, 'summary', LIMITS.summary),
    tools: stringList(input.tools, 'tools', LIMITS.toolsCount, LIMITS.tool),
    trigger: requireText(input.trigger, 'trigger', LIMITS.trigger),
    steps: parseSteps(input.steps),
    metrics: parseMetrics(input.metrics),
    tags: stringList(input.tags, 'tags', LIMITS.tagsCount, LIMITS.tag),
  };
}

const CONTENT_KEYS = ['name', 'summary', 'tools', 'trigger', 'steps', 'metrics', 'tags'] as const;

/** Applies a partial update onto the current draft, then re-validates the whole thing. Slug is immutable. */
export function mergeWorkflowContent(current: WorkflowContent, patch: Record<string, unknown>): WorkflowContent {
  if (patch.slug !== undefined && patch.slug !== current.slug) {
    throw invalid('slug', 'cannot be changed after creation');
  }
  const merged: Record<string, unknown> = { ...current };
  for (const key of CONTENT_KEYS) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  return parseWorkflowContent(merged);
}

/** Parses stored JSON back into content; returns null when the row is corrupt. */
export function decodeContent(json: string | null): WorkflowContent | null {
  if (!json) return null;
  try {
    const raw: unknown = JSON.parse(json);
    return isRecord(raw) ? parseWorkflowContent(raw) : null;
  } catch {
    return null;
  }
}

/** Reads `expected_revision` as a non-negative integer or throws 400. */
export function requireExpectedRevision(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new AppError(400, 'expected_revision_required', 'expected_revision (integer) is required');
  }
  return n;
}
