# Zuey mascot spritesheet — provenance

Production assets: `public/mascot/zuey-mascot.webp` (primary), `public/mascot/zuey-mascot.png`
(fallback) and `public/mascot/manifest.json` (cells, pivot, baseline, animations, expressions, QA).
The raw codex output is kept at `plans/visuals/assets/zuey-mascot-codex-raw.png` so the atlas can be rebuilt.

## 1. Generation (codex CLI)

| Field | Value |
|---|---|
| Date | 2026-10-01 23:58 → 2026-10-02 00:05 (Asia/Saigon) |
| Tool | `codex-cli 0.159.3`, `codex exec`, model `gpt-6.1-sol`, built-in `image_generation` feature (stable, enabled) |
| Session id | `01a0f867-9002-74f0-8437-85fa2adf1afb` |
| Input reference | `plans/visuals/assets/zuey-companion-sprites.png` (prototype 4×4 alpha atlas, 1254×1254, Zuey likeness), attached as `reference.png` |
| Output | 1254×1254 RGB PNG on a green key, sha256 `2f98949a7c1cca4e9b31a080d2758de3cbc634d31b71f3a9eeb8c0f0fd410271` |

Command (run from a scratch directory that holds `reference.png` and `prompt.txt`; stdin closed so it never blocks):

```bash
timeout 900 codex exec --skip-git-repo-check -s workspace-write -C "$SCRATCH" \
  "$(cat prompt.txt)" -i reference.png </dev/null > codex-run.log 2>&1
```

Note: the prompt must come before `-i`, because `-i <FILE>...` is variadic and otherwise swallows
the prompt (first attempt failed with `No prompt provided via stdin.`).

Prompt (`prompt.txt`, verbatim):

```text
Use your built-in image generation tool (do not write code to draw it) to create ONE production sprite sheet image for the "Zuey" website mascot, using the attached image reference.png as the likeness and style reference (same man: shaved head, round black glasses with purple-tinted lenses, short stubble beard/moustache, beige knit sweater, light beige trousers, white sneakers; chibi proportions with big head, soft 3D toy render).

Layout requirements (strict):
- Square image, exactly a 4 columns x 4 rows grid of equal cells, no gutters, no borders, no grid lines, no text, no labels, no shadows on the ground.
- Background: one perfectly flat solid pure green #00FF00 (chroma key) over the whole image; no gradients, no noise, no vignette. Do not use green anywhere on the character.
- Same character size and scale in every cell; full body visible with margin; head never cropped; feet resting on the same horizontal baseline at about 88% of each cell height; body horizontally centred in each cell.
- Row 1 (idle loop, facing viewer, hands in pockets): frame 1 neutral smile, frame 2 eyes closed blink, frame 3 neutral with tiny breathing lift of shoulders, frame 4 neutral smile.
- Row 2 (walk cycle facing right, side three-quarter view): 4 evenly spaced phases of one smooth looping walk: contact left foot forward, passing, contact right foot forward, passing.
- Row 3 (wave): frame 1 neutral standing arms down, frame 2 right hand raised starting a wave, frame 3 hand raised waving with open happy mouth, frame 4 hand lowering back.
- Row 4 (expressions, standing facing viewer): frame 1 thinking (hand on chin, eyes looking up), frame 2 happy (big closed-eye smile), frame 3 surprised (open mouth, raised palms), frame 4 talking (mouth open mid-sentence, one hand gesturing).

After the image is generated, copy the generated PNG file into the current working directory as codex-spritesheet.png and print its absolute source path and pixel size. Do not modify any other files.
```

Codex output (summary of `codex-run.log`): it rendered three candidates in
`~/.codex/generated_images/01a0f867-…/` and chose `exec-cc96a70c-841a-41d9-bb57-c2ae3d4b8531.png`
(the second, which fixed a hand switch in the wave row). The other candidates were not used:
`exec-270a188b…` (wave changes hands) and `exec-0cb1b34c…` (likeness drift). Codex itself
reported that the green was not perfectly flat and the baseline was not exact, which is why the
deterministic post-processing below exists. Its sandboxed shell calls failed on this Windows host
(`CreateProcessAsUserW failed: 5 (Access is denied.)`); the image tool and file copy still worked.

## 2. Deterministic post-processing

```bash
python scripts/build-mascot-atlas.py --input plans/visuals/assets/zuey-mascot-codex-raw.png --out public/mascot
```

Tested with Python 3.14.0, Pillow 12.0.0, numpy 2.3.5, scipy 1.17.0. Two runs give identical sha256 output.

1. Split the input into an even 4×4 grid.
2. Remove the background: chroma key against the median border colour (`rgb(4,249,5)`), soft
   alpha ramp, un-mix the key from edge pixels, then despill green.
3. Keep the character's connected components and drop isolated specks.
4. Normalise the standing height of the wave and expression rows to the idle row (the generator
   drew row 4 about 3% larger). The walk row keeps the idle scale.
5. Apply ONE shared scale (0.84011), set the feet bottom on `baseline = 244`, and centre the
   bottom 8% of the silhouette (the feet) on `pivot.x = 128` in every 256×256 cell.
6. Pack into a 1024×1024 atlas and export a PNG (optimised) and a WebP (q90, lossless alpha).
7. Measure every packed frame. The build fails if baseline or pivot drift is more than 2 px or a
   frame touches its cell edge.

## 3. QA (from `manifest.json` → `qa`)

- Baseline deviation: 0 px on all 16 frames. Pivot-x deviation: at most 1.44 px.
- Standing character height: 238–239 px. Walk frames are 232–234 px because of the stride.
- File sizes: WebP 194,716 B; PNG 848,614 B.

## 4. Animations and UI states

These states come from the preview runtime (`plans/visuals/explain-zuey-membership.html`):
`idle`, `walking`, `wave`, `thinking`, `happy`, `surprised`, `talking`. The weather mapping there is
sun → happy, rain → thinking, snow → surprised. `manifest.expressions` maps each state to an
animation; every animation has a `reducedMotionFrame` for reduced-motion mode. The walk frames face
right, so mirror them with `scaleX(-1)` for leftward moves.
