# Review round 2: PR #130 (closes #103), head 1f8aa0d

Reviewer context: isolated, did not write this code. Previous round was static only (`review-pr-130.md`, head f1c7dd2). This round ran every gate.

## Verdict: APPROVE

All three round-1 findings that were actionable are fixed and proven by mutation. No blocking defects.

## Setup

- Temporary worktree `D:\www\zuey\rv130b`, detached at `1f8aa0d1d0c64affccdb9254da2b053b2e3ed7da`. `git merge origin/main` returned "Already up to date": the head already contains the latest main.
- `bun install --frozen-lockfile` succeeded (742 packages).

## Gates

| Gate | Result |
| --- | --- |
| `bun test` | 946 pass, 0 fail, 52 files |
| `bun run build` | `astro check`: 0 errors, 0 warnings, 65 hints. Build Complete. |
| Mutation: put back only the eager probe in `browserConsentEnvironment` (`const eager = safeStorage(); ... () => eager`) | 1 fail: "the real consentState() never touches localStorage when DNT or GPC is on" |
| Mutation: drop the DNT guard in `setOptOut` (consent.ts:144) | 2 fail: the real-globals DNT test and "client opt-out and opt-in never read consent storage..." |
| Mutations reverted | `git status` clean |

Round-1 Medium #1 is resolved. The new block at tests/analytics.test.ts:578-640 drives the real `consentState()`, `canTrack()` and `setOptOut()` against stubbed `window`/`navigator` and a getter-spied `localStorage`, with `resetConsentStorageProbe()` in `beforeEach`/`afterEach`. It now catches a regression to eager probing.

## Browser check (`check-i103.mjs`, dev server on :4452, `BASE`/`TAG` env vars, script unedited)

| Case | vi / en status | Toggle | localStorage writes | PostHog requests |
| --- | --- | --- | --- | --- |
| getter throws (SecurityError) | cannot-save copy | hidden | none | none |
| quota full | the same cannot-save copy | hidden | probe attempted (throws) | none |
| DNT | DNT copy | hidden | **none** | none |
| GPC | DNT copy | hidden | **none** | none |
| normal | "on" + "Tắt thống kê" / "Turn analytics off" | visible | probe once, removed | none |

On the getter-throws case the script recorded a single page error, "The operation is insecure." A stack trace (`trace-ls-r2.mjs`) traced it to `astro/dist/runtime/client/dev-toolbar/settings.js` `getSettings`. That is Astro's dev-only toolbar, not app code. The app's consent probe caught its own exception. Production is unaffected.

Dev server: process tree (astro.exe 68936 → node 38372 and 3 children) stopped with `taskkill /T`. Port 4452 is no longer listening and no `rv130b` processes remain.

## Checks against the brief

- **No storage access for DNT/GPC on client paths:**
  - `consentState` (consent.ts:114) returns before `env.storage` is read. `browserConsentEnvironment` (consent.ts:91) uses the lazy getter, so `safeStorage()` never runs for DNT.
  - `bootAnalytics`, `track`, `identify` and `syncIdentity` all gate on `consentState`/`live()`. `optIn`/`optOut` → `setOptOut` now returns early (consent.ts:144). Then `consentState`/`granted()` take the lazy path.
  - The one remaining touch is `reset()` (see Low #2), which is pre-existing and removal-only.
- **`resetConsentStorageProbe` (consent.ts:68)** only sets the module cache back to `undefined`. It has no production caller (grep: tests only). If it were called in production, the next read would just probe again. It is harmless.
- **`isOptedOut` removed.** It has no remaining references. The test now asserts `canTrack(...) === false` for throwing storage.
- **Opt-out persists, and the #96/#120 order is intact.** `client.ts` is unchanged against main. The `optOut` order is still `setOptOut` → `reset()` (re-applies `d.optOut()` when not granted) → page-level `optOut` fallback. `optIn` still re-boots and lifts the posthog-js opt-out. The existing client tests pass.
- **Vietnamese diacritics:** correct throughout `consent-control.ts` and the privacy paragraph. The copy keeps the page's existing "xoá" spelling and reads naturally ("bộ nhớ cục bộ bị chặn hoặc đã đầy", "xoá bớt dữ liệu đã lưu"). The rendered text in the browser matches the source.
- **Client bundle:**
  - The privacy page chunk is 1.8 kB and imports only `client.*.js`.
  - The shared client chunk is 15 kB. It contains none of `zuey-me-server`, `/i/v0/e`, `D1Database`, `node:` or `process.env`.
  - `consent-control.ts` imports only `./consent`.
  - No `any` and no unchecked casts.
- **EFFECTIVE:** `privacy.astro:11` reads `2026-10-11`. That is already the value on main, so this PR's copy change falls inside the current effective date.

## Findings

### Low

1. **The hidden-toggle regression guard was dropped.** The PR deletes the old `privacy page consent copy` test (main tests/analytics.test.ts:582-583). It asserted that `privacy.astro` keeps `inline-flex items-center [&[hidden]]:hidden` on the toggle. The class is still present at src/pages/privacy.astro:401, and the browser check confirms the button is hidden for DNT/blocked states. Nothing now prevents someone from removing `[&[hidden]]:hidden`, though, and that would bring back the empty visible button. Suggested fix: keep that single `toContain` assertion in the new `privacy consent control` block. Not blocking.
2. **`reset()` still touches storage for DNT visitors (src/lib/analytics/client.ts:121-130).** On sign-out it removes `IDENTITY_STORAGE_KEY`/`IDENTITY_CACHE_KEY` from localStorage and sessionStorage whatever the consent state. `optOut()` calls the same `reset()`, but the toggle is hidden for DNT.
   - This is pre-existing and unchanged by the PR.
   - It only removes keys: it never writes, never touches the probe key, and fires no `storage` event when the key is absent.
   - It is privacy-positive, because it clears an identity left from before the visitor enabled DNT.
   - I consider this correct behaviour, not a defect. Recorded because the brief asks for "no storage access" on every path.

### Info

3. The getter-throws page error comes from Astro's dev toolbar (dev only). No action.

## Unresolved questions

None.
