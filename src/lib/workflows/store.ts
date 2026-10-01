import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import {
  decodeContent,
  mergeWorkflowContent,
  parseSlug,
  parseWorkflowContent,
  requireExpectedRevision,
} from './schema';
import type { WorkflowContent, WorkflowStatus } from './schema';
import { scanWorkflow } from './secret-scan';
import type { SecretFinding } from './secret-scan';

export type WorkflowActor = 'session' | 'api_key';

interface WorkflowRow {
  id: string;
  slug: string;
  draft_json: string;
  published_json: string | null;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  deleted_at: string | null;
}

/** Public view: the published snapshot only. */
export interface PublicWorkflow extends WorkflowContent {
  status: 'published';
  published_at: string;
}

/** Admin view: draft content plus publication state and secret findings. */
export interface AdminWorkflow extends WorkflowContent {
  id: string;
  status: WorkflowStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  /** Snapshot currently visible to the public (null when never published). */
  published: WorkflowContent | null;
  /** True when the draft differs from the published snapshot. */
  has_unpublished_changes: boolean;
  findings: SecretFinding[];
}

// ---------- persistence (D1 with in-memory fallback for local dev/tests) ----------

const memoryRows = new Map<string, WorkflowRow>();
const memoryAudit: Array<Record<string, unknown>> = [];

const COLUMNS = 'id, slug, draft_json, published_json, status, revision, created_at, updated_at, published_at, deleted_at';

async function findRow(slug: string, d1?: D1DatabaseLike): Promise<WorkflowRow | null> {
  if (!d1) {
    for (const row of memoryRows.values()) if (row.slug === slug) return { ...row };
    return null;
  }
  return d1.prepare(`SELECT ${COLUMNS} FROM workflows WHERE slug = ?`).bind(slug).first<WorkflowRow>();
}

async function allRows(d1?: D1DatabaseLike): Promise<WorkflowRow[]> {
  if (!d1) return [...memoryRows.values()].map(r => ({ ...r }));
  const res = await d1.prepare(`SELECT ${COLUMNS} FROM workflows ORDER BY updated_at DESC`).all<WorkflowRow>();
  return res.results ?? [];
}

async function insertRow(row: WorkflowRow, d1?: D1DatabaseLike): Promise<void> {
  if (!d1) {
    memoryRows.set(row.id, { ...row });
    return;
  }
  await d1
    .prepare(`INSERT INTO workflows (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.slug, row.draft_json, row.published_json, row.status, row.revision, row.created_at, row.updated_at, row.published_at, row.deleted_at)
    .run();
}

/** Optimistic update: only succeeds when the stored revision still equals `expected`. */
async function updateRow(row: WorkflowRow, expected: number, d1?: D1DatabaseLike): Promise<boolean> {
  if (!d1) {
    const cur = memoryRows.get(row.id);
    if (!cur || cur.revision !== expected) return false;
    memoryRows.set(row.id, { ...row });
    return true;
  }
  const res = await d1
    .prepare(
      `UPDATE workflows SET draft_json = ?, published_json = ?, status = ?, revision = ?, updated_at = ?, published_at = ?, deleted_at = ?
       WHERE id = ? AND revision = ?`
    )
    .bind(row.draft_json, row.published_json, row.status, row.revision, row.updated_at, row.published_at, row.deleted_at, row.id, expected)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

async function audit(row: WorkflowRow, action: string, actor: WorkflowActor, detail: unknown, d1?: D1DatabaseLike): Promise<void> {
  const entry = {
    id: `wfa-${crypto.randomUUID()}`,
    workflow_id: row.id,
    action,
    revision: row.revision,
    actor,
    created_at: new Date().toISOString(),
    detail: detail === undefined ? null : JSON.stringify(detail),
  };
  if (!d1) {
    memoryAudit.push(entry);
    return;
  }
  await d1
    .prepare('INSERT INTO workflow_audit (id, workflow_id, action, revision, actor, created_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.workflow_id, entry.action, entry.revision, entry.actor, entry.created_at, entry.detail)
    .run();
}

// ---------- views ----------

function toPublic(row: WorkflowRow): PublicWorkflow | null {
  if (row.deleted_at || !row.published_at) return null;
  const content = decodeContent(row.published_json);
  return content ? { ...content, status: 'published', published_at: row.published_at } : null;
}

function toAdmin(row: WorkflowRow): AdminWorkflow | null {
  if (row.deleted_at) return null;
  const draft = decodeContent(row.draft_json);
  if (!draft) return null;
  const published = decodeContent(row.published_json);
  return {
    ...draft,
    id: row.id,
    status: row.status === 'published' ? 'published' : 'draft',
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    published,
    has_unpublished_changes: !published || JSON.stringify(published) !== JSON.stringify(draft),
    findings: scanWorkflow(draft),
  };
}

function notFound(slug: string): AppError {
  return new AppError(404, 'not_found', `Workflow "${slug}" not found`);
}

async function loadLive(slug: string, d1?: D1DatabaseLike): Promise<WorkflowRow> {
  const row = await findRow(parseSlug(slug), d1);
  if (!row || row.deleted_at) throw notFound(slug);
  return row;
}

function assertRevision(row: WorkflowRow, expected: number): void {
  if (row.revision !== expected) {
    throw new AppError(409, 'revision_conflict', `Workflow changed: current revision is ${row.revision}`, {
      current_revision: row.revision,
    });
  }
}

async function save(row: WorkflowRow, expected: number, d1?: D1DatabaseLike): Promise<void> {
  if (!(await updateRow(row, expected, d1))) {
    const current = await findRow(row.slug, d1);
    throw new AppError(409, 'revision_conflict', 'Workflow was modified concurrently', {
      current_revision: current?.revision ?? null,
    });
  }
}

// ---------- operations ----------

export async function listPublicWorkflows(d1?: D1DatabaseLike): Promise<PublicWorkflow[]> {
  const rows = await allRows(d1);
  return rows
    .map(toPublic)
    .filter((w): w is PublicWorkflow => w !== null)
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
}

export async function listAdminWorkflows(d1?: D1DatabaseLike): Promise<AdminWorkflow[]> {
  const rows = await allRows(d1);
  return rows.map(toAdmin).filter((w): w is AdminWorkflow => w !== null);
}

export async function getPublicWorkflow(slug: string, d1?: D1DatabaseLike): Promise<PublicWorkflow> {
  const row = await loadLive(slug, d1);
  const view = toPublic(row);
  if (!view) throw notFound(slug);
  return view;
}

export async function getAdminWorkflow(slug: string, d1?: D1DatabaseLike): Promise<AdminWorkflow> {
  const view = toAdmin(await loadLive(slug, d1));
  if (!view) throw notFound(slug);
  return view;
}

/**
 * Creates a draft (revision 1). `expected_revision` must be explicitly 0 so callers
 * acknowledge they are creating rather than overwriting.
 */
export async function createWorkflow(input: Record<string, unknown>, actor: WorkflowActor, d1?: D1DatabaseLike): Promise<AdminWorkflow> {
  if (requireExpectedRevision(input.expected_revision) !== 0) {
    throw new AppError(400, 'invalid_expected_revision', 'expected_revision must be 0 when creating a workflow');
  }
  const content = parseWorkflowContent(input);
  if (await findRow(content.slug, d1)) {
    throw new AppError(409, 'slug_taken', `Slug "${content.slug}" is already used (including deleted workflows)`);
  }
  const now = new Date().toISOString();
  const row: WorkflowRow = {
    id: `wf-${crypto.randomUUID()}`,
    slug: content.slug,
    draft_json: JSON.stringify(content),
    published_json: null,
    status: 'draft',
    revision: 1,
    created_at: now,
    updated_at: now,
    published_at: null,
    deleted_at: null,
  };
  await insertRow(row, d1);
  await audit(row, 'create', actor, undefined, d1);
  return getAdminWorkflow(row.slug, d1);
}

/** Updates the draft only; the published snapshot stays public until republished. */
export async function updateWorkflow(slug: string, input: Record<string, unknown>, actor: WorkflowActor, d1?: D1DatabaseLike): Promise<AdminWorkflow> {
  const expected = requireExpectedRevision(input.expected_revision);
  const row = await loadLive(slug, d1);
  assertRevision(row, expected);
  const current = decodeContent(row.draft_json);
  if (!current) throw new AppError(500, 'corrupt_workflow', 'Stored workflow draft is invalid');
  const next = mergeWorkflowContent(current, input);
  const updated: WorkflowRow = {
    ...row,
    draft_json: JSON.stringify(next),
    status: 'draft',
    revision: row.revision + 1,
    updated_at: new Date().toISOString(),
  };
  await save(updated, expected, d1);
  await audit(updated, 'update', actor, undefined, d1);
  return getAdminWorkflow(slug, d1);
}

export async function deleteWorkflow(slug: string, expectedRevision: unknown, actor: WorkflowActor, d1?: D1DatabaseLike): Promise<{ slug: string; deleted: true; revision: number }> {
  const expected = requireExpectedRevision(expectedRevision);
  const row = await loadLive(slug, d1);
  assertRevision(row, expected);
  const now = new Date().toISOString();
  const deleted: WorkflowRow = { ...row, revision: row.revision + 1, updated_at: now, deleted_at: now };
  await save(deleted, expected, d1);
  await audit(deleted, 'delete', actor, undefined, d1);
  return { slug: row.slug, deleted: true, revision: deleted.revision };
}

/** Publishes the current draft as the public snapshot. Requires confirm:true and a clean secret scan. */
export async function publishWorkflow(slug: string, input: Record<string, unknown>, actor: WorkflowActor, d1?: D1DatabaseLike): Promise<AdminWorkflow> {
  if (input.confirm !== true) {
    throw new AppError(400, 'confirmation_required', 'Publishing makes the workflow public; pass confirm: true');
  }
  const expected = requireExpectedRevision(input.expected_revision);
  const row = await loadLive(slug, d1);
  assertRevision(row, expected);
  const draft = decodeContent(row.draft_json);
  if (!draft) throw new AppError(500, 'corrupt_workflow', 'Stored workflow draft is invalid');
  const findings = scanWorkflow(draft);
  if (findings.length > 0) {
    await audit(row, 'publish_blocked', actor, { findings }, d1);
    throw new AppError(422, 'secret_detected', 'Draft contains secrets or personal data; remove them before publishing', { findings });
  }
  const now = new Date().toISOString();
  const published: WorkflowRow = {
    ...row,
    published_json: JSON.stringify(draft),
    status: 'published',
    revision: row.revision + 1,
    updated_at: now,
    published_at: now,
  };
  await save(published, expected, d1);
  await audit(published, 'publish', actor, undefined, d1);
  return getAdminWorkflow(slug, d1);
}
