-- Last good copy of the 200lab course list (https://200lab.io/courses.md), shown by the 200lab app.
-- One row (id = 1). `checked_at` is the last fetch attempt and throttles refreshes; `synced_at` is the
-- last successful parse. A failed or empty fetch never replaces `courses_json`.
CREATE TABLE IF NOT EXISTS lab200_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  courses_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  synced_at TEXT,
  checked_at TEXT NOT NULL
);

INSERT OR IGNORE INTO lab200_snapshot (id, courses_json, content_hash, synced_at, checked_at)
VALUES (1, '[]', '', NULL, '1970-01-01T00:00:00.000Z');
