-- Last good copies of the two 200lab catalog feeds (https://200lab.io/courses.json and
-- https://200lab.io/learning-paths.json), one row per feed so an outage of one never touches the other.
-- `items_json` holds validated items; `checked_at` is the last fetch attempt and throttles refreshes
-- (an atomic conditional update lets one request refresh a feed); `synced_at` is the last valid fetch.
-- A failed, invalid or empty fetch never replaces `items_json`. The old `lab200_snapshot` table is kept.
CREATE TABLE IF NOT EXISTS lab200_catalog (
  kind TEXT PRIMARY KEY CHECK (kind IN ('courses', 'learning_paths')),
  items_json TEXT NOT NULL,
  locale TEXT,
  content_hash TEXT NOT NULL,
  synced_at TEXT,
  checked_at TEXT NOT NULL
);

-- Seed the courses row from the old courses.md snapshot so the app keeps its last good list until the
-- first JSON fetch succeeds. Old rows carry no price amounts: free courses keep a 0 VND price, paid ones
-- get no price (shown as "see the price on 200lab"). Rows are validated again when read.
INSERT OR IGNORE INTO lab200_catalog (kind, items_json, locale, content_hash, synced_at, checked_at)
SELECT
  'courses',
  COALESCE((
    SELECT json_group_array(json_object(
      'slug', json_extract(j.value, '$.slug'),
      'url', 'https://200lab.io/courses/' || json_extract(j.value, '$.slug'),
      'jsonUrl', 'https://200lab.io/courses/' || json_extract(j.value, '$.slug') || '.json',
      'title', json_extract(j.value, '$.title'),
      'subtitle', '',
      'summary', COALESCE(json_extract(j.value, '$.summary'), ''),
      'cover', CASE WHEN json_extract(j.value, '$.image') IS NOT NULL
        THEN json_object('url', json_extract(j.value, '$.image'), 'variants', json_array()) END,
      'category', NULL,
      'publishedAt', NULL,
      'lessonCount', json_extract(j.value, '$.lessons'),
      'readingMinutes', NULL,
      'pricing', json_object('state', 'available', 'prices', CASE WHEN json_extract(j.value, '$.free')
        THEN json_array(json_object('minorUnits', 0, 'currency', 'VND')) ELSE json_array() END)
    ))
    FROM json_each(s.courses_json) AS j
  ), '[]'),
  CASE WHEN s.courses_json <> '[]' THEN 'vi' END,
  'legacy',
  s.synced_at,
  '1970-01-01T00:00:00.000Z'
FROM lab200_snapshot AS s
WHERE s.id = 1 AND json_valid(s.courses_json);

INSERT OR IGNORE INTO lab200_catalog (kind, items_json, locale, content_hash, synced_at, checked_at)
VALUES
  ('courses', '[]', NULL, '', NULL, '1970-01-01T00:00:00.000Z'),
  ('learning_paths', '[]', NULL, '', NULL, '1970-01-01T00:00:00.000Z');
