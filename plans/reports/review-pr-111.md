## Review of #111 (image sizes, tall-portrait cap and email centring; closes #86)

**Verdict: APPROVE.** I found no blocking issues. The three items in #86 are implemented and I measured each one in Chromium.

Reviewed head `45d0203`, merged locally with `origin/main`, which includes #108. The merged test commit was `439042d`.

### Gates on the merged result
- The merge has no conflicts. `git merge-tree --write-tree origin/main HEAD` exits cleanly.
- `bun test`: 871 passed, 0 failed (49 files).
- `bun run build`: 0 errors, 0 warnings (64 hints, none from this PR).
- The diff adds no `any` and no unchecked casts.

### Validation
I ran checks against `validateDocument` and `readStoredDocument` on the merged tree:

| Input | Strict (API) | Lenient (stored, #108) |
| --- | --- | --- |
| `400×700` | accepted | kept |
| `"400"`, `1.5`, `0`, `NaN`, `50001` | 422 with a clear message | block dropped |
| width without height | 422 | block dropped |
| both `null` | accepted as "no size" | kept |

- The validator requires both sizes or neither, and each must be an integer from 1 to 50000.
- The JSON Schema says the same with `dependentRequired`.
- MCP `block_schema` serves `blockSchemas`, so agents see the new fields.

### XSS and attribute injection
- Web: the `width`/`height` attributes and the `--zb-img-ratio` style value come from integers the validator has already checked. #108's lenient read uses the same `Validator`, so stored data is checked too. React escapes the attributes either way.
- Email: `w` and `h` are computed with `Math.*`, so they are always numbers. The URL and alt text still go through `escapeHtml`.

### Browser check
I rendered the real `BlockRenderer` and `renderArticleEmail` output in Chromium (playwright-core). Image responses were held back until the boxes had been measured.

Article page, at 1440×900, 1440×600, 375×600 and 320×900:
- Sized images reserve their final box before loading: the box before load equals the box after load.
- The unsized image starts at 0×0 and grows on load, as before.
- Centring: the left and right gaps are equal for every single image.
- No horizontal scroll at any size.
- Tall portraits are capped at 80vh without distortion. At 600px height, 400×700 renders as 274.3×480, with a ratio error of 0.
- Gallery tiles keep the 4:3 crop, as intended.

Email, at 600 and 320 wide:
- Every image is centred with equal gaps and nothing overflows.
- The sized 400×700 portrait renders at 365×639.
- The 600×800 gallery image renders at 480×640, within the 640px height cap.
- Sized boxes do not shift on load.

### Findings (none blocking)
1. **Low: a lenient read drops the whole block when a stored size is invalid.** In `src/lib/blocks/validate.ts`, `imageSize` returns `null`, and the image block (around line 205) or the whole gallery (around line 342) is then dropped.
   - In lenient mode it would be safer to strip only the bad size and keep the image.
   - This cannot happen today, because every stored document passed the strict validator when it was written.
   - It would start to matter if `LIMITS.imagePixels` were ever tightened, or if data were written outside the API. Fine as a follow-up.
2. **Low: concurrent probes can lose a size in Studio.** This is the race the author noted.
   - Each probe's `onSize` handler applies its change to the block list from the last render (`set(i, size)` in `GalleryFields`, and `onChange` in `BlockFields` at `ArticleEditor.tsx:716`).
   - If two probes finish before React re-renders, the second write overwrites the first, and that image is saved without a size.
   - The effect is only a missing size: the image renders unsized, as before. No user content is lost, because keystrokes re-render before a probe callback can use old data.
   - Re-entering that image's URL re-measures it. Not worth blocking.
3. **Nit: reverting to the original URL does not re-measure.** If an author changes an image URL and then changes it back to the URL it had when the field appeared, the size is cleared and not measured again (`image-size-probe.tsx`, the `url === initialUrl.current` check). The image just renders unsized.
4. **Nit: gallery rows are keyed by index** (`ArticleEditor.tsx:351`). After an image is deleted, the next row reuses the deleted row's probe and its starting URL, so it may measure an older unsized image. That marks the draft dirty, but the author has already edited it by deleting, so this is harmless.
5. **Nit: `null` sizes.** The strict validator accepts `width: null` and `height: null` as "no size", but the OpenAPI schema types both fields as `integer`. Being more lenient than the schema is harmless.
6. **Nit: extreme ratios in email.** A 1×50000 image becomes a 1×640 email box, which changes its shape. This is unrealistic.
