# Activity Monitor: realtime presence (epic #165)

Status: in progress · Owner: autonomous run (ak:atoz) · Contract: `src/lib/presence/contract.ts`, `src/lib/presence/ticket.ts`

## Architecture

```text
browser (canTrack granted) --POST /api/v1/presence/ticket--> Pages (HMAC ticket, member/owner decided server-side)
browser --wss://presence.zuey.me/v1/connect?ticket=--> Worker zuey-me-presence --> DO PresenceHub (single, WS hibernation)
Activity Monitor --GET /v1/snapshot + WS {t:'sub'}--> aggregated PresenceSnapshot only
Pages --service binding PRESENCE--> Worker /internal/* (owner status, diagnostics), header X-Presence-Internal = secret
```

- Dedupe key `k`: HMAC(secret, `m:<userId>`) for members, HMAC(secret, `b:<browser presence id>`) for guests
  (random id in localStorage `zuey_presence_id`, only created when consent is granted). Tabs share it.
- Counted only while consent granted (`c=true`). Watch-only tickets (`c=false`) never count.
- Heartbeat 25s while the tab is visible and not idle; TTL 75s; hidden tab sends `{t:'idle'}` and stops.
- Abuse: ticket endpoint rate-limited per IP; DO caps live connections per IP hash and per key; messages ≤256 B,
  ≥1 msg per 5s per socket otherwise dropped; Origin allowlist (zuey.me, localhost dev).
- Owner: member id ∈ `PRESENCE_OWNER_MEMBER_IDS` (comma list; never admin role). Owner connections are excluded from
  visitor counts and drive `owner.onSite`. Manual mode stored in DO storage.
- Owner allowlist today: `usr_ada2432bf1b247b79fe5` (duy@wearetopgroup.com). goon.nguyen@gmail.com has no member
  account yet; add its id to the secret when it exists.

## Phases (one sub-issue + one PR each)

1. MVP anonymous realtime: Worker + DO, ticket endpoint, site-wide client, snapshot API, Activity Monitor app, CI deploy.
2. Verified owner presence: modes auto/away/busy/offline/invisible + text; Pages owner endpoints; Studio panel; MCP
   `presence_status_get` / `presence_status_set` (owner only); spoofing tests.
3. History & diagnostics: 5-min buckets ×288 in DO storage (alarm), GET /v1/history, 24h chart; admin diagnostics
   endpoint + Studio panel; load test report; deployment/ops docs.

## Acceptance (from confirmed brief)

See the Done-means list in the epic comment. Each PR: `bun test`, `bun run build`, isolated review, CI green.
