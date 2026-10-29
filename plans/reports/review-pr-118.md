# Review: PR #118 (closes #88), privacy discloses embeds, jsDelivr, Workers AI, Cloudflare Stream

Head `21dd83d`, merged locally with `origin/main`. Isolated reviewer. Scope: `src/pages/privacy.astro`, `tests/analytics.test.ts`.

## Verdict

**Approve, with non-blocking follow-ups.** Every new claim matches the code in both languages, and the Vietnamese copy has correct diacritics. The 3 acceptance criteria of #88 are met: there are embed rows, a jsDelivr row and Workers AI in the Cloudflare purpose; the rows were checked; the effective date is `2026-10-11`. No blocker found.

## Claim-by-claim verification

| Claim (VI + EN) | Evidence | Result |
| --- | --- | --- |
| Embeds: YouTube, Vimeo, SoundCloud, Spotify, X, Facebook, Instagram, TikTok, LinkedIn | `src/lib/blocks/embed.ts:3-18` (`HOST_PROVIDERS`, `PROVIDER_LABELS`, 9 non-generic) | OK |
| Embeds load on scroll; on click when auto-load is off; choice in localStorage | `src/components/blocks/EmbedView.tsx:8,84-85,106-121` (IntersectionObserver, `zuey:embeds` key) | OK. The 200px preload margin means "slightly before you reach it", which is acceptable. |
| X in do-not-track mode | `embed.ts` `x` case: `...Tweet.html?id=…&dnt=true` | OK |
| YouTube via youtube-nocookie; Zueytube player loads when a video is opened | `src/lib/videos/youtube-url.ts:39`; `ZueytubePlayer.tsx:56-63` mounted only when `selected` is set (`ZueytubeBrowser.tsx:47-59,136`) | OK. See L2 on the scope "(/videos)". |
| Thumbnails from i.ytimg.com, loaded when a list is shown | `youtube-url.ts:43`; lazy `<img>` in `ZueytubeBrowser.tsx:171`, `articles/[slug].astro:165` | OK |
| jsDelivr only for Scalar on /docs | Only jsDelivr reference in repo: `src/pages/docs/index.astro` (`@scalar/api-reference@1.72.3`) | OK |
| /docs sends no referrer | Header `Referrer-Policy: no-referrer` (line 5) + `<meta name="referrer">` | OK |
| Pasted API key goes only to zuey.me | `sameOriginFetch` blocks cross-origin requests and adds the key only for same-origin ones; `telemetry:false`, `agent.disabled`, `withDefaultFonts:false`, `persistAuth:false` | OK |
| Workers AI: search query up to 200 chars, not stored, no account/email | `src/lib/search/index.ts:149` (`slice(0, 200)`), `:111` (`embedTexts(ai, [query])` alone); `semantic.ts:42-55` (only when `AI` + `VECTORIZE` are bound). No search-log table or insert anywhere. | OK |
| Workers AI summarises/classifies/cleans up content | `reads/summarizer.ts:43`, `taxonomy/audit.ts:213`, `videos/video-transcript-rewrite-providers.ts:37-41` | OK. See L1 on the word "public". |
| Stream: signed link valid 10 min to 4 h, carries only the video id | `courses/course-media-signing.ts:12-19` (`clamp(d + 10min, 10min, 4h)`), `:62` payload `{sub, kid, exp, nbf}` | OK |
| Stream loads only when you scroll to it; your browser contacts cloudflarestream.com | `CourseMediaWidget.tsx:50-58` (IntersectionObserver, 200px); `streamIframeUrl` → `customer-<code>.cloudflarestream.com` | OK |
| Lesson page sends no referrer | `src/pages/courses/[slug]/[lesson].astro:23`; the widget is used only through `LessonContent` on that page | OK |
| #101 server-side PostHog disclosure | VI line 182 / EN line 322 unchanged (diff shows them as context only) | Intact. See L3. |

## Findings

### Medium
None.

### Low
- **L1 "public content" is too narrow** (`privacy.astro:166` VI, `:306` EN, Cloudflare row). Workers AI processes *published* editions. The semantic index embeds member-only tiers too (`search/semantic.ts` with tier metadata, `index.ts:88`), and the taxonomy audit sends every published edition (`taxonomy/audit.ts:118-123`). Members' personal data is not involved, but "nội dung đã xuất bản" / "published content" would be accurate.
- **L2 Zueytube scope** (`privacy.astro:129,179` VI; `:269,319` EN). The player is described as "(/videos)", but the same `ZueytubeBrowser` on the homepage (`src/pages/index.astro:79`) also opens the player inline, including on a `?v=` deep link. Suggest "Trình phát Zueytube (trang chủ và /videos)" / "(homepage and /videos)".
- **L3 The #101 test is weak** (`tests/analytics.test.ts:624-628`). "the server-side analytics row stays" only asserts `name: 'PostHog'`, which existed before #101. It would not catch removal of the server-side wording. Assert the substrings `từ máy chủ` / `server-side account and purchase events`.
- **L4 Tests are source-text regexes** (`tests/analytics.test.ts:576-629`). Splitting on `'\n  en: {'` and slicing between `processors: [` and `processorsNote:` is brittle against formatting changes, but it fails loudly, not silently. The provider test derives its list from `PROVIDER_LABELS`, so a new embed provider breaks it. That is good. The TTL test greps `MEDIA_TOKEN_MAX_TTL_SECONDS = 4 * 60 * 60` from source because the constant is not exported; exporting it would make the test a real value check. Acceptable as is.

### Nit (Vietnamese wording)
- `privacy.astro:121`: "chữ của từ khoá (tối đa 200 ký tự)" sounds translated. Suggest "nội dung từ khoá (tối đa 200 ký tự)". The same phrasing appears in the Cloudflare row ("chỉ nhận chữ của từ khoá tìm kiếm"). Diacritics are correct throughout, and "khoá"/"tuỳ" match the page's existing spelling.
- In the Cloudflare row, "trình duyệt của bạn gửi trực tiếp tới cloudflarestream.com địa chỉ IP và user agent" has inverted word order. Better: "trình duyệt của bạn gửi địa chỉ IP và user agent trực tiếp tới cloudflarestream.com". The test regex pins the current order, so it would need updating too.
- The Cloudflare row's data cell is now very long, with 6 clauses joined by semicolons. It is readable, but on mobile the row is very tall. Optional: move the Stream part into its own row, "Cloudflare Stream".

## Third parties still not disclosed (out of scope, file separately per AGENTS.md)

1. **Hotlinked images, bookmark previews and PDFs from arbitrary hosts.** Image, gallery, bookmark and file blocks accept any `https://` URL (`src/lib/blocks/validate.ts:69-71`). The browser fetches them directly: `BlockRenderer.tsx:186`, `MediaBlocks.tsx:38,73,113`. Bookmark/PDF use `no-referrer`; plain images use the default policy. The reader's IP goes to whatever host the author used (e.g. `assets.200lab.io`). This is not in the table. Suggested issue: disclose it, or proxy/require cdn.zuey.me.
2. **OpenRouter** (`videos/video-transcript-rewrite-providers.ts:11`). The default transcript rewriter sends public Zueytube transcripts. No visitor data, so a disclosure is optional, but the Cloudflare row's "cleans up Zueytube transcripts" implies Workers AI only, and OpenRouter is the default provider.
3. **qr.sepay.vn**. The browser loads the VietQR image with amount and transfer memo in the query (`payments/sepay.ts:55,63`). This is covered by the SePay row data ("amount, transfer memo"), and the row could say the QR image is fetched from SePay. Info only.
4. Covered already: Google Fonts (Google row), PostHog (`us.i.posthog.com`), Telegram/Discord webhooks (server-side, admin alerts), Dodo/PayPal (rows present; no client scripts found), Open-Meteo incl. geocoding, AnyMD (server-side fetch of public URLs, no visitor data), GitHub API (public events).

## Gates (local merge with origin/main)

- `bun install --frozen-lockfile`: OK (742 packages)
- `bun test`: **904 pass, 0 fail** (50 files)
- `bun run build`: astro check **0 errors, 0 warnings** (64 hints), build complete, exit 0

## Unresolved questions
- Should L1 and L2 be fixed in this PR (small copy edits), or follow up? Neither changes what is disclosed materially.

---

# Round 2: delta `21dd83d..d0c987b`

**Verdict: approve.** All round-1 findings are addressed (L1-L4, Vietnamese nits, the 3 undisclosed-party gaps).


Every finding from the first review is addressed. I checked each new claim against the code in both VI and EN:
- **Workers AI wording:** the search indexer embeds every published edition, including the `full` (members-only) tier (`search/indexer.ts:63-81,105`). "Published content (including members-only articles)" is accurate.
- **Zueytube:** the home page window (`index.astro:79`) opens the player inline, including via `?v=` (`ZueytubeBrowser.tsx:62-66`). Now disclosed.
- **Author-chosen hosts:** `validate.ts:69` accepts any `https:` URL. The loading rules match `MediaBlocks.tsx` and `BlockRenderer.tsx:186`:
  - images and galleries use `loading="lazy"`;
  - the video `poster` loads with the page;
  - audio and video use `preload="none"`;
  - the PDF iframe mounts only after "Xem PDF".
  
  The no-referrer claim is limited to bookmark images and the PDF viewer, which is correct. Plain images use the default policy, and the copy doesn't claim otherwise.
- **OpenRouter, then Workers AI:** `transcriptRewriters` pushes OpenRouter first when a key exists, then Workers AI (`video-ingest-service.ts:42-44`). `video-transcript-rewrite.ts:153-161` moves to the next provider on an error or a bad word ratio, so "only when OpenRouter is not configured or fails" is accurate. Only the public transcript and system prompt are sent.
- **SePay QR:** `qr.sepay.vn/img?acc,bank,amount,des` (`payments/sepay.ts:55,63`) is rendered as `<img>` in `BillingStatus`, `CourseOrderStatus` and `BookingWidget`. The disclosure matches. The account in the link is zuey.me's receiving account, not the visitor's.
- **VI wording:** "nội dung từ khoá" and "gửi địa chỉ IP và user agent trực tiếp tới cloudflarestream.com" now read naturally, and diacritics are correct.
- **Tests:** each new row is tied to a code fact (an `https:` check, provider order, the QR host, the `full` tier). The PostHog test now asserts the #101 server-side wording and the "sent even when browser analytics is off" sentence.

Gates after a local merge with `origin/main`: `bun test` **911 pass, 0 fail (50 files)**; `bun run build` **0 errors, 0 warnings (64 hints), build complete**.

One optional nit, not blocking: the Workers AI data cell says "published content", but Zuey Reads summaries are of external articles, not zuey.me content. "Nội dung đã xuất bản và bài Zuey Reads" / "published content and Zuey Reads articles" would cover both.


