# Idempotency keys for article and media writes

Admin clients can make retries safe by sending an opaque key with a state-changing request. If the response is lost (timeout, dropped connection), repeating the **same request with the same key** returns the stored result and writes nothing: no second revision, publish, notification email or media object.

## Where to send the key

| Surface | How |
| --- | --- |
| REST | `Idempotency-Key: <key>` header (or `idempotency_key` in the JSON body) on `POST /api/v1/articles`, `PUT`/`DELETE /api/v1/articles/{slug}`, `POST …/publish`, `PUT …/tags`, `DELETE …/editions`, JSON `POST`/`DELETE /api/v1/admin/media` |
| MCP | `idempotency_key` argument on `article_create`, `article_update`, `article_publish`, `article_delete`, `article_edition_delete`, `article_tags_set`, `media_import`, `media_upload`, `media_delete` |

Keys are 8–128 characters of letters, digits and `. _ : -`. Generate a fresh random key per intended operation and reuse it only for retries of that operation. Multipart media uploads refuse a key (`400 idempotency_unsupported`; identical bytes are already stored once). `media_upload_url` takes no key: its one-time URL is a secret and is never stored.

## Behaviour

- **First request:** runs normally; a successful result is stored for 24 hours.
- **Retry, same request:** returns the stored body with `idempotent_replay: true` (REST also sets `Idempotent-Replayed: true`) and the original status code.
- **Same key, different request or operation:** `422 idempotency_key_reused`.
- **First request still running:** `409 idempotency_in_progress` with `retry_after_seconds`. A claim that never finished (crashed worker) can be taken over by one retry after 2 minutes; `expected_revision` and content-hash dedup still guard against double writes.
- **Failed request (any error):** the key is released, so fixing the cause and retrying with the same key runs again.
- **Authorization** is checked on every call, including replays. Keys and results are private to the acting admin.
- **Stored data:** only the SHA-256 of the key, a fingerprint of the request and the response body. A document echo above ~900 KB is dropped from the stored replay (`document_omitted: true`).

## Recovering a lost response

`idempotency_lookup` (MCP) or `GET /api/v1/admin/idempotency/{key}` returns `{operation, state: "done" | "in_progress", status_code, started_at, completed_at, expires_at, result}` for 24 hours, so a client can learn the outcome without repeating the write. `404 not_found` means unknown or expired.

## Rollout

Apply migration `0026_idempotency_keys.sql` before deploying code that sends keys; requests without a key behave exactly as before. Keys are purged opportunistically on the next keyed request after they expire.
