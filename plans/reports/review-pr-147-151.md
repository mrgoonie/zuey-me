# Review: PR #147 (closes #143) and PR #151 (closes #144)

- Date: 2026-10-12 (Asia/Saigon)
- #147 head `05af18598b13d4f3b7fa4075c1c2de4fd0eb3ada`, base `main`
- #151 head `c119541e48c54cd81eb96b0b8cb90e1d4f94b053`, base `fix/143-pii-regex-linear`
- Prior review: `plans/reports/review-pr-140.md`

## Verdicts

| PR | Verdict | Reason |
| --- | --- | --- |
| #147 | REQUEST_CHANGES | The cap fixes the 1 MB case, and no PII leaks through the cut. But `JWT_RE` is still quadratic up to the 16 KB cap: about 80 to 150 ms per string in V8 (Chrome), and about 1 to 1.9 s per event when a crafted URL fills about 12 URL properties. #143 asks for a worst case that is "linear and small". |
| #151 | REQUEST_CHANGES (small) | The behaviour is correct and well tested. `docs/analytics-events.md` still says "decoded up to three times". It should also record that `advanced_disable_flags` turns off remote config. The PR inherits the JWT worst case from #147. |

## Gates (fresh worktree per head, `bun install`)

| Head | `bun test` | `bun run build` |
| --- | --- | --- |
| #147 `05af185` | 1013 pass, 0 fail (55 files) | astro check 0 errors, 0 warnings (65 hints); build complete |
| #151 `c119541` | 1019 pass, 0 fail (55 files) | astro check 0 errors, 0 warnings (65 hints); build complete |

Worktrees, review branches, `dist/` and `.wrangler/` (inside the worktrees) were removed afterwards.

## 1. Linear worst case

`pii.ts` has no phone pattern. The regexes are `EMAIL_RE`, `JWT_RE`, `SECRET_RE`, `INLINE_PARAM_RE`, `SEGMENT_RE`, the path templates and the escape regexes. I ran each against adversarial inputs at 16 KB and at 1 MB, in bun (JSC) and node 24 (V8).

- **At 1 MB everything is cut first, so it is fast.** Every input took 0.2 to 4 ms in bun and about 1 ms in V8. The `capLength` walk-back is O(16 K).
- **Under the cap, every regex except JWT stays small.**
  - `a.a@`, `a@`, `a@ + a.` blocks, IDN `ọ.ọ@` and `ü@ü.`: 3.6 ms or less in both engines.
  - `zm_` and short ` zm_` runs: 0.5 ms or less.
  - Deep `%2525` and invalid `%C3` runs: 4.2 ms or less in #151.
  - `SECRET_RE` is effectively linear, because a long run always matches and a failing run is shorter than 12 characters.
- **`JWT_RE` is quadratic within the cap.** A dot-free run of `eyJ` restarts at every `eyJ` and scans to the end.

| Input (just under 16 KB) | bun/JSC | node/V8 |
| --- | --- | --- |
| one string `https://zuey.me/?x=eyJeyJ…` | 18 ms | 74 ms (bare regex), 80 to 155 ms through `scrubValue` |
| 12 such strings in one capture | 225 ms | 995 ms (#151) to 1862 ms (#147) |
| 12 benign 16 KB strings | n/a | 36 ms |

**Judgement:** about 20 ms is acceptable only in JSC. Most visitors use Chrome, where one string costs about 80 ms or more. A crafted link lands in several properties: `$current_url`, `$session_entry_url`, `$initial_current_url`, `$pathname` and similar, and later `$referrer`. Each pageview, pageleave and autocapture click then costs several hundred ms to about 1 s. That is far better than main, which took minutes, but it is not the "linear and small" result #143 asks for.

**Possible fixes** (any one works):

- Lower `MAX_SCRUB_LENGTH` to 4 KB. This cuts the quadratic term by 16 times. Chrome already trims referrers above 4096 characters.
- Bound the JWT header run, for example `eyJ[A-Za-z0-9_-]{4,1024}`. This misses only headers longer than 1 KB, such as `x5c` chains.
- Use a small linear scanner. Split runs of `[A-Za-z0-9_.-]`, take the first `eyJ` in a dot-separated part, and check that the next two parts are at least 4 characters long.

Add a timing test that runs the under-cap `eyJ` case.

## 2. No PII leaks through truncation or the decode cap

- **Truncation.** I placed an email, an encoded email (`%40`), an IDN email (plain and encoded), a JWT and a `zm_` token at every offset across the 16 KB boundary. I tried 8 separators (space, `&`, `,`, `:`, `(`, `.`, `+`, `%20`) and three entry points (`redactString`, `scrubUrl`, `scrubValue`).
  - No fragment of any of them survived.
  - The cut always lands on a `SEGMENT_DELIMITER_RE` character, and none of the PII patterns can include one. So a token is either kept whole, and then scrubbed, or dropped whole.
  - If there is no delimiter, the whole value becomes `[redacted]`.
  - When `scrubUrl` re-serialises a URL it can grow past the cap. `redactString` then caps it again at a delimiter.
- **Decode cap (#151).** `jane%40example.com` is redacted at every encoding depth from 1 to 11. Depths 1 to 8 are decoded and matched. Depth 9 and above returns `null` and is redacted whole, and `containsPii` returns `true`.
  - Invalid UTF-8 runs fall back to decoding ASCII only, so decoding never throws.
  - Each pass makes the string shorter, so the loop always ends.

## 3. No legitimate data damaged

**Callers:**

- `containsPii` is called from `events.ts:291` (values capped at 500 characters by `MAX_STRING_LENGTH`), `identity.ts:23` (after `DISTINCT_ID_RE`, 200 characters or less) and `attribution.ts:32` (after `UTM_VALUE_RE`, 64 characters or less). The 16 KB rule cannot change behaviour for any of them.
- `scrubValue` is called from `posthog.ts:145` (`before_send`). Only automatic properties longer than 16 KB change: they are now cut at a delimiter and end in `[redacted]`. That is acceptable.

**Unchanged:**

- Encoded Vietnamese paths and UTM values, `100%25 free`, and single- or double-encoded redirect URLs.
- `a%2Bb%3Dc%26d`.
- `@duy`, `@zuey.me` (no local part), `a@b`, `user@localhost`, `@astrojs/react@4.2.1`, `pkg@1.2.3` and `2@3.50`.
- Raw Vietnamese free text.

**#151 round-trips:**

- `h%E1%BB%8Dc%20jane%40…` becomes `h%E1%BB%8Dc%20[redacted]`.
- `mailto:jane%40…` becomes `mailto:[redacted]`.
- `%E2%9C%93 … %F0%9F%98%80` is kept.
- Raw-Unicode free text stays raw.

**Pre-existing, not introduced by these PRs:**

- `image@2x.png`, `logo@3x.webp` and `v1.2@beta.release` are redacted. Retina asset names in autocapture attributes are a false positive that the ASCII regex on main already had. Worth its own issue.
- When an email is redacted from a segment, a `%2B` in that segment comes back as a literal `+`, which a query string reads as a space.
- In a segment that mixes raw and encoded Unicode, the encoded Unicode comes back raw.

## 4. IDN regex (#151)

`/[\p{L}\p{M}\p{N}._%+-]{1,64}@[\p{L}\p{M}\p{N}.-]{1,253}\.[\p{L}\p{M}]{2,63}/gu`

- **No new false positives on ordinary text.**
  - `@mentions` need a local part directly before the `@`.
  - `a@b` and `user@localhost` need a dot and a TLD of at least 2 letters.
  - `\p{N}` is excluded from the TLD, so `ab@cd.e1` does not match.
  - Text glued to an `@` with Unicode letters around it (`Nội@Sài.Gòn`) would now match. That is rare and acceptable.
- **Worst case is still small.** It took 3.6 ms or less in V8 and 1 ms or less in JSC for every adversarial 16 KB shape. Bounded quantifiers keep each start position constant-cost.

## 5. `advanced_disable_flags` (#151)

- **posthog-js is not in `node_modules`.** The site loads the latest `array.js` from the CDN (npm latest is 1.438.7). I checked `PostHog/posthog-js` main instead.
- **The option is real.** It appears in `packages/types/src/posthog-config.ts` and defaults to `false` in `posthog-core.ts`.
  - `_shouldDisableFlags()` reads it.
  - `MutableFeatureFlagsConfigSource` turns it into `remoteRequestsDisabled`.
  - `_callFlagsEndpoint` and refresh return early when `remoteRequestsDisabled` is set, so `/flags` is not sent.
- **It also skips remote config.** `RemoteConfigLoader.load()` returns before fetching `/array/{token}/config` when `_shouldDisableFlags()` is true. The snippet loads the generic `/static/array.js`, so no config is preloaded. Consequences:
  - Settings from the PostHog UI are ignored: heatmaps, web vitals, surveys, exception autocapture, dead clicks, and the server-side autocapture opt-out. The site uses none of them; `src/` has no surveys, flags, heatmaps or vitals.
  - Autocapture keeps working. Its `isEnabled` allows `clientConfigOnly` when remote requests are disabled.
  - `elementsChainAsString` is never set from remote config. So autocapture should now send `$elements`, an array of objects, instead of the `$elements_chain` string. `scrubValue` covers that shape at depth 3, below `MAX_DEPTH`, so nothing leaks. But the docs and tests talk about `$elements_chain`. Verify this on a production event and update the docs.
- **Requests that do not pass through `before_send`:**
  - `/flags` is now off.
  - Remote config is now skipped, and it carried only the token.
  - `_getRemoteConfigPayload` (TODO upstream) ignores the flag but runs only from `getFeatureFlagPayload`, which the site never calls.
  - Session replay is off.
  - Capture requests (`/e/`, `$identify`, `$set`) all go through `before_send`.
  - The persistence cookie holds the raw `$initial_*` values. It is first-party on zuey.me and the host is `us.i.posthog.com`, so the cookie is not sent to PostHog.
- **Recommendation:** extend the code comment and the doc sentence to say the flag also turns off remote config, and that any PostHog-UI feature must now be enabled in code.

## 6. Privacy wording (#151)

- VI: "Không ghi lại phiên màn hình (session replay) và trình duyệt không gửi yêu cầu feature flag tới PostHog." This is accurate and grammatical.
- EN: "Session replay is not recorded, and the browser sends no feature-flag requests to PostHog." This is accurate.
- Both are true given `_shouldDisableFlags()`. "Feature flag" is jargon, but acceptable on this page.

## Findings to fix

1. **#147, should fix.** `JWT_RE` is quadratic inside the 16 KB cap. It costs about 80 ms or more per string in V8 and about 1 to 1.9 s per event with a crafted URL. Lower the cap, bound the header run, or scan linearly. Add an under-cap `eyJ` timing test.
2. **#151, should fix.** `docs/analytics-events.md` line 41 still says "each URL segment is decoded up to three times". It should now say "until stable, up to 8 passes; deeper is redacted whole". Also mention the IDN support.
3. **#151, should fix.** Document that `advanced_disable_flags` also turns off remote config, and check whether events now carry `$elements` instead of `$elements_chain`.
4. **#147, nit.** The docs do not mention the 16 KB cap (values longer than 16 KB are cut at a delimiter and end in `[redacted]`).
5. **Follow-up issue, pre-existing.** `@2x.png`-style asset names are redacted as emails.
