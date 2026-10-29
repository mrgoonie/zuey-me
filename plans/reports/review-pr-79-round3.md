# PR #79 re-review, round 3 (head d44ea31, issue #26 gallery layout)

## Status: DONE. Verdict APPROVE, posted as https://github.com/mrgoonie/zuey-me/pull/79#issuecomment-6108756337

This report replaces the earlier static-only (BLOCKED) version. It was re-run in a session where the shell worked, from a fresh detached worktree D:\www\zuey\rv79 on origin/claude/center-article-images (d44ea31).

Method: local D1 (wrangler d1 migrations apply --local). The article was seeded with the app's own createArticle / publishArticle through bun:sqlite on the local miniflare file. Images are https URLs, which the validator requires, served from public/samples by Playwright route interception. The measurement scripts are in the session scratchpad pw\seed-r79.ts and pw\measure-r79.mjs, with raw output in pw\r79c-results.json and screenshots in pw\shots\r79c-*.png.

---
## Re-review round 3 (head `d44ea31`): APPROVE

Isolated reviewer, fresh worktree on `origin/claude/center-article-images`.

**Gates**
- `bun test`: 717 pass, 0 fail (41 files)
- `bun run build`: astro check 0 errors, 0 warnings (59 hints), build complete
- `git merge-tree` against current `origin/main` (`0e5762f`): clean, no conflicts

**Browser check.** Chromium (playwright-core) against `bun run dev` on local D1 only. The seeded article has galleries of 1, 2, 3 and 4 images at top level and in every cell of a 2-column and a 3-column `layout` block (28 galleries). Free space is measured per row as gallery edge to first/last tile.

| Viewport | Context (gallery width) | Columns (1/2/3/4 imgs) | Tile width | Row free space L / R | Page overflow |
| --- | --- | --- | --- | --- | --- |
| 1440 | top (762) | 1/2/3/4 | 320 / 320 / 240 / 183.3 | 221/221, 56.2/56.2, 11.4/11.4, 0/0 | 0 |
| 1440 | 2-col cell (373) | 1/2/2/2 | 320 / 181.7 | 3rd tile of 3: **95.66 / 95.66** | 0 |
| 1440 | 3-col cell (243.3) | 1/1/1/1 | 243.3 (3 imgs: 240) | 0/0 (1.66/1.67) | 0 |
| 768 | top (622) | 1/2/3/3 | 320 / 306.2 / 200.9 | 4th tile of 4: 210.53 / 210.55 | 0 |
| 768 | 2-col (303), 3-col (196.7) cells | all 1 | full width (3 imgs: 240) | 0/0, 31.5/31.5 | 0 |
| 430 | all contexts (376) | 1/2/2/2 | 320 / 183.19 | 3rd tile of 3: **96.41 / 96.41** | 0 |
| 375 | all contexts (321) | all 1 | 320 / 321 (3 imgs: 240) | 0.5/0.5, 40.5/40.5 | 0 |
| 320 | all contexts (266) | all 1 | 266 (3 imgs: 240) | 13/13 | 0 |

Every row across all 5 viewports and both font sizes has equal left and right free space, within 0.02px. No viewport overflows horizontally. The original Medium (the last tile of a 3-image gallery sat at the left at 330 to 499px) is fixed in the browser: at 430px the third tile has 96.41px of free space on each side.

**Earlier Lows, checked with evidence**
- **(a) px breakpoints vs rem gap: Low, not blocking.** With a 20px root font the gap becomes 12px, and every row stays symmetric with no overflow at any viewport (430px: tiles 175.5px, last tile 93.75/93.75). Tiles drop below 160px only in a narrow band of gallery widths, 329.6 to about 332px, where they are 158.8 to 160px. That band is at most 1.2px under the minimum and not visible. Optional cleanup: write the thresholds in `rem`.
- **(b) The "symmetric" test checks its own arithmetic: Low, still open.** `tests/article-images.test.ts` ~151–159 proves nothing about the layout engine. The browser numbers above are the real evidence. Optional: rename it or drop it.
- **(c) Full rows could wrap from subpixel rounding: not reproduced.** I swept the 4-image gallery's wrapper width from 300 to 1100px in 0.13px steps (6,154 widths). The row count always matched `ceil(4 / cols)`, so no full row ever wrapped. Measured free space on full rows is at most 0.03px.

**Findings:** no Critical, High or Medium findings. Low: (a) and (b) above, both optional.

Screenshots are saved locally as `r79c-{1440,768,430,375,320}[-f20].png`.

## Cleanup
The dev server on 4436 was stopped, and worktree `D:\www\zuey\rv79` was removed together with its dist/ and .wrangler/. `D:\t79` was deleted. Nothing was pushed or merged, and no remote D1 or secrets were touched.

