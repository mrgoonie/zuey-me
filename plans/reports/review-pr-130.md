# Review: PR #130 (closes #103), head f1c7dd2

Reviewer context: isolated, did not write this code. Static review only.

## Verification limits

- No PowerShell tool was available to this reviewer, and the Bash tool was in dead-shell mode: `echo`, `pwd` and a setup script all returned nothing and had no side effects. The temporary worktree `D:\www\zuey\rv130` was never created, so there is nothing to clean up.
- So these did NOT run: `bun test`, `bun run build`, the check that the new tests fail on main, the Playwright check `check-i103.mjs`, and `gh pr comment`. The GitHub REST API returned 403 to WebFetch, so CI check-runs could not be read either.
- Source read from the author worktree `.claude/worktrees/agent-a9eecc75ea4e3bed1`. Its reflog shows HEAD = `f1c7dd20c20aaf8cd2c73abaa1c07e22f3905401` (commit "fix(analytics): check DNT before probing storage..."). Uncommitted edits there cannot be ruled out without git.
- Baseline (main) `consent.ts` compared against `.claude/worktrees/agent-a7f1578fc5e659558` (and three other worktrees with the same text). There, `browserConsentEnvironment()` builds `{ storage: safeStorage() }` eagerly, so main runs the write probe before DNT is checked. The defect this PR fixes is real.

## Verdict (static): APPROVE, conditional on gates

No blocking defects found. Merge only after `bun test` and `bun run build` are confirmed green (by CI or a working shell).

## Findings

### Medium

1. **tests/analytics.test.ts:584-595: the DNT test checks the helper, not the production wiring.** The test builds its own `lazyConsentEnvironment(nav, null, resolver)`. Suppose `browserConsentEnvironment()` (consent.ts:86-90) went back to resolving storage eagerly, e.g. `const s = safeStorage(); return lazyConsentEnvironment(..., () => s)`. Every new test would still pass. "Fails against main" holds only because main has no `lazyConsentEnvironment` export, so the import breaks; it does not show the invariant is enforced. Fix: add one test that stubs `globalThis.window`, `globalThis.navigator = { doNotTrack: '1' }` and a spy `globalThis.localStorage`, then calls `consentState()` with no arguments and asserts zero spy calls. Run it first in a fresh module, or reset the stubs, because `pageStorage` is cached at module level. Until then, only the author's browser check covers the real path. Not blocking.

### Low

2. **consent.ts:108-112 `isOptedOut`.** It is exported, has no production caller (grep across `src/`), and is used in one test assertion (tests/analytics.test.ts:129). With the lazy environment it is now the only exported consent read that runs the storage probe without checking DNT first. It breaks the same invariant this PR sets up, and the only thing keeping it harmless is that nothing calls it. **Recommendation: remove it in this PR.** It is a 5-line deletion plus one test line, and line 128 already asserts `storage_blocked`, which covers the same behaviour. That is cheaper than a later issue. The alternative is to add a `hasDoNotTrack` guard, but the function's doc says it reports the browser's own choice, so a guard would blur its meaning. Not blocking, because there is no caller today.

3. **client.ts:162-172 `optOut()` / `optIn()`** call `setOptOut(..., deps.consent())`, which reads `env.storage` and so runs the probe without checking DNT. The only caller is the `/privacy` toggle, which is hidden for `do_not_track` (consent.ts:131), so a DNT visitor cannot reach it today. A cheap hardening would be an early `if (hasDoNotTrack(env)) return false` in `setOptOut`. This file was unchanged and the path is unreachable, so it is optional and could be its own issue.

4. **client.ts:121-130 `reset()`** removes the identity keys through `safeLocalStorage()` and `safeSessionStorage()` whatever the consent state. This is existing behaviour and only removes keys (it never runs the write probe), so it is out of scope for #103. Noted here because "zero storage access" read literally does not hold on sign-out.

## Checks against the brief

- DNT/GPC: `consentState` (consent.ts:114-119) checks `hasDoNotTrack` before `readOptOut`, and the `storage` getter (consent.ts:79-81) means no probe runs. `bootAnalytics` (client.ts:277), `live()` (client.ts:77, which gates track, identify and syncIdentity) and `currentConsent` (client.ts:243-245) all use `browserConsentEnvironment()` → `consentState`, so they all take the lazy path. The PostHog destination (destinations/posthog.ts) never reads consent storage, and `ph.init` is never reached for DNT. `respect_dnt: true` remains as a second guard.
- Opt-out persists and is honoured: `setOptOut(true)` writes `'1'`, and `readOptOut` returns true → `opted_out` → `canTrack` is false. Unchanged.
- Blocked vs full storage: `resolveConsentStorage` (consent.ts:44-55) returns `BLOCKED_STORAGE` when the getter throws (SecurityError) or when `setItem` throws (QuotaExceededError). Both resolve to `storage_blocked`, so the toggle is hidden and analytics stays off. Tests at 607-630 cover both cases.
- The probe is cached once per page (`pageStorage`), so other tabs do not get repeated `storage` events. The getter calls `safeStorage()` on every read, and that call returns the cached value.
- #96/#120 opt-out-after-reset: the `client.optOut` sequence (`setOptOut` → `d.optOut()` → `reset()`) and the `optIn` re-boot plus `postHogClientDestination.optIn()` are unchanged. No regression found.
- Copy: the Vietnamese diacritics are correct and use the page's existing "xoá" spelling. The EN `storageOff`, `notSaved` and analytics paragraph match the VI meaning. One small difference: VI says "luôn tắt" ("always off") where EN says "stays off". Both are acceptable.
- Client bundle: the page script imports `client.ts` and `consent-control.ts`. `consent-control.ts` imports only `./consent`. No server-only modules, no `any`, no unchecked casts.
- The toggle click (privacy.astro:467-472) shows "saved" or "notSaved" by comparing the state before and after. If `setItem` hits the quota after a probe that passed, the state does not change and the page honestly appends `notSaved`.

## Required before merge

1. Someone with a working shell runs `bun test` (0 fail) and `bun run build` (0 errors, 0 warnings) on the head merged with origin/main, or reads CI on the PR.
2. Optionally run `check-i103.mjs` against a dev server on port 4451.
3. Post the summary comment on the PR. This reviewer could not post it.

## Unresolved questions

- Was `EFFECTIVE` (privacy.astro:11, `2026-10-11`) bumped in this PR? The copy change is material, so it should be. This could not be checked without a diff.
