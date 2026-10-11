-- Resume points for scheduled jobs that page through a table over several runs (stable order by id).
-- A row exists only while a pass is unfinished; the job deletes it when it reaches the end, so the
-- next run starts a new pass from the beginning.
CREATE TABLE IF NOT EXISTS job_cursors (
  job TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
