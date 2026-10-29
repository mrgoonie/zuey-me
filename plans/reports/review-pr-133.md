# Review: PR #133, Dodo reversal lookup retries on transient errors; 10 s timeout on every Dodo call (closes #131)

Head `a8284a98`. Reviewed with the latest `origin/main` (`13ebe5d`) merged in locally (clean merge). Isolated reviewer. No Dodo API calls were made.

**Verdict: APPROVE.** The issue's expected behaviour is implemented and tested. One non-blocking Low (429/408 are classed as permanent) and two nits.

## Gates (merged tree, Windows)

- `bun install --frozen-lockfile`: OK
- `bun test`: **962 pass, 0 fail** (52 files)
- `bun run build`: astro check **0 errors, 0 warnings** (65 hints, pre-existing); build complete
- New test fails against main: with main's `dodo.ts`, `dodo-billing.ts` and `webhooks/dodo.ts` swapped in, `tests/analytics-outbox.test.ts` gives 31 pass / **1 fail** (the new outage test). On the PR head: 32 pass / 0 fail. Files restored afterwards.
- No `any`, no unchecked casts. `DodoApiError` extends `AppError` with the same `502 payment_provider_error`, so the error envelope is unchanged.

## What was checked

- **Nothing written before the 502.** `cardFromDodoLookup` runs before `recordEvent` and before any commission, analytics or activity write (`dodo-billing.ts`, `applyDodoReversal`). A rethrown `DodoApiError` reaches `errorResponse` in the route, so Dodo gets a non-2xx and redelivers. Retries are bounded by Dodo's 8 attempts; after the last one the reversal is lost, which is the same outcome as before but only after about 28 hours of outage instead of at once.
- **Classification** (`dodo-billing.ts:614-626`). Missing `DODO_API_KEY` is checked before the call and returns `ignored` (otherwise `requireApiKey`'s non-Dodo `AppError` would be rethrown). Network error and timeout give `upstreamStatus = null` and propagate. 5xx propagates. 4xx is `ignored`. Any non-`DodoApiError` propagates. A 2xx whose body is not a JSON object, or whose body read is aborted by the timeout, becomes `DodoApiError(200)` and is retried, which is the right side to err on.
- **Timeout** (`dodo.ts:85`, `:107`). `AbortSignal.timeout(10_000)` is passed to `fetch`, so it also bounds the body read in `res.json()`. `TimeoutError` gets its own message (`:110`). Workers supports `AbortSignal.timeout`. Checkout, portal, cancel and discount callers still see an `AppError(502, 'payment_provider_error')`; only the message differs on timeout. 10 s is generous for checkout UX and keeps the lookup short of a webhook delivery timeout.
- **No secret leakage.** Messages contain only the operation name and HTTP status. The original fetch error (which could carry a URL) is not included. The API key is only in the request header.
- **Tests are real.** The outage test drives `applyDodoReversal` through the fake `membersRuntime.fetch` with a 503, a `TypeError('fetch failed')` and a `DOMException(..., 'TimeoutError')`; asserts status, code and message; asserts that no log and no `refund` row were written; asserts an `AbortSignal` is passed on every call; then 404 is `ignored` and, once Dodo answers, the redelivery is applied once.
- **Docs.** `docs/analytics-events.md` and the route comment match the code.

## Findings

**[Low] 429 and 408 are treated as permanent and drop the reversal** (`src/lib/payments/dodo-billing.ts:623`). Any 4xx returns `ignored` with a 200. A Dodo rate limit (429) or request timeout (408) is transient by definition; it is exactly the outage-like case #131 wants retried. Suggestion: rethrow when `status === 408 || status === 429` as well (and add one row to the outage table in the test). Rare in practice, so non-blocking.

**[Nit] `public upstreamStatus`** (`src/lib/payments/dodo.ts:92`) can be `public readonly`.

**[Nit] Test proves a signal is passed, not that it is a timeout.** `signals.every(s => s instanceof AbortSignal)` would also pass for a never-aborting signal. Acceptable; the `TimeoutError` branch is covered by the thrown `DOMException`.

## Rebase note

#136 (closes #132) touches the same function and will be rebased onto this. See the checklist in `review-pr-136.md`.
