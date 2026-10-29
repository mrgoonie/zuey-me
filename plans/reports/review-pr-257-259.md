# Review: PR #257 (closes #248) and PR #259 (closes #249)

- Date: 2026-10-23 (Asia/Saigon)
- #257 head `ac74279`, branched from `b13aa28`. #259 head `a5c698e`, branched from `60328c4` (current `main`).
- Constraints from `review-pr-147-151.md` and `review-pr-242-244-247.md`: a linear scrubber, under about 5 ms per 16 KB string in V8, and the 16 KB `MAX_SCRUB_LENGTH` cap.

## Verdicts

| PR | Verdict | Blockers / majors |
| --- | --- | --- |
| #257 | APPROVE | none (4 minors, 5 nits) |
| #259 | APPROVE | none (2 nits) |

## Gates

Each head was checked out in its own worktree under `.claude/worktrees/review-257-259`, and `bun install` was run first.

| Tree | `bun test` | `bun run build` |
| --- | --- | --- |
| #257 | 1676 pass, 0 fail (102 files) | complete |
| #259 | 1692 pass, 0 fail (103 files) | complete |
| #259 + #257 merged | 1703 pass, 0 fail (104 files) | astro check 0 errors, 0 warnings (892 files); complete |

- **Merge compatibility.** `git merge-tree --write-tree pr-257 pr-259` is clean. A real merge auto-merged `docs/analytics-events.md`, and both doc edits survive in it.
- **The new tests fail without the fixes.**
  - `analytics-phone-numbers.test.ts` fails when run against `main`'s `pii.ts`.
  - `lesson-tutor-analytics-dom.test.ts` fails when run against `main`'s `LessonTutor.tsx`.

## #257: phone numbers

### False positives that could drop or damage real analytics data

**Where a hit causes harm.**

- `containsPii` rejects a whole event only for `string` and `url` taxonomy properties (`events.ts:375`). `number` properties are never checked.
  - So amounts (`amount`, `value`), counts, durations, `months`, `reading_minutes`, `position` and latencies cannot be dropped.
- The only other callers are:
  - `isValidDistinctId`: `identity.ts:23`, after `DISTINCT_ID_RE`.
  - UTM values: `attribution.ts:32`, after `^[a-z0-9._-]{1,64}$` and a check against runs of 8 or more digits.
  - Engagement slugs and hosts: `engagement.ts:15/29`, which already reject runs of 8 or more digits.

**Every string property in the taxonomy**, and why each one is safe:

- **Enum-like values:** `section`, `platform`, `language`, `action`, `source`, `surface`, `filter`, `access`, `locale`, `stage`, `kind`, `reason` (`failureReason`), `method`, `provider`, `order_type`, `plan`, `preselected_plan`, `course`, `currency`, `app`, `feature`, `payment_method`, `source_kind`, `owner`, `trigger`.
  - `chat` is `'en' | 'vi'`, not a Telegram id.
  - None of these can hold a phone shape.
- **`period_end`:** an ISO timestamp. Both `2026-11-23T05:00:00.000Z` and `2026-11-23 05:00:00` pass validation.
- **`link_clicked`:** `id` is a value like `link-05u5710` or `prod-agentkit`.
  - I read every live link with the site MCP `list_links`. No title or URL holds a phone number.
  - A future link titled `Zalo 0901 234 567` would drop the event. That outcome is correct.
  - A `zalo.me/0901234567` URL is a `url` property, so the number is redacted and the event is kept.
- **`slug`, `youtube_id`, `value`, `domain` and `target` (url):**
  - A slug or host glued to letters or joiners is skipped.
  - A YouTube id of exactly `-0[35789]` followed by 8 digits would drop `command_palette_video`. The probability is negligible (nit).

**Probe values that stay intact** (`containsPii` returns false and `redactString` leaves them unchanged):

- **Order codes and ids:**
  - SePay codes use `SEPAY_*_PREFIX` plus `randomCode(8)` (`runtime.ts:46`). Its alphabet has no `0` or `1`, so it can never produce a `0x…` number.
  - Booking codes (`booking/store.ts:155`), `ZC-…` certificates, `ZMC-0901234567`, `cor_…`, `mem_…` and `rev_…` are also kept.
- **Amounts:** `1000000`, `199.000`, `1.290.000 ₫`, `1 290 000 VND`, `129.000.000`, `1.290.000.000`, `2 290 000 000`, `9990000000`, `$1,234.56` and negative amounts.
- **Timestamps and dates:**
  - Unix timestamps of 10 and 13 digits, in a URL too (`?t=1729650000000`).
  - ISO dates and date-times, `+07:00`, `UTC+7`, `dd/mm/yyyy` and `00:09:01`.
- **Telegram ids:** `-1001234567890`, `-100123456789`, `5123456789` and `tg:-100…`.
- **UUIDs and PostHog ids:**
  - UUIDv7 values pass, including all-digit UUIDs such as `01928374-5566-7788-9900-112233445566` and `09123456-7890-…`.
  - `isValidDistinctId` stays true for UUIDs and `mem_0901234567abcd`.
- **Other values:** UTM values (`spring_sale_2026`, `sale_0901`), IP addresses, versions, slugs (`top-10-2024`, `lesson-03-intro`) and `0901234567.png`.

### Findings

**minor**, `src/lib/analytics/pii.ts:225` and `pii.ts:192`. A `+` counts as an E.164 plus even when a word comes right before it, because `gluedBefore` is skipped when the run starts with `+`.

- In a query string, `+` means a space. So a URL is redacted even though the same text with a real space is kept.
- Probe:
  - `https://www.google.com/search?q=zuey+123456789+review` becomes `q=zuey[redacted]+review`.
  - `?m=Order+123456789` becomes `Order[redacted]`.
  - A base64 value such as `IwAR2abc+123456789/` becomes `IwAR2abc[redacted]/`.
  - In contrast, `zuey 123456789` is kept.
- **Impact:** redaction only. No taxonomy property can carry a `+` after a word. UTM values reject `+`.
- **Fix:** treat `+` as a plus only when it is not preceded by a letter or digit. `call+0901234567` is still caught by the VN rule.

**minor**, `pii.ts:195`. North American numbers written as three space-separated groups catch ordinary number triples.

- Probe:
  - `256 384 1024` becomes `[redacted]`.
  - `width 300 250 1920` becomes `width [redacted]`.
  - `M 415 555 2671 Z` (SVG path data) becomes `M [redacted] Z`.
  - `415 555 1234` becomes `[redacted]`.
- **Impact:**
  - This reaches `$elements_chain`, `$el_text`, `attr__d` and `attr__viewBox` of clicked SVG icons, and exception text.
  - It never drops a taxonomy event.
  - VND amounts are safe, because they always come in groups of three digits.
- **Fix:** accept North American numbers only with `(…)`, `-` or `.` separators, or after a `+1`.

**minor**, `pii.ts:164-172`. Some common Vietnamese and international phone shapes still leak.

| Input | Result |
| --- | --- |
| `84901234567` and `84 90 123 4567` | kept |
| `0084 90 123 4567` | kept |
| `+84 (0) 90 123 4567`, `+84 (0)90 123 4567` | kept: the `(0)` trunk group has one digit, so the window stops |
| `0901 234 567` (NBSP) and ` ` (narrow NBSP) | kept: the separator class is only `[ .-]` |
| `0901 - 234 - 567`, `0901/234/567` | kept |

- `84…` without a plus is the format of `wa.me/` links. The PR lists "bare `84…`" as kept on purpose.
- An 11-digit `84[35789]\d{8}` or `842\d{9}` cannot collide with 10- or 13-digit timestamps. I would add it.
- NBSP is common in rendered `$el_text`. Add ` ` and ` ` to the separators.

**minor**, informational. The worst case per string is within budget, but the cost per event rose.

- **Per string:** in 32 adversarial 16 KB shapes, a `scrubValue` plus `containsPii` call costs at most 3.6 ms in bun and 3.1 ms in node 24 (V8). The worst shapes are `12 `, `99 `, `12%2B` and `%2B1%20`.
- **Scaling is linear:** `12 ` costs 0.31, 0.62 and 1.21 ms at 4, 8 and 16 KB.
- **No ReDoS:** `PHONE_RUN_RE` has one separator per group and no nested quantifier on the same characters, and each window is capped at 15 digits.
- **Per event:** a crafted 16 KB URL copied into 12 properties now costs 12 to 18 ms per event in V8. `main` costs 0.1 to 3.3 ms.
  - That is acceptable, since the earlier reviews rejected about 1 s and accepted about 20 ms.
  - It is worth knowing if more patterns are added.

**nit**, `pii.ts:181` (`touchesWord`). Numbers glued to letters, `_` or a joiner are kept by design. Examples:

- `sdt0901234567`, `call0901234567`, `0901234567nhé`, `0901234567x`, `phone_0901234567`, `a-0901234567` and `0901_234_567`.
- Visitors usually type a space, so this is the documented trade-off for order codes, hashes and file names.

**nit**, `pii.ts:170`. These shapes are not matched:

- Pre-2018 11-digit mobiles (`01234567890`, `0123 456 7890`).
- Full-width digits (`０９０１…`).
- `+84 9 0123 4567` and `0 901 234 567`.

**nit**, `pii.ts:164`. `(+84)901234567` becomes `([redacted]`. The opening parenthesis is left behind, which is cosmetic only.

**nit.** Vietnamese company tax codes (`0312345678`) are redacted. They cannot be told apart from Viettel `03…` mobile numbers, so this is acceptable.

**nit.** `-0901234567` and `#0901234567` are redacted. The PR's false-positive list implies that `#1234`-style ids are kept, but a 10-digit `0[35789]` id is treated as a phone number. That is the right call; I mention it only because the YouTube-id case above follows from it.

**URL paths, queries and fragments are covered**, all redacted:

- `/x/0901234567`, `?ref=0901234567`, `#0901234567` and `tel:+84…`.
- `?phone=%2B84%20901…`, and a triple-encoded `%25%32%42…`.

## #259: lesson AI tutor

**ph-no-capture coverage.**

- The `ph-no-capture` class sits on the root `<section>` (`src/components/courses/LessonTutor.tsx:101`). Everything the tutor renders is inside it: toggle, panel, transcript `<ol>`, alert, form, textarea, and the "Hỏi" and "Dừng" buttons.
- The component uses no portals, and `src` has no `createPortal`, so nothing is rendered outside the root.
- The `<astro-island>` wrapper (`src/pages/courses/[slug]/[lesson].astro:177`) sits outside the root. Its `props` attribute holds only `courseSlug`, `lessonSlug`, `lessonTitle` and `signedIn`, none of which are private. Clicks inside the section are skipped whole, so the wrapper never appears in an element chain.
- `capture_copied_text`, heatmaps and session replay are off. Heatmaps and dead clicks stay off because remote config is disabled.

**The counter is balanced.**

- `useEffect(() => (sensitive ? enterSensitiveSurface() : undefined), [sensitive])` (`LessonTutor.tsx:34-35`) handles every case:
  - **Opening** enters the counter.
  - **Closing while idle** leaves it.
  - **Closing while busy** holds it until `finally { setBusy(false) }` (`LessonTutor.tsx:95`).
  - **Unmounting** always runs the cleanup.
- StrictMode's mount, cleanup, mount sequence leaves the counter at 1, and the cleanup is idempotent (`posthog.ts:133-140`).
- **No stuck state is possible.**
  - `ensureSession` at line 53 is outside the `try`, but `callApi` never throws (`member-ui.ts:88-101`), and `sessionStorage` access is wrapped.
  - Errors from `fetch`, `readSse` and `res.json()` are caught, and `finally` always clears `busy`.
  - **Abort** happens through "Dừng" or the unmount abort at line 30. It lands in `catch`, then `finally`.
  - **Unmounting mid-stream** releases the counter through the effect cleanup. The later `setBusy` call on the unmounted component does nothing.

**The chunk is shared.**

- In the built #259 tree, `hardenExceptionProperties`, `before_send` and the counter exist only in `dist/_astro/posthog.DxymxKAo.js`.
- These chunks all import that chunk:
  - `LessonTutor.CQMWWFD3.js`
  - `ZueyAiPanel.ruo5LsgV.js`
  - the `Layout.astro` boot script, which sets `before_send`
  - `client.B9h5NkrB.js`
- So everything uses one `openSensitiveSurfaces` counter.

### Findings

- **nit**, `docs/analytics-events.md:47`. The edit dropped the "and" after the private-page list. The sentence now reads "On private pages (…) while the Zuey AI panel is mounted on any page, and while the lesson AI tutor …", which says the panel rule applies only on private pages. Restore it as "On private pages (…), while the Zuey AI panel is mounted on any page, and while …".
- **nit**, `tests/lesson-tutor-analytics-dom.test.ts:81-137`. The test covers open, close when idle, and unmount. It does not cover the two branches the PR description highlights:
  - Closing while an answer is still streaming (the message text should stay redacted until the stream ends).
  - Unmounting mid-stream (the counter should be released).
  - The code is correct by reading; a slow SSE stub would pin it.

## Cleanup

- Removed the `review-257-259` worktrees (`pr-257`, `pr-259`, `combined`) with their `node_modules` and `dist/`, and the local `pr-257` and `pr-259` refs.
- The probe scripts lived only in the session scratchpad and were deleted.
- No `.wrangler/` was left behind.
- Nothing was pushed or commented on GitHub.

Status: DONE
Summary: #257 APPROVE, #259 APPROVE, with no blockers or majors. #257 has four minors: `word+digits` is treated as E.164, plain number triples are read as North American numbers, `84…`, `(0)` trunk and NBSP shapes leak, and a crafted event costs about 15 ms in V8. #259 has two nits (a docs sentence and missing streaming-close tests). Both heads and their merge are green: 1703 tests pass with 0 failures, and the build has 0 errors and 0 warnings.
