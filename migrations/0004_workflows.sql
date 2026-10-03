-- Zuey's AI Workflows: draft content and the published snapshot are stored separately
-- so editing a draft never changes the public version until it is republished.
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  draft_json TEXT NOT NULL,
  published_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflows_public ON workflows (deleted_at, published_at);

CREATE TABLE IF NOT EXISTS workflow_audit (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_audit_workflow ON workflow_audit (workflow_id, created_at);
