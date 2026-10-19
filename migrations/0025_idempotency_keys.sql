-- Replay-safe retries for state-changing article and media workflow requests. A client may send an opaque
-- Idempotency-Key; the first request records its outcome here and a retry returns that stored outcome
-- instead of writing again. Only the SHA-256 of the key is stored, scoped to the acting admin.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  -- SHA-256 of the canonical request, so reusing a key for a different request is refused.
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'done')),
  status_code INTEGER,
  response_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys (expires_at);
