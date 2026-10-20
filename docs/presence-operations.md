# Realtime presence: operations

How to deploy, watch, pay for and repair the realtime presence system (Activity Monitor, owner status, 24h history). Data and privacy rules live in [analytics-events.md#realtime-presence](analytics-events.md#realtime-presence); secret names and local setup are in [env-setup.vi.md §15](env-setup.vi.md#15-realtime-presence-số-người-đang-xem). The shared contract is [`src/lib/presence/contract.ts`](../src/lib/presence/contract.ts).

## Moving parts

| Part | Where | Role |
| --- | --- | --- |
| Pages app | `src/lib/presence/`, `src/pages/api/v1/presence/` | Signs connect tickets, proxies owner status and admin diagnostics to the Worker |
| Presence Worker `zuey-me-presence` | `workers/presence/` (`wrangler.toml` there) | Public `GET /v1/health`, `/v1/snapshot`, `/v1/history`, WebSocket `/v1/connect`; private `/internal/owner`, `/internal/diagnostics` |
| Durable Object `PresenceHub` | `workers/presence/src/presence-hub.ts` | One object holds every socket (Hibernation API), the owner status and the 24h history |
| Activity Monitor | `src/components/activity-monitor/` | Live numbers (`presence-feed.ts`) and the 24h chart (`presence-history.ts`) |
| Studio **Presence** tab | `src/components/studio/PresenceStudioTab.tsx` | Owner controls (owner only) and Worker diagnostics (every admin) |

## Deployment

CI is the only deploy path ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)); never run `wrangler deploy` or `wrangler pages deploy` by hand. On a push to `main` (or `gh workflow run deploy.yml --ref main`) it dry-run builds both Workers, then deploys in this order: **Pages → scheduler Worker → presence Worker**. Between the Pages step and the presence step the Pages app may already call a Worker route that does not exist yet: owner status and diagnostics answer `503 presence_unavailable` and the Activity Monitor shows "history unavailable" until the presence step finishes. Nothing else on the site depends on presence.

**Secrets** (names only; values never in git):

- Worker: `PRESENCE_TICKET_SECRET`, set once with `wrangler secret put PRESENCE_TICKET_SECRET --config workers/presence/wrangler.toml`; deploys keep it.
- Pages: the same `PRESENCE_TICKET_SECRET` value, plus `PRESENCE_OWNER_MEMBER_IDS` and optional `PUBLIC_PRESENCE_URL` (see [env-setup.vi.md §15](env-setup.vi.md#15-realtime-presence-số-người-đang-xem)).
- Every remote wrangler command runs with the DNS-owning account's `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` exported from `.env`, never a cached `wrangler login`.

**Custom domain.** `workers/presence/wrangler.toml` declares `presence.zuey.me` as a Workers custom domain (`custom_domain = true`, `workers_dev = false`); the deploy creates the DNS record and certificate on the `zuey.me` zone, so the zone must be in the same account as the deploy token.

**Service binding.** The root `wrangler.toml` binds `PRESENCE` → `zuey-me-presence` for every Pages environment. Pages reaches `/internal/*` only through it, with the time-bound `X-Presence-Internal` header (`src/lib/presence/internal-auth.ts`, `presence-internal-client.ts`).

**First deploy of a fresh account or Worker:**

1. Export the account credentials, then set the Worker secret (command above). If the Worker was never deployed, wrangler offers to create it with the secret; alternatively set the secret right after the first CI deploy (connects fail until then).
2. Set the Pages secrets with `wrangler pages secret put <NAME> --project-name zuey-me`.
3. Merge to `main` (or run the workflow). Wait for the presence step to finish.
4. Check `https://presence.zuey.me/v1/health` answers `{"ok":true}`, then follow the post-deploy check in [env-setup.vi.md §15](env-setup.vi.md#15-realtime-presence-số-người-đang-xem) and open Studio → **Presence** to see diagnostics.

## Monitoring

- **Diagnostics panel:** Studio → **Presence** (every admin) shows sockets (total, counted sessions, idle, watch-only, subscribers, owner), connection limits, counters since the Durable Object last woke (accepted/rejected connects, dropped messages, abuse closes, broadcasts), alarm timing and history storage. It refreshes every 30 s while open and visible, and on **Refresh**; after a `401`/`403` (expired session) auto refresh stops until a manual **Refresh** succeeds. Counters and alarm timings live in memory only. The hub hibernates after about 10 s without events, which resets them, and the diagnostics request itself wakes it, so on a quiet site they usually show zero and a wake time of a few seconds ago (`counters.startedAt`). They are only meaningful while the hub is kept busy, for example during a flood.
- **Diagnostics endpoint:** `GET /api/v1/presence/diagnostics` (admin session or key, or a read-only Studio key; `no-store`) returns the same `PresenceDiagnostics`. The Pages client keeps only the contract's fields, so nothing else the Worker might add reaches callers. `503 presence_unavailable` means the Worker could not be reached or answered badly.
- **Health route:** `GET https://presence.zuey.me/v1/health` is a cheap liveness check that never touches the Durable Object. It proves the Worker is deployed and routed, not that the hub is healthy; use the snapshot or diagnostics for that.
- **Logs:** `wrangler tail zuey-me-presence --format pretty` (with the exported credentials) streams console logs live. Persisted invocation logs are off on purpose (`invocation_logs = false`) because they record request headers, and the WebSocket handshake carries the connect ticket in `Sec-WebSocket-Protocol`. Tail output can also show request metadata: use it for live debugging only, never paste or store it. Do not turn invocation logs back on.
- **Pages side:** failures of the Worker calls are logged as `presence internal: Worker unreachable` / `unusable Worker response` with the transport, method and path (never the header or body).

## Cost model

The hub is one Durable Object on Workers Paid; see Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) for current rates. What drives the bill:

- **Requests.** Each WebSocket upgrade, each `/v1/snapshot` or `/v1/history` read that misses the caches, each internal call (owner status, diagnostics) and each alarm is a request. Incoming WebSocket messages (heartbeats every 25 s per visible tab, `idle`, `sub`) are billed at a reduced ratio of requests. Snapshot reads are absorbed by a 2 s per-isolate memo and a 5 s edge cache; history reads by a 60 s edge cache. The Activity Monitor refreshes history about every 5 minutes, and only while it is open and visible.
- **Duration.** With the Hibernation API the object is not billed for duration while sockets are idle between messages; it wakes for messages, alarms and reads. The alarm is armed only while a TTL sweep, keepalive or coalesced broadcast is pending (history never arms one), so a site with nobody counted lets the object sleep.
- **Storage.** The owner status and broadcast signature change rarely. The 24h history is one storage key, written whenever the current 5-minute bucket's peak rises (or a new bucket starts while someone is live), during the event that caused it, so a hibernating hub never loses an unwritten peak. One event writes at most once. A bucket that peaks at N visitors therefore costs at most N writes, since the peak rises by at least 1 each time (fewer when several arrivals land in the same 2 s broadcast window), and a steady crowd costs one write per bucket, 12 per hour. An hour's writes are bounded by the sum of its twelve bucket peaks, plus a retry after any failed write; nothing is written while nobody is live. Its size is shown as "History storage" in the diagnostics panel.

Measured numbers for a given visitor load belong in the presence load-test report under [`plans/reports/`](../plans/reports/); until that report exists, estimate from the drivers above and the diagnostics counters rather than from guesses.

## Runbook

**Worker down or misbehaving.** Visitors see the Activity Monitor say the live feed is unavailable (it keeps the last numbers, retries with backoff and falls back to polling the snapshot) and "history unavailable"; the beacon stops reconnecting for the page after repeated failures. The rest of zuey.me is unaffected. Owner status and diagnostics return `503 presence_unavailable`.

1. `curl -s https://presence.zuey.me/v1/health`. No answer: check the last CI run's presence step and the custom domain in the Cloudflare dashboard.
2. Health is fine but numbers are missing: open the diagnostics panel. Socket totals near the limits point at the caps; an alarm `nextAt` far in the past at a stuck alarm. The counters cover only the time since the hub last woke and reset after about 10 s without events, so do not compare them across refreshes or hours. Non-zero `connectsRejected`, `abuseCloses` or `messagesDropped` while the hub is busy (a flood keeps it awake) points at the limits or a misbehaving client; confirm with `wrangler tail` (step 3).
3. `wrangler tail zuey-me-presence` while reproducing.
4. Redeploy through CI: `gh workflow run deploy.yml --ref main`.

**Rotate `PRESENCE_TICKET_SECRET`.** Both sides must hold the same value. Pages secrets apply only to new deployments; a Worker secret applies at once.

1. Generate a new random value (for example `openssl rand -base64 48`) and keep it out of shell history and chat.
2. Put it on Pages: `wrangler pages secret put PRESENCE_TICKET_SECRET --project-name zuey-me`.
3. Run `gh workflow run deploy.yml --ref main` and, as soon as its Pages step finishes, put it on the Worker: `wrangler secret put PRESENCE_TICKET_SECRET --config workers/presence/wrangler.toml`.
4. During the short gap new connects fail (tickets signed with the other value) and owner/diagnostics calls answer `503`; open sockets stay connected because tickets are checked only when connecting. Clients retry with fresh tickets. Confirm with the post-deploy check and the diagnostics panel.
