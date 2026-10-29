# Review: PR #120 (closes #96)

Head `f791b03`, reviewed in an isolated worktree with `origin/main` (`017f5be`) merged in locally.

**Verdict: approve.** No blocking findings. The branch needs a merge from `main` first because of a one-line import conflict.

## PostHog semantics (checked against posthog-js 1.438.7 source, `lib/src/posthog-core.js`)

- `reset()` clears opt-out: confirmed. `_reset()` calls `this.consent.reset()` unless it is a consent transition (L3352-3353). The library itself warns about calling `reset()` after `opt_in_capturing()`.
- `loaded` runs before the automatic pageview: confirmed. `_loaded()` calls `config.loaded(this)` (L1125), then schedules `_captureInitialPageview` with `setTimeout(…, 1)`. That callback checks `consent.isOptedIn()` when it fires (L1141-1147).
- The snippet queue replays synchronously right after `init` in `init_from_snippet` (L4813-4823), before that timeout fires. `_execute_array` keeps `reset` and `opt_out_capturing` in their queued order, because both land in `other_calls` (neither name contains `capture`). So putting the opt-out last is enough for the in-load race. The `loaded` re-check covers an opt-out stored in another tab before the library loads, where nothing is queued.
- With `capture_pageview: true` (posthog.ts:181), the pageview path above applies as described.

## Findings

### Blocking
None.

### Low
1. **Merge conflict with `main`.** `src/lib/analytics/destinations/posthog.ts:5`: `main` (#101) added `import { isGuestDistinctId } from '../identity';` on the same line as this PR's `import { canTrack } from '../consent';`. Keeping both imports resolves it. Tests and the build pass once it is resolved.
2. **No test for the fallback when storage cannot save the choice.** `src/lib/analytics/client.ts:174`: `if (granted()) each(d => d.optOut())` only runs when `env.storage` is null. A `BLOCKED_STORAGE` result already reads as `storage_blocked`, so in a real browser this path is close to unreachable. The logic is right, but no test covers it.

### Info
- In `identify()`, the `!granted()` branch of `resetDestinations()` (client.ts:120) cannot run, because `identify` returns early unless `live()`. It does no harm and keeps one reset path.
- No regression for opted-in visitors. `resetDestinations()` adds `optOut` only when consent is not granted. Existing tests still expect `['reset']` for sign-out (tests:236) and `identify:usr_a, reset:, identify:usr_b` for an identity change (tests:226).
- DNT/GPC handling is unchanged. `consent.ts` is not touched, and DNT visitors never `init`, so `loaded` never runs for them. Reset paths for these visitors only queue calls on the stub, and those calls are dropped.
- Privacy toggle (`src/pages/privacy.astro:486-491`) is unchanged. Opting back in after an opt-out still works: `optIn()` queues or calls `opt_in_capturing` after any earlier queued opt-out.
- #103 area (storage probe order, copy): no overlap. `canTrack()` in `loaded` reuses the per-page memoized storage probe.
- No `any`. `LoadedPostHogLike` types the callback argument. SSR-safe: `consent.ts` has no window access at import time, and `canTrack()` runs only inside `loaded`. Importing `consent.ts` into `posthog.ts`, which the server adapter also uses, has no side effects.

## Tests are meaningful
With the PR tests run against `main`'s `client.ts` and `posthog.ts`, `tests/analytics.test.ts` gives **54 pass / 4 fail**. The 4 failures are the call-order test, the in-load opt-out, the opt-out stored in another tab, and the opted-out sign-out. The `loadLibrary` helper follows the real posthog-js order: `loaded`, then queue replay (where `reset` clears the opt-out), then the pageview.

## Gates (merged tree)
- `bun install --frozen-lockfile`: OK
- `bun test`: **907 pass / 0 fail** (50 files)
- `bun run build`: astro check **0 errors, 0 warnings**; build complete

## Browser check
I reran the author's `check-i96.mjs` against a local dev server on port 4448 with `PUBLIC_ANALYTICS_DEBUG=1` (port changed from 4443). Capture requests were answered locally with a fake response and other PostHog requests were aborted, so nothing reached PostHog.

| Scenario | Result |
| --- | --- |
| Opt out while `array.js` is delayed | 0 capture requests, `has_opted_out_capturing()` true |
| Opted-in visit | `$pageview` sent, 1 request |
| Opt out after load, then leave | only the `$pageview` from before the opt-out (1 request), no `$pageleave` |
| Opt out, then `reset()` (sign-out), then leave | 1 request (before the opt-out); still opted out after the reset |

These match the PR body. I stopped my dev server process tree afterwards.
