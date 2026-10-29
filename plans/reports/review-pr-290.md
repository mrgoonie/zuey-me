# Review: PR #290, halt interactive widgets that navigate their own sandboxed frame (closes #273)

- Reviewer: isolated reviewer agent (did not write this code)
- Date: 2026-10-25
- Head reviewed: `5907b83` (`origin/fix/273-widget-self-navigation`)
- Worktree: `D:\www\zuey\rv290` (removed after review, along with its `dist/`, `.wrangler/` and the dev server)

## Verdict

**FIX FIRST: 2 majors.**

The nonce half of the design holds. Widget code could not read the nonce in any probe I tried, and nothing a navigated page posts is answered. The halt half does not hold in real Chromium:

- The `pagehide` → `leave` report never reaches the halt logic. Chromium delivers it with `event.source === null`, and the existing source check drops it.
- Halting therefore depends only on the iframe firing a second `load` (or the 1 s handshake). A foreign page that never finishes loading never fires `load`, so it keeps running until the old heartbeat watchdog (about 8 s while the tab is visible, with no limit while it is hidden).

The PR's own Chromium check passed only because its landing page finished loading, so the second-`load` path caught it.

## Verification

| Check | Result |
| --- | --- |
| `bun test` | **1885 pass, 0 fail**, 111 files (92 s) |
| `bun run build` | **0 errors, 0 warnings**, `[build] Complete!` |
| Chromium 156.0.8078.4 (playwright-core 1.58.2), `astro dev` on 4472 with local D1 | Ten attack widgets on one seeded article. A landing server on 4473 streams or serves the foreign page and logs each request the page makes. |

Scripts (not part of the PR):
- `C:\Users\admin\AppData\Local\Temp\claude\D--www-zuey-zuey-me--claude-worktrees-analyze-prioritize-issues-b564ca\add9d22b-309e-464e-8852-27b3a9d31cc9\scratchpad\pw\rv290-seed.mjs`
- `C:\Users\admin\AppData\Local\Temp\claude\D--www-zuey-zuey-me--claude-worktrees-analyze-prioritize-issues-b564ca\add9d22b-309e-464e-8852-27b3a9d31cc9\scratchpad\pw\rv290-attacks.mjs` (modes: `attacks`, `bfcache`, `throttle`)
- `C:\Users\admin\AppData\Local\Temp\claude\D--www-zuey-zuey-me--claude-worktrees-analyze-prioritize-issues-b564ca\add9d22b-309e-464e-8852-27b3a9d31cc9\scratchpad\pw\rv290-csp-attr.mjs` (standalone, no app needed)

The results are in `rv290-attacks.json` in the same folder.

### Chromium results

"Foreign page alive" is the longest a foreign-page script kept pinging the landing server, measured from when it started.

| Widget | Final state | Foreign page alive | Halted by |
| --- | --- | --- | --- |
| Normal widget (interval ticks) | running | n/a | n/a |
| Post-load `location.href` → page that **finishes** loading (the author's case) | `navigated` | short | second iframe `load` |
| Post-load `location.href` → page that **streams forever** | `unresponsive` | **8.5 s** | heartbeat watchdog only |
| `location.href` during parsing → streaming page | `unresponsive` | **7.5 s** | watchdog only |
| `document.open()` then `location.href` → streaming page | `unresponsive` | **8.5 s** | watchdog only |
| `dispatchEvent(new Event('load'))`, then `location.href` → page that **finishes** loading | `unresponsive` | **8.0 s** | watchdog only (handshake defeated) |
| `zuey.fetch(...)`, then navigate → streaming page | `unresponsive` | 8.0 s | watchdog; the foreign page **received the `fetch:result` reply** |
| `location.hash` and `history.pushState` every 400 ms | running (`hash 39`) | n/a | no false positive |
| `document.open/write/close` 800 ms after load (no navigation) | `navigated` | n/a | second `load` (false positive, see Minor 2) |
| Nonce hunt 2 (16 probes, see below) | running, **`no nonce`** | n/a | n/a |

The parent-side trace (a capture listener added with `addInitScript`) logged every `leave` the bridges sent. All 5 arrived with `event.source === null` and none named its iframe.

`rv290-csp-attr.mjs` reproduces this outside the app:
- A sandboxed srcdoc frame posts from `pagehide` and then navigates.
- The parent receives `{t:'leave'}` with `source === null`.

## Findings

### MAJOR 1: the `leave` (pagehide) path never fires in Chromium

**Where:** `src/components/ai/InteractiveFrame.tsx:155` (source check), `:167` (`case 'leave'`); `src/lib/ai/sandbox-doc.ts` bridge (`addEventListener('pagehide', …)`).

When the frame navigates, Chromium delivers the old document's last `postMessage` after that document's window is gone, so `event.source` is `null`. Line 155 returns early whenever `event.source !== frameRef.current.contentWindow`, so `leave` is never processed.

The DOM test passes only because it stubs `source` with the frame window, which Chromium does not do. The PR text claims the frame halts when it "reports `leave`", and that claim is not true in Chromium.

**Repro:** run `node rv290-csp-attr.mjs`. `/plain` shows `msgs: [["leave","null"]]`. In the app trace, all 5 `leave` messages arrived with source `null`.

**Fix:** accept a nonce-tagged `leave` when `event.source === null`. This is safe because only this run's document knows the nonce, and a stale run carries a different one. For example, handle `leave` before the source check when `data.nonce === nonce && (event.source === null || event.source === frameRef.current?.contentWindow)`.

**Test:** the DOM test should send `leave` with `source: null`.

### MAJOR 2: a foreign page that never finishes loading escapes the halt

This holds even after Major 1 is fixed.

**Where:** `InteractiveFrame.tsx:123-132` (`onFrameLoad`, handshake starts only on iframe `load`); `:147-151` (watchdog judges only while `document.visibilityState === 'visible'` and resets `lastBeat` on becoming visible).

All three halt signals can be missing at once:
- **No `load`:** the foreign server streams its HTML and never ends the response. The iframe never fires `load`, so there is no second load and no handshake timer. Scripts in the stream run as they arrive, with no CSP.
- **No `leave`:** today it is always lost (Major 1). After that fix, widget code can still remove it by calling `document.open()` before navigating. `document.open()` erases the window's listeners, and in my run that navigation produced no `leave`.
- **No `loaded` check:** a widget can run `dispatchEvent(new Event('load'))`. The bridge's load listener then sends a valid nonce-tagged `loaded`, so the handshake is satisfied before the real navigation.

What remains is the heartbeat watchdog. The foreign page lives about 8 s while the reader's tab is visible, and with no limit while it is hidden (the watchdog skips hidden tabs and resets on `visibilitychange`). For that time the foreign page draws its own UI inside the article frame, for example a fake sign-in that sends typed input with `fetch`, and it has unrestricted network access. That is what #273 asks to prevent ("a widget cannot leave its sandboxed document"). The widget is then marked `unresponsive`, not `navigated`.

**Repro:** run `rv290-attacks.mjs attacks`. The "Load nav stream", "Parse nav stream", "Docopen nav stream" and "Fake load nav" rows show 7.5 to 8.5 s of foreign-page pings, then `unresponsive`.

**Recommended fix (pick one or more):**
1. Add `csp="<SANDBOX_CSP>"` to the iframe (CSP Embedded Enforcement). This is verified in this Chromium: with the attribute, the navigation lands on `chrome-error://chromewebdata/`, the foreign page runs no script, and the only request is the navigation itself (`rv290-csp-attr.mjs` `/csp`: 1 hit, against 6 without it). It does not cover Safari or Firefox, but it closes the gap for most readers without new timers. Check that srcdoc widgets still render with the attribute (the two policies combine, and the widget CSP is already stricter).
2. Make the bridge's `loaded` resistant to forgery. Capture `event.isTrusted` and send `loaded` only for a trusted `load`. Do the same for `pagehide`, so a synthetic event cannot force a halt either (Nit 1).
3. Start a second deadline from `ready` rather than from iframe `load`: halt if no trusted `loaded` arrives within N s of `ready` (for example the existing 10 s). Also, while hidden, cap how long the frame may stay silent instead of skipping the check.

If the team decides to accept this remaining risk (the widget author is first-party, and the navigation URL can carry data out anyway), say so in the playbook and the PR. The playbook currently says that self-navigation halts the widget, with no exception.

### Minor 1: in-flight broker replies reach the foreign document

**Where:** `InteractiveFrame.tsx:134-137` (`reply`) and `:190-201`.

`reply` posts to whichever document now holds `frameRef.current.contentWindow`. Replies do not carry the nonce or the run. A fetch requested just before navigating is answered to the foreign page as long as the frame is not yet halted. Because of Major 2, that window is several seconds long.

Repro row "Inflight fetch nav": the landing server logged `/got inflight {"channel":"zuey-sandbox","type":"fetch:result","id":1,...}`.

The data is from allowlisted public hosts, and the widget could have sent it out itself, so the impact is low. The same reply path can also deliver a slow reply from run N to run N+1's bridge after **Run again**, because `id`s restart at 1 each run (this predates the PR).

**Fix:** make the bridge listener require the nonce on `fetch:result` (the parent echoes it), and drop replies whose effect has been cleaned up (a `cancelled` flag in the effect closure).

### Minor 2: `document.open()` + `write()` + `close()` after load is reported as "tried to leave its sandbox"

**Where:** `InteractiveFrame.tsx:127` (`loadsRef.current > 1`).

`document.close()` fires a second iframe `load` without any navigation. Repro row "Doc write after load" ended in `navigated`.

This pattern is rare and erases the bridge anyway, so halting it is acceptable. The message is wrong, though. A sentence in the playbook ("rewriting the document with `document.open/write` also halts the widget") is enough.

### Minor 3: the DOM tests miss the Chromium behaviour

**Where:** `tests/interactive-autorun-dom.test.ts` (`say()` always sets `source` to the frame window).

Add cases for:
- `leave` with `source: null`;
- a frame that never fires `load` after it navigates, which is currently only caught by the watchdog.

### Nit 1: a synthetic event can force a halt or satisfy the handshake

`window.dispatchEvent(new Event('pagehide'))` makes the bridge send `leave`, which halts the widget once Major 1 is fixed. A synthetic `load` satisfies the handshake (used in Major 2). Check `isTrusted` in both bridge listeners.

### Nit 2: bfcache false positives not verified

With Playwright's `--disable-back-forward-cache` removed, the page was not restored from bfcache (`persisted: false`, probably because of the dev server's cache headers). I could not test whether a `leave` queued while the parent goes into bfcache halts the widget when the page is restored. After the Major 1 fix this becomes plausible, because the child is not navigated and its source stays valid. Also ignore `leave` while `document.visibilityState === 'hidden'` on the parent, or check `event.persisted` in the bridge (send `leave` only when `!e.persisted`), then re-test on a production build.

## Attack surface that held

- **Nonce secrecy.** "Nonce hunt 2" ran 16 probes and found nothing (`no nonce`). The probes:
  - `Math.ceil` and `String` overridden, walking `caller` chains and `Function.prototype.toString` from bridge frames;
  - V8 `Error.prepareStackTrace` with `CallSite.getFunction()`;
  - an `Object.prototype.nonce` setter;
  - a forged `MessageEvent` with `source: window.parent` and getter-backed data;
  - a synthetic `error` event whose `message` is an object;
  - a `zuey.fetch` URL object with `toString`;
  - `outerHTML`, `document.scripts`, `performance.getEntries()`, `location`.

  The nonce value sits only in the outer IIFE's source. That IIFE is never on the stack when widget code runs, and only the *identifier* `N` appears in reachable function sources. Pre-bridge injection would require breaking out of `<style>`, and `escapeForTag` handles `</style` case-insensitively.
- **Forging from the navigated page.** No nonce means no answer. Nested srcdoc frames post with a different `source`, so they are dropped too. A forged `loaded` without the nonce did not stop the handshake.
- **Hash-only navigation and `pushState`.** No false positive.
- **1 s handshake under load.** I could not measure it: at a 20× CPU throttle, the dev bundle did not hydrate within 12 s, and I avoided stressing the host further. By analysis the risk is low. The bridge posts `loaded` inside the child's `load` event, before Chromium fires the iframe element's `load`. In every run the parent saw `loaded` 0 to 15 ms after `ready`.
- **#260 regressions.** None found:
  - Stop works: the Stop → Run path was exercised.
  - The auto-start cap holds: 6 widgets auto-started and the rest showed `capped`.
  - The reduced-motion code is unchanged, and the `bfcache` run shows normal widgets still running after the page is restored.
  - The `navigated` state releases the auto-run slot through the existing `state !== 'running'` effect.
- **Locale strings.** The vi, en, zh, ko and ja strings are present and read naturally. The `copy.ts` interface is updated.
- **CSP change.** `img-src` and `media-src` set to `data: blob:` behaves as intended. The PR's scan of published articles found no widget that loads a remote image or media.

## Unresolved questions

1. Is it acceptable that a foreign page can stay up for about 8 s, or with no limit in a hidden tab, or should Major 2 be fixed in this PR (the iframe `csp` attribute is the cheapest fix)?
2. Should the bfcache case (Nit 2) get a check against a production build before merge?

Status: DONE_WITH_CONCERNS
Verdict: FIX FIRST (Major 1: `leave` dropped because Chromium sends it with `source === null`; Major 2: a navigation to a page that never finishes loading, or one combined with a synthetic `load` or `document.open()`, escapes the halt until the heartbeat watchdog, about 8 s visible and with no limit hidden)

---

# Round 2: head `1c6fecc`

- Reviewed `git diff 5907b83 1c6fecc` (InteractiveFrame.tsx, sandbox-doc.ts, playbook, 2 test files) and re-ran the attack suite in Chromium 156.0.8078.4 against `astro dev` on 4472 (local D1, fresh worktree `D:\www\zuey\rv290`, removed after).
- `bun test`: **1889 pass, 0 fail** (111 files). `bun run build`: **0 errors, 0 warnings**, `[build] Complete!`.
- New runner mode `nocsp` (`rv290-attacks.mjs nocsp`) blocks `setAttribute('csp')` on iframes to emulate Safari/Firefox, so the halt layer is tested on its own. Results: `rv290-attacks.json`, `rv290-nocsp.json`, `rv290-attacks-with-slow.json` in the scratchpad `pw` folder.

## Verdict

**MERGE.** Both round-1 majors are fixed and verified in a real browser. One new minor (the 5 s rule can halt a healthy widget starved by a neighbour) is worth a follow-up, not a blocker.

## Claims checked

| Claim | Diff | Chromium result |
| --- | --- | --- |
| `leave` accepted with `source === null` only with the current nonce | `InteractiveFrame.tsx` onMessage: nonce checked first, then `source === contentWindow` or (`source === null` and `type === 'leave'`) | `nocsp`: every post-load and parse-time navigation ends `navigated` via the null-source `leave` (Major 1 fixed) |
| iframe `csp` attribute = widget CSP | `EMBEDDED_CSP_ATTR = { csp: SANDBOX_CSP }` spread on the iframe | DOM attribute is byte-identical to `SANDBOX_CSP`. All 6 navigation attacks end `navigated`; foreign page scripts ran **0 ms** (no `/alive` ping), only the navigation request reached the host (Major 2 fixed in Chromium) |
| `loaded`/`leave` only for trusted events | `e.isTrusted` on load, `e.isTrusted && !e.persisted` on pagehide | "Fake load nav" (synthetic `load`, then navigate) now ends `navigated` in both modes. `isTrusted` is unforgeable; `!persisted` also covers the bfcache concern (Nit 2) |
| halt if `ready` but no `loaded` within 5 s | `loadedTimer` set on `ready`, cleared in cleanup | Works (see Minor A for its false positive) |
| hidden tab halts after 3 min silence | watchdog uses 180 s while hidden; `onVisible` halts if silence > 180 s | Code-verified; not exercised (headless tabs are always visible) |
| late fetch replies dropped after halt/Stop/rerun | `cancelled` flag set in effect cleanup; `answer()` checks it | With `csp`: the foreign page got no `/got`. Run-scoped ids: ids still restart at 1 per run, but a previous run's reply is dropped because its effect was cleaned up before the next run mounts, so it cannot resolve the new run's request |
| playbook documents `document.open/write/close` halting | new bullet | Accurate ("Doc write after load" ends `navigated`) |

## No false positives for normal widgets

- Normal widget (ticks), hash/pushState widget and the nonce hunt keep running in both modes. The nonce hunt still reports `no nonce (16 probes)`.
- The `csp` attribute blocks nothing legitimate: it equals the meta CSP, and Chromium applies an embedded policy to `about:srcdoc` children without `Allow-CSP-From` (opt-in is only required from network responses), so widgets render normally.
- A widget with a 3 s synchronous init, and one with 6 s, both survive on their own: the bridge's `ready` leaves the busy sandbox process only after the loop ends, so the parent sees `ready` and `loaded` together.

## Findings

### Minor A: the 5 s `ready` → `loaded` rule halts a healthy widget whose shared sandbox process is busy

**Where:** `InteractiveFrame.tsx` `LOADED_AFTER_READY_MS = 5_000` and the `ready` case.

Chromium runs every sandboxed widget on a page in **one** process. In `rv290-attacks-with-slow.json`, the "Normal widget" reported `ready` at 8461 ms. Then the neighbouring "Slow init 6s" widget blocked the process until about 14.4 s, so the Normal widget's own `loaded` could not be sent. It was halted as `unresponsive` at about 13.8 s. Its message gap (about 6 s) was still under the 8 s heartbeat bound, so it was the new 5 s rule that halted it. Other widgets that had reported `ready` were halted the same way.

The slow widget itself is never halted, so the rule punishes its neighbours. A 6 s init is unusual on desktop, but a slow phone starting 6 widgets within about 1 s gets much closer. Recovery is just **Run**.

**Fix (follow-up is fine):** set `LOADED_AFTER_READY_MS` to the heartbeat bound (8 s), so it adds no false positive beyond the existing watchdog. In Chromium the `csp` attribute already covers navigation. The 5 s rule only matters for the parse-time case in Safari and Firefox.

### Nit A: the residual-risk text is accurate, with two small corrections

- "Usually about 1 s": in `nocsp`, `leave` halts the widget as soon as the old document unloads, well under 1 s. The 1 s figure only applies when `leave` is missing and the page finishes loading.
- "Broker replies still in flight when a run is halted … are dropped" holds after the halt. A reply that lands between the navigation and the `leave` still reaches the foreign page (`nocsp`: `/got inflight` 22 ms after the navigation). Low impact: the data comes from the allowlisted proxy, and the widget could send it anyway. Add "after the halt" or ignore it.

The rest of the statement matches what I measured:
- Chromium refuses the foreign page, and the navigation request still reaches the host.
- Safari and Firefox are exposed until the halt.
- The `document.open()` + never-finishing page case is caught only by the watchdog: `nocsp` "Docopen nav stream" ran 8.5 s and ended `unresponsive`. The 3 min hidden-tab bound comes from the code.

Accepting the Safari/Firefox risk for admin-authored widgets is a reasonable product decision, and it is stated clearly.

## Unresolved questions

1. Raise `LOADED_AFTER_READY_MS` to 8 s now, or file a follow-up issue (Minor A)?

Status: DONE_WITH_CONCERNS
Verdict: MERGE (Minor A is a follow-up; no majors remain)
