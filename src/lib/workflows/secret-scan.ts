import type { WorkflowContent } from './schema';

export type SecretKind =
  | 'openai_key'
  | 'github_token'
  | 'aws_access_key'
  | 'slack_token'
  | 'private_key'
  | 'bearer_token'
  | 'home_path'
  | 'email';

export interface SecretFinding {
  /** Field path inside the workflow, e.g. `steps[2].detail`. */
  field: string;
  kind: SecretKind;
  /** Masked excerpt; never contains the full secret. */
  excerpt: string;
}

/**
 * Secret / PII patterns. KEEP IN SYNC with
 * skills/zuey-me/workflows/scripts/extract-workflows.mjs (SECRET_PATTERNS).
 */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: SecretKind; source: string; flags: string }> = [
  { kind: 'private_key', source: '-----BEGIN [A-Z ]*PRIVATE KEY-----', flags: 'g' },
  { kind: 'openai_key', source: '\\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}', flags: 'g' },
  { kind: 'github_token', source: '\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', flags: 'g' },
  { kind: 'aws_access_key', source: '\\bAKIA[0-9A-Z]{16}\\b', flags: 'g' },
  { kind: 'slack_token', source: '\\bxox[abprs]-[A-Za-z0-9-]{10,}', flags: 'g' },
  { kind: 'bearer_token', source: '\\bBearer\\s+[A-Za-z0-9._~+/=-]{20,}', flags: 'gi' },
  { kind: 'home_path', source: '(?:/Users/[^/\\s]+/|/home/[^/\\s]+/|[A-Za-z]:\\\\Users\\\\[^\\\\\\s]+\\\\)', flags: 'gi' },
  { kind: 'email', source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', flags: 'g' },
];

/** Keeps at most 4 leading characters and hides the rest. */
export function maskSecret(value: string): string {
  const keep = Math.min(4, Math.floor(value.length / 4));
  return `${value.slice(0, keep)}${'*'.repeat(6)} (${value.length} chars)`;
}

/** Scans a single string; `field` is reported as-is. */
export function scanText(field: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const p of SECRET_PATTERNS) {
    for (const m of text.matchAll(new RegExp(p.source, p.flags))) {
      findings.push({ field, kind: p.kind, excerpt: maskSecret(m[0]) });
    }
  }
  return findings;
}

/** Scans every text field of a workflow. */
export function scanWorkflow(content: WorkflowContent): SecretFinding[] {
  const fields: Array<[string, string]> = [
    ['name', content.name],
    ['slug', content.slug],
    ['summary', content.summary],
    ['trigger', content.trigger],
  ];
  content.tools.forEach((t, i) => fields.push([`tools[${i}]`, t]));
  content.tags.forEach((t, i) => fields.push([`tags[${i}]`, t]));
  content.steps.forEach((s, i) => {
    fields.push([`steps[${i}].title`, s.title]);
    if (s.detail) fields.push([`steps[${i}].detail`, s.detail]);
  });
  content.metrics.forEach((m, i) => {
    fields.push([`metrics[${i}].label`, m.label]);
    fields.push([`metrics[${i}].value`, m.value]);
  });
  return fields.flatMap(([field, text]) => scanText(field, text));
}
