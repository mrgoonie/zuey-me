# Review: PR #271 (closes #254) and PR #278 (closes #265)

- Date: 2026-10-23 (Asia/Saigon)
- #271 head `9396475`, branched from `a635281`. #278 head `29f9d4e`, branched from `ed22e21`. `main` is `1c571be`.
- Line numbers below refer to the merged tree (`main` + #271 + #278) unless a PR is named.

## Verdicts

| PR | Verdict | Blockers / majors |
| --- | --- | --- |
| #271 | APPROVE | none |
| #278 | APPROVE | none (2 minors, 3 nits) |

## Gates

Fresh worktrees were created under `.claude/worktrees/review-271-278` (`main`, `pr-271`, `pr-278`, `combined`), and `bun install` was run in each.

| Tree | `bun test` | `bun run build` |
| --- | --- | --- |
| #271 | 1766 pass, 0 fail (107 files) | astro check 0 errors, 0 warnings; complete |
| #278 | 1787 pass, 0 fail (108 files) | astro check 0 errors, 0 warnings; complete |
| `main` + #271 + #278 | 1815 pass, 0 fail (109 files) | astro check 0 errors, 0 warnings (902 files); complete |

- **Merge compatibility.** `git merge-tree --write-tree pr-271 pr-278` is clean. A real merge of both onto `main` auto-merged without conflicts.
- **The machine was heavily loaded.** About 40 CPU-bound `bun -e` processes from another session were running. Those, and the bare `bun test` runs I saw, are not mine, and I left them alone.
  - A `main` baseline `bun test` hit an error under that load; I stopped my second baseline run.
  - The merged tree is a superset of `main` and is green, so this does not affect the verdicts.
- **Timing caveat.** The absolute timings below may run high because of the load. The comparisons were made on the same machine at the same time.

## #271: single-pass URL scrubber

### Byte-identical output

**Corpus:** 45,797 URLs. Each was run through `scrubUrl`, and through `scrubValue` as `$current_url` and as an `$elements_chain` `attr__href`, giving 91,594 outputs per tree. The corpus is the cross product of:

- **Hosts:** `zuey.me`, `www.zuey.me`, the trailing-dot `zuey.me.`, `ZUEY.ME:443`, `http:…:8080`, another site, Google, and relative URLs.
- **Paths:** `/`, `/articles`, `/articles/page/2`, the private `/chat`, `/billing/ZMABCD2345`, `/booking/x1`, a course page, and an encoded path.
- **52 queries:**
  - Encoded keys: `%71`, `tok%65n`, `%74oken`, `q%5B%5D`.
  - Duplicate keys: `a=1&a=2`, `token=1&token=2`, `q=jane&q=doe`.
  - Empty values and names: `?`, `?a`, `?a=`, `?=`, `?=x`, `?&&`, `token=`.
  - `+` versus `%20`, `%2B`, `%zz`, raw and encoded `ọ`, `;`, `==`, `'`, `%26`, `%3D`, `%23`, `%0A`, tab, and a leading space.
  - Email, password, `api_key`, `sig`, PayPal and OAuth parameters, and nested `redirect`/`next` URLs.
  - One URL with 50 sensitive names.
- **12 fragments:** empty, `#`, `#x`, `#a=1`, `#token=1`, `#/x?token=1`, `#q=jane`, `+` in a fragment, duplicates, and others.
- **Extras:** protocol-relative, scheme-less, `mailto:` and `tel:` URLs.

**Result:**

- `main` vs #271 gives **0 differences**, in both bun (JSC) and node 24 (V8).
- #278 vs the merged tree also gives 0 differences, so #271 changes nothing on top of #278.
- The corpus does exercise removal. The 578 outputs that still contain `token=` are the same in both trees: they are `;token=`, `#/x?token=` and nested encoded values, which `main` keeps too.

**Why the output is identical** (`pii.ts:447-480`):

- When nothing is removed, `keptParams` returns `null` and the URL is left untouched, so the raw `%20` and other encodings survive.
- When something is removed:
  - The old code's `searchParams.delete` re-serialised the whole query as form-urlencoded.
  - The new code writes `new URLSearchParams(kept).toString()` into `parsed.search`.
  - That serialisation contains only characters the `search` setter leaves unchanged.
  - An empty result sets a null query in both versions, so no trailing `?` is left.
- The fragment path is unchanged.

### Linearity

`scrubUrl` on 16 KB URLs, median in V8:

| Input | `main` | #271 / merged tree |
| --- | --- | --- |
| about 3000 distinct sensitive names | 51.5 ms | 0.25 ms |
| alternating sensitive and plain names | 57.4 ms | 0.79 ms |
| empty sensitive values | 58.0 ms | 0.15 ms |
| encoded sensitive keys | 52.8 ms | 0.44 ms |
| `q=a` repeated on `zuey.me` | 16.8 ms | 0.28 ms |
| distinct names in the fragment | 6.0 ms | 0.27 ms |
| plain distinct names (nothing removed) | 1.5 ms | 1.2 ms |

- **Scaling:** at 4, 8 and 16 KB, `main` takes 4.8, 15.4 and 65.3 ms (quadratic). #271 takes 0.04, 0.08 and 0.14 ms (linear).
- **Whole event:** a capture with 12 such URL properties dropped from 24.2 ms to 0.2 ms.

### Findings

- None. The new test (`tests/analytics-encoded-pii.test.ts`) bounds the number of mutations instead of the wall-clock time, which is the right call for CI.

## #278: the six #257 follow-ups

### Item by item

**1. `+` after a word is a space** (`pii.ts:245`).

- `q=zuey+123456789` is kept now.
- `q=zuey+0901234567` becomes `q=zuey+[redacted]`, and `msg=call+0901234567` becomes `msg=call+[redacted]`.
- `tel:+84…`, `to=+84…`, `Zalo:+84 90 123 4567.` and `x +84 90 123 4567` are still redacted.
- `charBefore` handles surrogate pairs: `😀+84901234567` is redacted.
- **The author's call (keep the `+`) is right for URL queries.** But the rule also runs in free text and in percent-decoded segments, where a `+` is a real plus. See the minor finding below.

**2. Plain-space North American triples are kept** (`pii.ts:208`).

- Kept: `256 384 1024`, `300 250 1920` (also with no-break spaces), SVG `M 415 555 2671 Z` and `415 555 2671`.
- Redacted: `(415) 555-2671`, `(415) 555 2671`, `415-555-2671`, `415.555.2671`, `415 - 555 - 2671` and `+1 415 555 2671`.
- **The author's call is accepted.** The audience is Vietnamese, plain-space US numbers are rare in this site's data, and the `+1` form still matches.

**3. Formats that were missed are now redacted.**

- Now redacted: `84901234567`, `842838221234`, `wa.me/84…`, `?phone=84…`, `+84 (0) 90 123 4567`, `+84 (0)90…`, `+44 (0)20 7183 8750`, `+84 (0) 0901 234 567`, U+00A0 and U+202F separators, and `0901 - 234 - 567` / `0901 . 234 . 567`.
- **`84 901 234 567` is kept on purpose. Accepted:** its 2-3-3-3 grouping is the exact shape of an 84-billion VND amount written with thousands separators.
  - A follow-up could still redact `84 90 123 4567`, whose 2-2-3-4 grouping is not an amount shape; today it is kept.
- **Still kept** (nits from #257, unchanged): `0084 …`, `0901/234/567`, glued text (`sdt0901234567`), `+84 (0)(0)…` and `+84 (0) 9 0123 4567`.
- **The `(0)` trunk rule** (`pii.ts:266`) applies only to the second group after a `+`, when it is `(0)` exactly, so it cannot widen any other window.

**4. Per-event cache** (`pii.ts:511-523`, `posthog.ts:197`).

- **Correct.** It is keyed by the exact input string, and `scrubString` depends only on that string.
  - Host, private path and own-site checks all come from the string itself.
  - Title blanking and exception hardening run after scrubbing, from the raw `$current_url`.
- **No leakage between events.** `scrubCaptureResult` creates a new `Map` for each call. A top-level `scrubValue` without a cache gets a fresh default `Map` each time.
- **Probe:**
  - Two consecutive events with different tokens and phone numbers each come out correct.
  - Strings that differ only by a trailing space or by `HTTPS`/`Token` case are scrubbed independently and correctly.
  - An object shared by reference in two properties is scrubbed in both, and the input is not mutated.
- **Cost:** a crafted 16 KB URL in 12 properties plus `$set` now takes 0.7 to 2.6 ms per event, against 3.7 to 24 ms on `main`.

**5. Docs** (`docs/analytics-events.md:48`). The `$exception` sentence now reads correctly: "on private pages …, and on any page while the Zuey AI panel is mounted or the lesson AI tutor … is open or still answering". The phone-format and per-event notes match the code.

**6. Tutor streaming tests** (`tests/lesson-tutor-analytics-dom.test.ts`).

- One test closes the tutor while the answer streams: the message text stays redacted until `done`, then returns.
- One test unmounts mid-stream: the fetch signal is aborted, and the counter is released.
- Both use a held `ReadableStream`, which is a sound way to keep the stream open.

### Real analytics data (sweep re-run on the merged tree)

**These values are not flagged and are left unchanged:**

- **Order and other codes:** order codes (`ZM…`, `ZC-…`, `ZMC-0901234567`, booking codes), `cor_`, `mem_`, `rev_`, `link-…`.
- **Amounts:** `1.290.000 ₫`, `1 290 000 VND`, `1.290.000.000`, `2 290 000 000`, `9990000000`, `84 901 234 567 ₫`, `84.901.234.567 đ` and the 14-digit `84901234567000`.
- **Timestamps and dates:** Unix seconds and milliseconds, ISO dates and date-times, `2026 - 10 - 23` and `10:00 - 11:30`.
- **Telegram ids:** `-100…`, `5123456789` and `84123456789` (10 digits).
- **UUIDs and ids:** UUIDv7, all-digit UUIDs and YouTube ids.
- **Other:** UTM values, versions and IP addresses.

**Events:**

- These pass validation: `subscription_*` `period_end` (both formats), `purchase` (with a numeric `amount` of 84901234567), `link_clicked` with live link data and a `wa.me` URL (redacted, event kept), `knowledge_filter_applied`, `read_source_clicked` and `explore_clicked`.
- `isValidDistinctId` is true for UUIDs and `mem_…`. It is false for `84901234567`, which is correct now that this is a phone number.

**No legitimate value is dropped or redacted.**

### Performance

Per string, 16 KB, measured separately in V8, median of 21:

- **`scrubValue`:** at most 2.0 ms, against 1.5 ms on `main`.
- **`containsPii`:** at most 2.3 ms, against 1.8 ms on `main`.
- **Worst shapes:** `12 `, `99 `, `12%2B` and `%2B1%20`.

**Linear:** `12 - ` costs 0.29, 0.43 and 0.81 ms at 4, 8 and 16 KB. The new separator alternation (`pii.ts:165`) always needs a `[.-]` or one space, followed by a digit. There is no nested ambiguity, so no ReDoS. Everything is within the 5 ms budget.

### Findings

**minor**, `pii.ts:245`. The "`+` after a word is a space" rule runs everywhere, not only in raw URL queries. That opens two regressions compared with #257 and `main`:

- **Percent-decoded segments.** `%2B` is a literal plus, never a space, but after decoding it is treated as one.
  - `https://zuey.me/?msg=Call%2B442071838750` is now kept. It was redacted before.
  - `x%2B84901234567` is still redacted, but only because the Vietnamese rule catches it.
- **Free text** (`$el_text`, exception messages): `SĐT+84 90 123 4567` and `call+442071838750` are now kept. They were redacted before.
- **Impact:** only a number glued to a word, and only a non-Vietnamese number or a spaced `+84`. That is rare, but it is a leak regression.
- **Fix:**
  - In `redactEncodedEmails` (`pii.ts:405`), turn raw `+` into a space before decoding, so any `+` left after decoding is a real plus. Then skip the `plusSpace` rule for decoded text.
  - Apply `plusSpace` only when scrubbing URL query or fragment text.

**minor**, test gap, `tests/analytics-phone-numbers.test.ts`. Nothing pins the `%2B`-after-a-word case or a free-text `SĐT+84 …`, so the regression above passes CI.

**nit**, `pii.ts` encoded pass. `?a=x%2B84901234567` becomes `?a=x+[redacted]`. The re-encoded segment emits a raw `+`, which in a query means a space, so the encoding is not preserved. This is cosmetic.

**nit**, `pii.ts:165-167`. The separator classes contain literal U+00A0 and U+202F characters, which look like plain spaces in review. `[   ]` would be clearer.

**nit**, `pii.ts:534`. `scrubValue`'s positional `depth` argument moved to third place, after `cache`. Only internal callers exist, and the build type-checks, but any external `scrubValue(x, n)` call would now pass a number as the cache.

## Cleanup

- Removed the `review-271-278` worktrees (`main`, `pr-271`, `pr-278`, `combined`) with their `node_modules` and `dist/`, and the local `pr-271` and `pr-278` refs.
- The probe and corpus scripts lived only in the session scratchpad and were deleted.
- No `.wrangler/` was left behind.
- Nothing was pushed, commented on or merged on GitHub.

Status: DONE
Summary: #271 APPROVE: output is byte-identical to main over 91,594 outputs in bun and V8, and the scrubber is now linear (about 65 ms down to 0.14 ms at 16 KB). #278 APPROVE: all six items are done, the author's calls are accepted and no real analytics data is dropped. Its two minors are the "`+` after a word is a space" rule also applying to decoded `%2B` and to free text (a small leak regression: `Call%2B4420…`, `SĐT+84 90…`), and no test covering it.
