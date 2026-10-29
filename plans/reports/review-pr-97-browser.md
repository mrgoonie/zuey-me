# PR #97 real-browser review (issue #91)

Verdict: **APPROVE**. Posted: https://github.com/mrgoonie/zuey-me/pull/97#issuecomment-6108745010

Setup: reused the dev server on :4435 (verified it was `astro dev --port 4435` from `D:\www\zuey\review-97`), worktree at PR head `29a0a29` (matches `headRefOid`). Ran Playwright with headless Chromium 1243 against `/privacy?lang=vi|en`, with non-localhost requests blocked.

| Case | Copy (vi/en) | Toggle | Own uncaught errors | Result |
| --- | --- | --- | --- | --- |
| getter throws | storage-off / storage-off | hidden, 0x0 | none | PASS |
| setItem throws (quota) | storage-off / storage-off | hidden | none | PASS |
| DNT / GPC | DNT / DNT | hidden | none | PASS |
| normal | granted, then opted-out + "saved", then granted; survives reload | visible, works | none | PASS |
| probe key leftover | none | | | PASS |

Findings:
- In the getter case, the one uncaught SecurityError comes from Astro's dev toolbar (`dev-toolbar/settings.js` `getSettings`), which only runs in dev. The `consent.ts` access is caught. The original `check.cjs` filter missed this because the error had no stack frames, so I captured the callers inside the getter.
- No analytics boot: `bootAnalytics` is gated on `consentState === 'granted'` (client.ts:277). There were no PostHog requests in any case, but localhost is silenced by `shouldCaptureOn`, so this is a code-level guarantee and not a runtime positive control.
- The probe fires one cross-tab `storage` event per page load. Nothing in `src/` listens for `storage`, so it has no effect.
- The Medium from the earlier review (QuotaExceeded shows the "Allow storage" copy) is recommended as a follow-up, not blocking.

Cleanup: stopped the astro dev tree (PIDs 60368/66948 and children), so :4435 is free. Removed the `review-97` and `review-97m` worktrees, pruned, and deleted `D:\www\zuey\rv97`. Other reviewers' worktrees (`rv79`, `rv98`) were left untouched.
