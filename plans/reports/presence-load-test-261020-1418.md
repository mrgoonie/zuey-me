# Presence Worker local load test (issue #203)

Date: 2026-10-20 14:18 (Asia/Saigon). Branch `feat/activity-monitor-phase-3`, worktree `ecstatic-jackson-47ec3c`.
Script: `scripts/presence-load-test.ts` (run with `bun scripts/presence-load-test.ts --help`).

## Outcome

Both full runs at 500 sockets passed every correctness check: 500 of 500 sockets opened, the aggregate `active` count matched the held sessions at every checkpoint, there were no unexpected closes and no server error messages, every probe reached all subscribers, and teardown returned the count to 0. Latency is not stable across the two runs. Connect p50 was 1.05 s in run 1 and 4.34 s in run 2, while host load averaged about 98. Treat the latency figures as local, contended, and indicative only.

## Setup

- Worker: `bunx wrangler@4.151.2 dev --config workers/presence/wrangler.toml --port 8799`, with `workers/presence/.dev.vars` loaded by wrangler (`PRESENCE_TICKET_SECRET`, `PRESENCE_DEV_ORIGINS=1`). Miniflare runs the Worker and its PresenceHub Durable Object.
- Port deviation: port 8788 was held by a `wrangler pages dev` process from another worktree (`zueyos-perf-usability-bf413a`, workerd PID 33916 at report time). That process is not from this session, so it was not stopped. The Worker ran on 8799. The script defaults to 8788, so run it with `--url http://localhost:8799` when 8788 is busy.
- Client: Bun 1.4.2 with its native WebSocket. Origin `http://localhost:4321` and `CF-Connecting-IP` were set through the constructor headers. No `ws` package was needed. Node was not used.
- Tickets: signed in the script with `signPresenceTicket` from `src/lib/presence/ticket.ts`. The secret was read from `.dev.vars` at runtime and never printed. Each ticket had `k` unique per virtual browser, `c=true`, `m=false`, `o=false`, `exp=now+110s`, and a random `n`.
- Caps: the Worker keys its per-IP cap on `CF-Connecting-IP`, so each virtual browser got its own `10.x.y.z` address. Cap probes used `192.0.2.x`. No Worker code was changed to bypass a cap.
- Host: macOS Darwin 27, one machine. The client, the wrangler Node parent, and workerd all shared the host with other sessions' processes. Load average was about 98 during run 2.
- Scenario parameters: 500 connections at 50 per second, 20 subscribers, heartbeat every 25 s with random categories, 180 s hold, 12 open/close probes during the hold, 200 HTTP GETs at concurrency 4 (alternating `/v1/snapshot` and `/v1/history`), a 100-socket churn burst, then teardown.

## Results

| Measure | Run 1 (workerd listener sampled) | Run 2 (wrangler tree sampled) |
|---|---|---|
| Per-IP cap probe (21 sockets, one IP) | 20 accepted, 1 closed 1013 | 20 accepted, 1 closed 1013 |
| Per-key cap probe (11 sockets, one key) | 10 accepted, 1 closed 1013 | 10 accepted, 1 closed 1013 |
| Ramp: opened / failed | 500 / 0 | 500 / 0 |
| Ramp launch rate achieved | 44.1 conn/s (launch 11.3 s) | 36.7 conn/s (launch 13.6 s) |
| Connect latency p50 / p95 / p99 / max (ms) | 1050 / 1938 / 2061 / 2195 | 4338 / 6176 / 7626 / 7874 |
| Count after ramp (REST, ms after ramp end) | 500 at 3376 ms | 500 at 3307 ms |
| Probe-to-subscriber latency p50 / p95 / p99 (ms, 240 observations) | 1246 / 2017 / 2087 | 1123 / 2029 / 2033 |
| Probe timeouts | 0 | 0 |
| `/v1/snapshot` p50 / p95 / p99 (ms, n=100, all 200) | 48 / 350 / 718 | 42 / 656 / 722 |
| `/v1/history` p50 / p95 / p99 (ms, n=100, all 200) | 48 / 371 / 718 | 41 / 594 / 722 |
| Subscriber converge after 100-socket churn p50 (ms, n=20) | 2261 (p95 2302) | 6201 (p95 6213) |
| Count after churn (REST, ms after burst) | 400 at 5186 ms | 400 at 6768 ms |
| Teardown: closed / active after | 400 / 0 | 400 / 0 |
| Unexpected closes / server error messages | 0 / 0 | 0 / 0 |
| Workerd resources (peak RSS, CPU over run) | 93 MB, 3.1 CPU-s over 238 s (about 1.3%) | 298 MB, 26.3 CPU-s over 241 s (about 11%), 4 processes |

Notes on the table:

- Run 1 sampled only the workerd listener (PID 30713, one process). Run 2 sampled the wrangler Node parent (PID 30440), which includes esbuild, both workerd processes, and the Node proxy. The two CPU figures therefore cover different process sets and are not directly comparable.
- Probe latencies by event: run 1 open probes 486 to 2080 ms and close probes 939 to 1284 ms (p50 per event). Run 2 open probes 894 to 2027 ms and close probes 184 to 1905 ms.
- Hub counters (`/internal/diagnostics`) started at zero when each run began, since `startedAt` matched the run start. In run 1 they read `connectsAccepted` 536, `connectsRejected` 2, `broadcasts` 109, `activeSessions` 500, `subscribers` 20. These reconcile with the script: 500 pool sockets, 30 cap-probe accepts, and 6 probe opens give 536. The 2 rejections are the two cap probes. Run 2 showed the same counts.

## Observations

1. Correctness held at scale. Every checkpoint (after ramp, at hold end, after churn, after teardown) matched the expected count, both via subscriber pushes and via REST. The hub's own counters reconcile with the script's tallies. No messages were dropped and no socket was closed for abuse.
2. Broadcast latency is dominated by the 2 s coalescing window (`BROADCAST_MIN_INTERVAL_MS`). The fastest observed per-event p50 was about 184 ms (run 2, close probe), so the intrinsic push cost is small compared with the window. This is design behaviour, not a regression.
3. Connect latency grows with concurrency. Earlier 20-socket smoke runs measured p50 34 to 44 ms. At 500 sockets p50 was 1.05 s in run 1 and 4.34 s in run 2. The data cannot attribute this. Candidates are the local wrangler Node proxy (it used about 11% of a core on average in run 2), the Bun client's own event loop, and host load. Worker-side CPU in run 1 was about 1% of a core, so the Worker itself does not look CPU-bound here. This is unresolved.
4. The REST snapshot lags the WebSocket push by design. `/v1/snapshot` has a 2 s isolate memo and a 5 s edge cache (`workers/presence/src/snapshot-cache.ts`). After the churn burst REST took 5.2 s (run 1) and 6.8 s (run 2) to show the new count. Clients that need a live count must use the WebSocket.
5. HTTP reads stayed under about 50 ms at p50, but p95 reached about 350 to 660 ms under load. Most reads are memo or edge hits, and the script does not separate hits from hub reads, so the tail cannot be assigned to one cause.
6. The per-IP and per-key caps behave as documented (20 per IP, 10 per key). In local dev any client can set `CF-Connecting-IP`, so the per-IP cap is only meaningful behind Cloudflare, where the header is set by the edge.
7. The total cap of 5000 sockets was not reached. It is untested at this scale.

## Limitations

- Miniflare is not the edge. It has no real colo or PoP topology, no Cloudflare cache behaviour, and no DO placement or billing. Latency figures do not transfer to production.
- Single machine: client, proxy, and Worker share CPU and a host already under heavy load. Two runs differed by about 4× on connect latency.
- One client process generated all 500 sockets at about 40 to 50 connects per second.
- The 5000-socket total cap and the single global DO's throughput at higher counts were not exercised. At 5,000 visitors the heartbeat rate alone is about 200 messages per second into one DO, plus broadcast fan-out. This is a scaling risk that this run does not measure.

## Cost estimate (Workers Paid, Cloudflare pricing as published)

Prices, from the pages fetched on 2026-10-20:

- Durable Objects (`developers.cloudflare.com/durable-objects/platform/pricing/`): requests 1M per month included, then $0.15 per million. Duration 400,000 GB-s per month included, then $12.50 per million GB-s. Incoming WebSocket messages are billed at a 20:1 ratio. Hibernating idle objects are not billed for duration. SQLite rows read 25B included, then $0.001 per million. Rows written 50M included, then $1.00 per million. Stored data 5 GB-month included, then $0.20 per GB-month. The page's storage allowance wording is ambiguous, but storage here is under 1 MB, so it does not change the result.
- Workers (`developers.cloudflare.com/workers/platform/pricing/`): $5 per month minimum, 10M requests included, then $0.30 per million. 30M CPU ms included, then $0.02 per million CPU ms.

Assumptions (all stated, none measured in production):

- Average concurrent visitors V are 50, 500, and 5,000. Hours per month are 730.
- Mean visitor session is 5 minutes, so connects are 12 × V × 730 per month.
- Heartbeat every 25 s, so 144 messages per visitor-hour, billed at 20:1.
- One global DO instance at 128 MB, always billed for the full month (2,628,000 s). This is about 336,000 GB-s, below the included 400,000.
- One sweep alarm every 15 s while visitors are live. This is an upper bound and a fixed cost.
- Each connect costs 1 Worker request (`/v1/connect`), 1 DO request, and 1 ticket request (Pages Function). I assumed the ticket request shares the Workers 10M allowance.
- Snapshot and history reads reach the origin only through the edge cache: one request per 5 s and per 60 s respectively, per 3 PoPs.
- Worker CPU at about 2 ms per request. This is not measured.
- Storage writes: history at most 60 per hour, signature writes at most about 1,800 per hour. This is a worst case. The total stays far below 50M per month.

| Item | V = 50 | V = 500 | V = 5,000 |
|---|---|---|---|
| Connects per month | 438,000 | 4,380,000 | 43,800,000 |
| DO requests per month | 876,000 | 7,183,200 | 70,255,200 |
| DO request overage | $0.00 | $0.93 | $10.39 |
| Workers requests per month | 2,584,200 | 10,468,200 | 89,308,200 |
| Workers request overage | $0.00 | $0.14 | $23.79 |
| Workers CPU overage (assumed) | $0.00 | $0.00 | $2.90 |
| DO duration overage (128 MB) | $0.00 | $0.00 | $0.00 |
| Storage writes (worst case, 1.36M per month) | $0.00 | $0.00 | $0.00 |
| Variable total (excludes $5 plan base) | about $0 | about $1.07 | about $37 |

Sensitivity: if the DO holds 256 MB, duration overage is about $3.41 per month regardless of V. If the Pages ticket requests are billed outside the Workers allowance, the Workers request overage at V = 5,000 falls from $23.79 to about $10.65.

## Recommendations

1. Re-run on an idle host, or on a host with a known baseline load, and repeat each scenario at least three times before quoting latency. The 4× gap between runs makes single runs unreliable.
2. Profile the hub's per-message CPU time (for example with the DO's own timing counters or a profiler) before any capacity claim above a few hundred visitors.
3. Add a run that splits cache-hit and cache-miss HTTP reads, so the p95 tail can be attributed.
4. Decide whether the 2 s coalescing window is acceptable for subscriber freshness. The measured latency is mostly that window.

## Next steps

1. Confirm the 8788 holder (workerd PID 33916, another worktree) is intentional. Use `--url http://localhost:8799` or any free port in the meantime.
2. Re-run the scenario on a quieter host and record the diagnostics counters for each run.

## Unresolved questions

- What causes the 4× connect-latency difference between run 1 and run 2? Host contention, the wrangler proxy, or the client's event loop has not been separated.
- Does a single PresenceHub DO sustain 5,000 visitors (about 200 heartbeats per second plus fan-out)? Not measured.
- Are Pages Function ticket requests billed against the same Workers allowance? The estimate assumes yes.
- Does the sweep alarm fire every 15 s while visitors are live, or less often? The estimate uses the upper bound.

## Reproduce

```sh
bunx wrangler@4.151.2 dev --config workers/presence/wrangler.toml --port 8799
bun scripts/presence-load-test.ts --url http://localhost:8799 --connections 500 --ramp-per-second 50 \
  --subscribers 20 --hold-seconds 180 --probes 12 --http-requests 200 --churn 100 --worker-pid <wrangler-node-pid> --out <file>.json
```

Stop the Worker tree afterwards. Only processes started for the run were stopped: wrangler PID 30429 and its children (30440, 30690, 30713, 30749). The 8788 holder was left running.
