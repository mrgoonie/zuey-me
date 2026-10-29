# Review: PR #260, auto-start interactive widgets near the viewport (closes #197)

- Reviewer: isolated reviewer agent (did not write this code)
- Date: 2026-10-23 (Asia/Saigon)
- Head reviewed: `45afdb1` (one commit on `60328c4` = current `origin/main`)
- Worktree: `D:\www\zuey\zuey-me\.claude\worktrees\review-260` (removed after review)

## Verdict

**Approve with changes requested: no blockers, 2 majors.**

The core mechanism is small and correct. Auto-start reuses the click `run()` path, so the iframe, CSP, broker and watchdog are byte-for-byte the same. The wiring is opt-in with a default of `false`, observers and queued starts are cleaned up, and paywalled widgets never reach the client.

There are two gaps against #197's own Definition of Done:

1. Reduced motion / WCAG 2.2.2. Auto-started widgets have no way to be stopped, and `prefers-reduced-motion` is ignored.
2. The widget smoke tool. Its count is now viewport-dependent and mixes widgets with embeds, and its byte-exact screenshot baseline is no longer deterministic.

Both are cheap to fix in this PR.

## Verification run

| Check | Result |
| --- | --- |
| `bun install` | ok (744 packages) |
| `bun test` | **1712 pass, 0 fail**, 103 files (109 s) |
| `bun run build` | **0 errors, 0 warnings**, 70 hints (all pre-existing hints in tests); `[build] Complete!` |
| Contract surfaces | No change to the block schema, OpenAPI or MCP. The diff only touches components, two pages, docs and tests. |

## Findings

### MAJOR 1: auto-started widgets ignore `prefers-reduced-motion` and cannot be stopped

**Where**
- `src/components/ai/InteractiveFrame.tsx:156-171` (the auto-start effect)
- `src/components/ai/InteractiveFrame.tsx:178-182` (the action buttons: only Run and Reload)

**Evidence**
- The auto-start effect has no `matchMedia('(prefers-reduced-motion: reduce)')` check. A grep for `reduced-motion` across `src/components/ai/` and `src/components/blocks/` finds only CSS in unrelated components.
- Once running, the header offers only **Reload** (`t.reload`), which restarts the widget. There is no Stop or Pause.
- Before this PR, the reader's click was the consent to start moving content. Now an animated widget (canvas loop, CSS animation, ticking chart) starts by itself and runs until the page is left.

**Why it matters**
- #197's DoD says: "`prefers-reduced-motion` and keyboard/focus controls remain usable".
- WCAG 2.2.2 (Pause, Stop, Hide, Level A) requires a pause or stop mechanism for content that moves automatically for more than 5 s.

**Recommendation** (two small changes)
- When `matchMedia('(prefers-reduced-motion: reduce)').matches`, skip the auto-start: no observer, so the widget stays click-to-run. The frame's own CSS can still read the media query, but most authored JS never does.
- While `state === 'running'`, add a **Stop** button that sets `state` back to `'idle'`. This unmounts the iframe, and the auto-start must not re-arm afterwards: keep a `stoppedByReader` ref.
- Add tests for both.

### MAJOR 2: `scripts/article-widget-smoke.mjs` no longer measures widgets reliably

The author asked whether the script now undercounts. It does, and it has two more problems.

**Where**
- `scripts/article-widget-smoke.mjs:62` (`goto` with `waitUntil: 'networkidle'`)
- `scripts/article-widget-smoke.mjs:68` (the frame count)
- `scripts/article-widget-smoke.mjs:72` (the full-page screenshot)
- `docs/agent-article-playbook.md:91-98` (the documented usage)

**Undercount: confirmed, but not a count regression**
- Before this PR, widgets were click-to-run and the script never clicks, so widget frames were always 0.
- After it, only widgets within the 844 or 800 px viewport plus the 200 px margin start before `networkidle`. Widgets below the fold never start, because the script never scrolls.
- So `--expect-widgets N` passes only when at least N frames start above the fold. For an article whose widgets sit lower down, it fails even though the reader page is correct.

**Overcount: pre-existing, and now more misleading**
- The selector `iframe[sandbox*="allow-scripts"]` also matches social embeds, which use `sandbox="allow-scripts allow-same-origin allow-popups …"` (`src/components/blocks/EmbedView.tsx:179`).
- Before this PR, `--expect-widgets 1` "passed" only when an embed was in view. That is the only way the documented command could ever have passed.
- Now the count mixes in-view widgets with in-view embeds.

**Screenshot determinism: a regression caused by this PR**
- The full-page screenshot is compared byte for byte with the baseline.
- With auto-start, the screenshot now contains:
  - running widget content: animations, clocks, data fetched through `zuey.fetch`;
  - placeholders whose new `min-height` changes the layout, so every stored baseline changes once.
- A Chromium full-page capture enlarges the viewport. That can fire the observers mid-capture, with starts staggered 150 ms apart, so how many frames appear in the image depends on timing.
- Before, the widget area was a static placeholder. Byte-exact baselines for pages with widgets are now flaky.

**Fix in this PR**
1. Count widget frames only, with `.zif iframe` or `iframe[sandbox="allow-scripts"]` (exact match). Count embeds separately if wanted.
2. Before counting, scroll the page in viewport steps, or call `scrollIntoView` on every `figure.zif`. Then wait until every `figure.zif` that is not inside a closed toggle has an iframe, with a timeout of about `count × 150 ms + 2 s`.
3. For the screenshot, either:
   - emulate `prefers-reduced-motion` and keep widgets idle (this works once MAJOR 1 lands), or
   - mask `.zif iframe` with `page.screenshot({ mask })` so the baseline covers the page chrome and not live widget pixels.
4. Update `docs/agent-article-playbook.md:91-98` to match.

### MINOR 1: no per-page cap on running auto-started frames (mobile memory and CPU)

**Where**
- `src/components/ai/frame-start-queue.ts:134-155`
- `src/components/ai/InteractiveFrame.tsx:156-171`

**Evidence**
- The stagger bounds the *start rate* (one per 150 ms), not the *number running*.
- On an article with 20+ widgets, scrolling to the end ends up with 20+ live sandboxed documents. Each one has:
  - its own 1 s heartbeat `setInterval` inside the frame;
  - a 2 s watchdog interval and a `message` listener in the parent;
  - a `ResizeObserver`.
- Frames are never unloaded when far off-screen. That is by design: "keep state when scrolling away and back".
- Chromium throttles `requestAnimationFrame` in off-screen cross-origin frames, but `setInterval`/`setTimeout` loops are not paused. On low-end Android, memory pressure can kill the tab.

**Why the watchdog is not enough**
- It only detects a frame that stops posting. A CPU-heavy loop that yields (`setTimeout(work, 0)`, a "miner") keeps its heartbeat alive and is never halted.
- A non-yielding loop (`while(true){}`) is worse in engines that run the opaque-origin srcdoc frame in the parent's process and thread: Safari/iOS and Android Chrome without full site isolation. It freezes the reader page itself, and the parent watchdog cannot run either.
- This is not new: a click had the same effect. But before, the reader chose to run the widget. Now an authoring mistake bricks the published page for every reader on those engines as soon as they scroll near the widget.

**Recommendation**
- Cap automatic starts per page at about 6. Beyond that, keep click-to-run and show a short "start" hint.
- Optionally, cap concurrently running auto-started frames on coarse-pointer devices.
- Out of scope for a cap, but worth a follow-up issue: a publish-time smoke (MAJOR 2) that loads each widget headless and fails on a long task over 1 s.

### MINOR 2: auto-run makes third-party requests that the embed opt-out does not cover

**Where**
- `src/lib/ai/sandbox-doc.ts:13-14` (`img-src data: https:; media-src data: https:`)
- `docs/agent-article-playbook.md:86-89`

**Evidence**
- Widget HTML may load any `https:` image or media, and a widget may navigate its own frame.
- This is spec behaviour, not checked in a browser: `sandbox` without `allow-top-navigation` still allows the frame to navigate *itself* (`location.href = 'https://…'`, `<meta http-equiv=refresh>`), and the CSP has no navigation directive.
- The navigated document carries no CSP, so it has unrestricted network access, and it can still post to the parent from the same `contentWindow`.
- All of this existed behind a click. Now it happens on scroll, for every reader, including readers who saved `zuey:embeds=click`.
- #197 DoD says: "Third-party URLs are **not requested** … after an explicit click-only preference".
- The PR evidence ("0 third-party requests with `zuey:embeds=click`") holds only because the seeded widgets load nothing external.

**Recommendation**
- Either (a) treat `zuey:embeds=click` as also covering widget auto-start, which is one `readEmbedPref()` check in the effect, or (b) state explicitly in the playbook that widgets may contact third-party image or media hosts and are not covered by the embed preference.
- File a separate hardening issue for frame self-navigation: for example, detect a second `load` event on the iframe and halt.
- Content is admin-authored, so this is minor rather than major.

### MINOR 3: the anonymous proxy budget is consumed without a gesture

**Where**
- `src/pages/api/v1/sandbox/fetch.ts`
- `src/lib/ai/sandbox-proxy.ts:23-24` (`SANDBOX_RATE_LIMIT_ANON = 20` per minute per IP; `MEMBER = 60`)

**Evidence**
- A single widget may use 50 requests per run (`MAX_FETCHES_PER_RUN`), which is more than the anonymous budget of 20 per minute.
- With auto-run, two or three data widgets on one page, or readers behind a shared NAT, hit 429 on page load.
- Before, a reader had to click each widget.
- JS-rendering crawlers (Googlebot renders with a very tall viewport) now auto-run every widget. That costs a D1 rate-limit write per request plus proxy egress.

**Recommendation**
- At minimum, document this in the playbook ("keep load-time fetches small").
- Consider skipping auto-start for user agents that identify as bots, or checking `navigator.webdriver`.

### MINOR 4: the "closed toggle" test does not test what its comment claims

**Where**
- `tests/interactive-autorun-dom.test.ts:245-268`

**Evidence**
- The comment says "A closed toggle body is not rendered". In fact React does render it: line 253 expects 4 observers, one of them for the closed-toggle widget.
- Not intersecting is a browser layout property of a closed `<details>`, and `FakeIntersectionObserver` cannot model it.
- The test fires the toggle widget's observer manually after setting `open`. It would pass just the same if the closed widget had been started before `open`.
- The real guarantee rests only on the author's Chromium check. Whether Safari reports a closed `<details>` child as non-intersecting with a positive `rootMargin` was not checked.

**Recommendation**
- Fix the comment.
- Either assert the toggle widget's observer exists and was *not* fired before `open`, or move this check into the browser smoke.

### NIT 1: layout shift when a widget halts or reports a smaller height

**Where**
- `src/components/ai/InteractiveFrame.tsx:203`

**Evidence**
- The placeholder reserves `min-height` only while `state === 'idle'`. In `'unresponsive'` it collapses to its content.
- A started widget that resizes itself smaller (the default height is 320) also shifts the content below it.
- This is minor CLS, and only after start.

**Recommendation**
- Keep `minHeight` for `'unresponsive'` too, or reserve `block.height` only when the author set it.

### NIT 2: a published lesson in a non-public course auto-runs for admins

**Where**
- `src/pages/courses/[slug]/[lesson].astro:168`

**Evidence**
- `lesson.status === 'published'` is checked, but `requireVisibleCourse(…, isAdmin)` lets an admin open a draft course. Its published lessons then auto-run.
- The content is the lesson's *published* JSON, so this is consistent with "published content auto-runs". Noting it only so it is a conscious choice.

### NIT 3: the queue gets stuck if its timer is dropped

**Where**
- `src/components/ai/frame-start-queue.ts:135,150`

**Evidence**
- The module-level `timer` is set to non-null before the timeout fires. If that timeout is ever discarded, `timer !== null` stays forever and no later start is scheduled.
- Production timers are not discarded, but the test file already has to work around this (lines 373-376: "the start queue's fake cool-down timer must elapse first or it would be dropped").
- A `resetFrameStartQueue()` test helper, or re-arming when `queue.length && timer` has been stale for too long, would make it robust.

## Checklist results

### Security: same sandbox as a click
OK.
- `run()` is shared (`InteractiveFrame.tsx:146-150`).
- The iframe props are unchanged: `sandbox="allow-scripts"`, `allow=""`, `referrerPolicy="no-referrer"`, and the CSP is first in `<head>`.
- The `event.source` check, the 50/4 broker quotas, and the 10 s ready plus 8 s heartbeat watchdog are untouched.
- Tests assert all of these under auto-start (`tests/interactive-autorun-dom.test.ts:165-171, 332-388`).

### Abuse without a user gesture
| Capability | Result | Why |
| --- | --- | --- |
| Popups | blocked | no `allow-popups` |
| Top navigation | blocked | no `allow-top-navigation` |
| Modals | blocked | no `allow-modals` |
| Forms | blocked | no `allow-forms` and `form-action 'none'` |
| Downloads | blocked | no `allow-downloads` |
| Fullscreen, autoplay with sound, clipboard write | blocked | `allow=""`, and the opaque origin is cross-origin, so these Permissions-Policy features are denied |
| Pointer lock | blocked | no `allow-pointer-lock` |

Not covered:
- CPU loops (MINOR 1).
- Self-navigation and third-party image or media requests (MINOR 2).
- There is **no per-page cap** (MINOR 1).

### Contexts
OK.
| Surface | Behaviour | Where |
| --- | --- | --- |
| Studio editor, three call sites | click-to-run (`autoRunInteractives` not passed, default `false`) | `ArticleEditor.tsx:724,1046,1375` |
| `?preview=1` | click-to-run; honoured only for admins, and then `view.preview = true`, so `autoRunInteractives={!view.preview}` is false | `[slug].astro:32,163` |
| Unpublished admin lessons | click-to-run (`status !== 'published'`) | `[lesson].astro:168` |
| Chat artifacts | unchanged: `autoRun` | `ZueyAiPanel.tsx:745` |
| HTML fragments (email, feeds) | no iframe in server HTML; test at line 400 | — |

`BlockRenderer` has no other callers.

### Paywall
OK.
- `getArticleView` applies `applyPaywall` before the document reaches the island props (`src/lib/blocks/articles.ts:683`).
- Lessons with a denial have `document = null` (`course-views.ts:134-144`).
- Tests cover top-level and nested withheld widgets (`tests/interactive-autorun-dom.test.ts:445-471`).

### Performance
- Stagger, observer disconnect after the first hit, cleanup on unmount and cancelling the queue entry are all correct (`InteractiveFrame.tsx:160-170`; tests at 182-223).
- A long article with 20+ widgets on mobile: starts are fine (20 × 150 ms is about 3 s), but the number running is unbounded (MINOR 1).

### Accessibility
- MAJOR 1.
- Focus is preserved: the Run and Reload button is the same element position, so React keeps focus.
- Recommend honouring `prefers-reduced-motion: reduce` by staying click-to-run, and adding Stop.

### Issue #197 acceptance criteria
| DoD item | Status |
| --- | --- |
| Published article widget runs without a click near the viewport | Met |
| Nested blocks wait; an opened toggle allows auto-start | Met in Chromium per the PR; the test is weak (MINOR 4) |
| 10+ widgets: no off-screen init, no reset on scroll, cleanup | Met |
| Chat unchanged; Studio click-to-run | Met |
| Social embeds auto-load near the viewport; `zuey:embeds=click` honoured and reversible | Met, but **pre-existing** (#81). This PR changes no embed code and adds one nested-embed test plus one lesson test. Lessons already passed the default `autoLoadEmbeds = true` before this PR. The issue title's "social embeds by default" was already true; nothing was missing. |
| Recoverable errors and responsive height | Met for widgets (watchdog → Run). Embed failure UI is pre-existing. |
| Tests for sandbox, CSP, quotas, source checks under auto-start | Met |
| No third-party request after a click-only preference | **Partially**: embeds yes, widget content no (MINOR 2) |
| `prefers-reduced-motion` and keyboard usable | **Not met** (MAJOR 1) |
| Tests for initial state, enter/leave, no observer, nesting, timeout, unmount | Met. "saved preference" applies to embeds and was covered before. |
| Playwright smoke for article + lesson, desktop + mobile, YouTube/X + a failure | Evidence table in the PR body; no screenshots attached, and "before/after evidence" is a table only. The repo's own smoke tool is now unreliable (MAJOR 2). |
| `bun test` / `bun run build` | Pass (see above) |

### Tests
- Overall good quality: they are deterministic (fake timers, fake observer, no frame loading) and assert observable DOM state. They also cover cancellation races (manual Run versus queued start, and full screen) and the security attributes.
- Gaps:
  - the toggle test (MINOR 4);
  - no reduced-motion test (MAJOR 1);
  - no test that a frame halted by the watchdog does not re-arm after a later `enter` (line 337 checks only that no live observer exists, which is good enough);
  - queue state is global between tests (NIT 3).

## Requested before merge
1. MAJOR 1: reduced-motion gate plus a Stop control, with tests.
2. MAJOR 2: make the smoke count widget frames only, scroll before counting, and stabilise the screenshot; update the playbook.
3. Strongly suggested: MINOR 2 (a), apply the embed opt-out to widget auto-start, or document the gap; and MINOR 1, a per-page auto-start cap.
4. File separate issues for widget frame self-navigation hardening and a publish-time long-task check.
