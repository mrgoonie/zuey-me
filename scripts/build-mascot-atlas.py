#!/usr/bin/env python3
"""Build the production Zuey mascot atlas from a 4x4 source spritesheet.

Deterministic post-processing for the codex CLI output (see
docs/mascot-provenance.md):

1. split the source into an even cols x rows grid;
2. remove the background to alpha (existing alpha, or a flat chroma key);
3. drop stray specks (keep the character's connected components only);
4. scale every frame by ONE shared factor and align the feet baseline and the
   feet-centre pivot to fixed cell coordinates;
5. pack into the final atlas, export PNG + WebP and manifest.json;
6. measure every packed frame and fail when baseline/pivot drift > tolerance.

Usage:
  python scripts/build-mascot-atlas.py --input <sheet.png> [--out public/mascot]
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

COLS, ROWS = 4, 4
CELL = 256
BASELINE = 244  # feet rest on this row inside every cell
PIVOT_X = 128  # feet centre sits on this column inside every cell
TOP_MARGIN = 6
SIDE_MARGIN = 6
ALPHA_SOLID = 24  # alpha above this counts as character for bbox / QA
FEET_BAND = 0.08  # bottom share of the bbox used to locate the feet centre
TOLERANCE = 2
# Rows whose standing height is normalised to row 0 (the generator may draw a
# row slightly larger). The walk row keeps row 0's factor because its stride
# legitimately lowers the head.
NORMALISE_ROWS = (2, 3)

# Grid semantics: row -> frame names (left to right).
GRID = [
    ["idle-0", "idle-blink", "idle-breathe", "idle-1"],
    ["walk-0", "walk-1", "walk-2", "walk-3"],
    ["wave-0", "wave-1", "wave-2", "wave-3"],
    ["thinking", "happy", "surprised", "talking"],
]

# name -> (loop, [(frame, durationMs)])
ANIMATIONS = {
    "idle": (True, [("idle-0", 1400), ("idle-blink", 140), ("idle-breathe", 700), ("idle-1", 1100)]),
    "walk": (True, [("walk-0", 125), ("walk-1", 125), ("walk-2", 125), ("walk-3", 125)]),
    "wave": (False, [("wave-0", 120), ("wave-1", 160), ("wave-2", 320), ("wave-1", 160), ("wave-2", 320), ("wave-3", 200)]),
    "talk": (True, [("talking", 180), ("idle-0", 140)]),
    "thinking": (False, [("thinking", 1200)]),
    "happy": (False, [("happy", 1200)]),
    "surprised": (False, [("surprised", 1200)]),
}

# UI expression/state name (as used by the companion runtime) -> animation.
EXPRESSIONS = {
    "idle": "idle",
    "walking": "walk",
    "wave": "wave",
    "talking": "talk",
    "thinking": "thinking",
    "happy": "happy",
    "surprised": "surprised",
}


def to_alpha(rgba: np.ndarray) -> tuple[np.ndarray, str]:
    """Return an RGBA array with background removed and the method used."""
    alpha = rgba[..., 3]
    if (alpha < 16).mean() > 0.2:
        return rgba.copy(), "source-alpha"

    rgb = rgba[..., :3].astype(np.float32)
    h, w = alpha.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    key = np.median(border, axis=0)
    dist = np.sqrt(((rgb - key) ** 2).sum(axis=-1))
    a = np.clip((dist - 60.0) / (140.0 - 60.0), 0.0, 1.0)

    out = rgba.astype(np.float32)
    # Un-mix the key colour from soft edges: observed = a*fg + (1-a)*key.
    edge = (a > 0) & (a < 1)
    safe_a = np.where(edge, a, 1.0)[..., None]
    unmixed = (rgb - (1.0 - safe_a) * key) / safe_a
    out[..., :3] = np.where(edge[..., None], np.clip(unmixed, 0, 255), rgb)
    # Despill: pull the key's dominant channel back where it still leaks.
    k = int(np.argmax(key))
    others = [c for c in range(3) if c != k]
    cap = np.maximum(out[..., others[0]], out[..., others[1]])
    out[..., k] = np.minimum(out[..., k], cap)
    out[..., 3] = a * 255.0
    return out.round().astype(np.uint8), f"chroma-key rgb({int(key[0])},{int(key[1])},{int(key[2])})"


def clean(cell: np.ndarray) -> np.ndarray:
    """Keep the character's components and remove isolated specks."""
    solid = cell[..., 3] > 128
    labels, count = ndimage.label(solid)
    if count == 0:
        raise SystemExit("empty source cell")
    sizes = ndimage.sum(solid, labels, index=range(1, count + 1))
    keep_ids = [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * 0.01]
    keep = np.isin(labels, keep_ids)
    keep = ndimage.binary_dilation(keep, iterations=3)
    out = cell.copy()
    out[..., 3] = np.where(keep, out[..., 3], 0)
    return out


def bbox(alpha: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(alpha > ALPHA_SOLID)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def feet_centre(alpha: np.ndarray) -> float:
    x0, y0, x1, y1 = bbox(alpha)
    band = max(2, int(round((y1 - y0 + 1) * FEET_BAND)))
    region = alpha[y1 - band + 1 : y1 + 1].astype(np.float64)
    cols = region.sum(axis=0)
    return float((cols * np.arange(alpha.shape[1])).sum() / cols.sum())


def measure(alpha: np.ndarray) -> dict:
    x0, y0, x1, y1 = bbox(alpha)
    return {"bbox": [x0, y0, x1 - x0 + 1, y1 - y0 + 1], "baseline": y1, "pivotX": round(feet_centre(alpha), 2)}


def resize_rgba(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    # Premultiplied resampling avoids dark/green fringes on soft edges.
    return img.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--out", default=Path("public/mascot"), type=Path)
    args = ap.parse_args()

    src_bytes = args.input.read_bytes()
    src = np.array(Image.open(args.input).convert("RGBA"))
    sh, sw = src.shape[:2]
    keyed, method = to_alpha(src)

    frames: dict[str, np.ndarray] = {}
    for r in range(ROWS):
        for c in range(COLS):
            y0, y1 = round(r * sh / ROWS), round((r + 1) * sh / ROWS)
            x0, x1 = round(c * sw / COLS), round((c + 1) * sw / COLS)
            frames[GRID[r][c]] = clean(keyed[y0:y1, x0:x1])

    geo = {}
    for name, f in frames.items():
        x0, y0, x1, y1 = bbox(f[..., 3])
        geo[name] = (x0, y0, x1, y1, feet_centre(f[..., 3]))

    # Equalise the character size between rows, then fit ONE shared scale.
    def row_height(r: int) -> float:
        return float(np.median([geo[n][3] - geo[n][1] + 1 for n in GRID[r]]))

    row_factor = {r: row_height(0) / row_height(r) if r in NORMALISE_ROWS else 1.0 for r in range(ROWS)}
    factor = {GRID[r][c]: row_factor[r] for r in range(ROWS) for c in range(COLS)}
    max_up = max((g[3] - g[1] + 1) * factor[n] for n, g in geo.items())
    max_side = max(max(g[4] - g[0], g[2] + 1 - g[4]) * factor[n] for n, g in geo.items())
    scale = min((BASELINE + 1 - TOP_MARGIN) / max_up, (CELL / 2 - SIDE_MARGIN) / max_side)

    atlas = Image.new("RGBA", (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
    rects = {}
    for r in range(ROWS):
        for c in range(COLS):
            name = GRID[r][c]
            f = frames[name]
            x0, y0, x1, y1, px = geo[name]
            k = scale * factor[name]
            crop = Image.fromarray(f[y0 : y1 + 1, x0 : x1 + 1], "RGBA")
            w = max(1, round(crop.width * k))
            h = max(1, round(crop.height * k))
            sprite = resize_rgba(crop, (w, h))
            dx = round(PIVOT_X - (px - x0 + 0.5) * k)
            dy = BASELINE + 1 - h
            cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
            cell.alpha_composite(sprite, (dx, dy))
            atlas.alpha_composite(cell, (c * CELL, r * CELL))
            rects[name] = {"x": c * CELL, "y": r * CELL, "w": CELL, "h": CELL}

    args.out.mkdir(parents=True, exist_ok=True)
    png_path = args.out / "zuey-mascot.png"
    webp_path = args.out / "zuey-mascot.webp"
    atlas.save(png_path, optimize=True)
    atlas.save(webp_path, lossless=False, quality=90, alpha_quality=100, method=6, exact=False)

    # QA on the packed atlas (re-read from the PNG we ship).
    packed = np.array(Image.open(png_path).convert("RGBA"))
    qa = {}
    for name, rect in rects.items():
        a = packed[rect["y"] : rect["y"] + CELL, rect["x"] : rect["x"] + CELL, 3]
        m = measure(a)
        bx, by, bw, bh = m["bbox"]
        m["touchesEdge"] = bx == 0 or by == 0 or bx + bw >= CELL or by + bh >= CELL
        qa[name] = m
    base_dev = max(abs(m["baseline"] - BASELINE) for m in qa.values())
    pivot_dev = max(abs(m["pivotX"] - PIVOT_X) for m in qa.values())
    heights = [m["bbox"][3] for m in qa.values()]
    failures = [n for n, m in qa.items() if m["touchesEdge"]]

    animations = {}
    for anim, (loop, seq) in ANIMATIONS.items():
        total = sum(d for _, d in seq)
        animations[anim] = {
            "loop": loop,
            "fps": round(len(seq) * 1000 / total, 2),
            "frames": [{"name": n, **{k: rects[n][k] for k in ("x", "y", "w", "h")}, "durationMs": d} for n, d in seq],
            "reducedMotionFrame": seq[0][0],
        }

    manifest = {
        "version": 1,
        "image": {
            "webp": webp_path.name,
            "png": png_path.name,
            "width": atlas.width,
            "height": atlas.height,
            "webpBytes": webp_path.stat().st_size,
            "pngBytes": png_path.stat().st_size,
        },
        "cell": {"width": CELL, "height": CELL, "columns": COLS, "rows": ROWS},
        "pivot": {"x": PIVOT_X, "y": BASELINE},
        "baseline": BASELINE,
        "facing": {"walk": "right"},
        "frames": rects,
        "animations": animations,
        "expressions": EXPRESSIONS,
        "build": {
            "script": "scripts/build-mascot-atlas.py",
            "source": args.input.name,
            "sourceSha256": hashlib.sha256(src_bytes).hexdigest(),
            "sourceSize": [sw, sh],
            "background": method,
            "scale": round(scale, 5),
            "rowFactors": {str(r): round(v, 5) for r, v in row_factor.items()},
        },
        "qa": {
            "baselineMaxDeviationPx": base_dev,
            "pivotXMaxDeviationPx": round(pivot_dev, 2),
            "characterHeightPx": {"min": min(heights), "max": max(heights)},
            "tolerancePx": TOLERANCE,
            "frames": qa,
        },
    }
    (args.out / "manifest.json").write_bytes((json.dumps(manifest, indent=2) + "\n").encode("utf-8"))

    print(f"background={method} scale={scale:.4f}")
    print(f"png={png_path.stat().st_size}B webp={webp_path.stat().st_size}B")
    print(f"baseline max dev={base_dev}px pivotX max dev={pivot_dev:.2f}px heights={min(heights)}..{max(heights)}")
    for name, m in qa.items():
        print(f"  {name:13s} bbox={m['bbox']} baseline={m['baseline']} pivotX={m['pivotX']}")
    if base_dev > TOLERANCE or pivot_dev > TOLERANCE or failures:
        raise SystemExit(f"QA failed: baseline={base_dev} pivot={pivot_dev:.2f} edge={failures}")


if __name__ == "__main__":
    main()
