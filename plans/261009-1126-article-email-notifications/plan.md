# Article email notifications to subscribers

Status: in progress · Branch: `feat/article-email-notifications`

## Outcome
Publishing a new article emails every verified member 30 minutes later (so quick edits land in the email), with
deliverability safeguards that protect zuey.me's sender reputation as the list grows.

## Decisions (accepted by the user)
- Recipients: every member with a verified email (`users.email_verified_at`), not deleted, not opted out.
- Paid (`knowledges`) articles go to everyone; members without `read_full` get the public part + subscribe button (`/pricing`).
- Edition per recipient: `users.locale` when that edition is published, else the primary edition.
- Publish has a "don't email" switch (`notify: false`); backdated publishes default to no email.
- Scheduler runs on Cloudflare (Cron Trigger Worker), not GitHub Actions (public repo).

## Design
- `article_notifications` (one row per article): `scheduled → sending → sent`, or `skipped` / `cancelled`.
  Migration backfills `skipped` for every already-published article so republishing old posts never emails.
- Dispatch endpoint `POST /api/v1/articles/notifications/dispatch` (admin or `CRON_SECRET`) reads the latest published
  edition at send time, sends through Resend batch API with per-recipient `email_log` idempotency keys.
- Worker `workers/scheduler` (cron `*/5 * * * *`) calls the endpoint with `CRON_SECRET`.

## Deliverability
- RFC 8058 one-click `List-Unsubscribe` + `List-Unsubscribe-Post`; signed unsubscribe page (GET never mutates).
- Resend webhook (`/api/webhooks/resend`, Svix signature) suppresses hard bounces and complaints.
- Warm-up daily cap (50 → doubling per active day, ceiling `ARTICLE_EMAIL_DAILY_CAP`), most recently active members first.
- Quiet hours 23:00–07:00 Asia/Saigon; plain-text part; HTML kept under Gmail's 102 KB clip limit.
- DNS: DMARC record (`p=none` monitoring) — currently missing.

## Acceptance
- `bun test` and `bun run build` pass; OpenAPI lists new endpoints and `notify`.
- Prod: migration applied (Time Travel bookmark first), Pages + Worker deployed, secrets set, dispatch endpoint returns 200
  with the cron secret and 401 without, unsubscribe page renders.
