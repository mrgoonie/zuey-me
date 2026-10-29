# Review: PR #140 fix(analytics): redact percent-encoded emails in referrers and URLs

Closes #135 (P1 privacy). Head `863abb7`, reviewed with the latest `origin/main` (incl. #134) merged locally. The merge was clean.

## Verdict: APPROVE

The fix closes the leak described in #135. No bypass I found leaks an email in realistic traffic. The findings below are a pre-existing performance issue that the PR makes up to 2x worse, plus contrived or cosmetic cases. They suit follow-up issues and do not need to block this PR.

## Gates

| Check | Result |
| --- | --- |
| New tests against `origin/main`'s `pii.ts` | 17 fail / 2 pass (the fix is what makes them pass) |
| New tests with the PR's `pii.ts` | 19 pass / 0 fail |
| `bun test` (PR merged with main) | 1006 pass / 0 fail, 55 files |
| `bun run build` | astro check 0 errors, 0 warnings (65 existing hints); build complete |
| `any` / unchecked casts in `pii.ts` | none |

## Wiring

`postHogInitOptions` sets `before_send: scrubCaptureResult` (`src/lib/analytics/destinations/posthog.ts:186`). posthog-js runs `before_send` on every capture, which covers `$pageview`, `$pageleave`, `$autocapture` (enabled except on sensitive paths) and `$identify`. `scrubCaptureResult` deep-scrubs `properties`, `$set` and `$set_once` (`posthog.ts:142`). `containsPii` also guards taxonomy validation (`events.ts:291`), `identify` ids (`identity.ts:23`) and UTM values (`attribution.ts:32`). The probe confirmed that encoded emails are redacted in `$set.email`, `$set.$initial_referrer`, `$set_once.$initial_current_url` and nested arrays/objects.

## Bypass probe (scrubValue on example.com addresses)

Redacted: `%40`; double (`%2540`) and triple (`%252540`) encoding; upper case; `+` and `%2B` in the local part; `+` or `%20` separators; emails in the path, the fragment, `%3D`-joined or `%2F`-joined values, and protocol-relative URLs; `mailto:`; free text; punycode domains; encoded non-ASCII local parts; the re-serialisation after a `token=` param is removed; autocapture `$elements_chain` hrefs. Userinfo (`https://jane%40example.com:pw@host/`) is stripped completely.

Unchanged, as they should be: UTM URLs, normal paths and fragments, `100%25+free`, encoded Vietnamese text in queries and paths (`h%E1%BB%8Dc%20m%C3%A1y`, `/xin-ch%C3%A0o`), and `a%2Fb%3Fc`.

Not redacted (all contrived, or not valid email syntax): quadruple encoding; `%u0040`; full-width `＠`; HTML entities (`&#64;`); base64 values; an email split across two params; `%0A` inside the domain; quoted local parts; IP-literal domains; Unicode (IDN) domains, see L1.

## Findings (by severity)

### Medium

**M1. EMAIL_RE backtracks quadratically, and the PR runs it twice per `%` segment.** `src/lib/analytics/pii.ts:17`, reused at `pii.ts:111` and `pii.ts:117`.
The regex's unbounded `[...]+@` is retried from every start position, so time grows with the square of the length. Timings in bun with `scrubValue`:

| Input | main | head |
| --- | --- | --- |
| 100 KB `a` | 2087 ms | 2074 ms |
| 100 KB URL `?q=a%40aaaa…` | 2162 ms | 4376 ms |
| 20 KB | 77 ms | 77 ms |
| 8 KB URL | 14 ms | 13 ms |

The 1 MB input took 211 s. `before_send` runs on the main thread for every event. Someone could freeze a visitor's tab by sending them a link with a very long query string, and the stall would repeat on the `$pageview`, `$pageleave` and each autocapture event. Real URLs (8 KB or less) are unaffected. The problem exists on main; this PR doubles the worst case.
Fix (follow-up issue): bound the quantifiers, e.g. `/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g`. That runs the same 100 KB input in 3 ms. Optionally cap the length of a string before scrubbing.

### Low

**L1. Emails with a Unicode (IDN) domain are not matched, either literally or encoded.** `pii.ts:17`. Neither `jane@bücher.de` nor `jane%40b%C3%BCcher.de` is redacted, because the domain class only allows ASCII. The gap exists on main and such addresses are rare. Fix: allow `\p{L}` in the domain, or decode non-ASCII escapes before matching.

**L2. Encoding only up to 3 levels deep.** `pii.ts:73`. `%25252540` gets through `scrubUrl` and `containsPii`. That much encoding is contrived. Possible fix: keep decoding until nothing changes, capped at a larger limit.

**L3. Re-encoding changes other text in a segment that contains an email.** `pii.ts:92`. `?q=h%E1%BB%8Dc%20jane%40example.com` becomes `?q=h%25E1%25BB%258Dc%20[redacted]`: the non-ASCII escapes that were never decoded get double-encoded. Likewise, `mailto:jane%40…` becomes `mailto%3A[redacted]`. This only affects data quality; nothing leaks. Fix: re-encode only the characters that decoding produced, or skip `%XX` escapes that are already present.

**L4. Objects nested deeper than `MAX_DEPTH` are returned unscrubbed.** `pii.ts:200`. Objects nested more than 6 levels deep keep their raw strings. The gap exists on main, and none of PostHog's own properties nest that deep. A safer fallback would return `null`, or `[redacted]`, past the limit.

## Open question (outside this PR's scope, not verified)

posthog-js can send `person_properties` in its `/flags` (decide) request, and that request does not go through `before_send`. The project loads posthog-js from the CDN snippet, so I could not check the version locally. If flags stay unused, `advanced_disable_flags: true` would remove that path.

Status: DONE
Summary: APPROVE. The fix closes #135 and all gates are green (1006/0 tests, 0 errors and 0 warnings in the build, new tests 17/19 fail on main). The only notable finding is a pre-existing quadratic EMAIL_RE that the PR runs twice per encoded segment, worth a follow-up issue.
