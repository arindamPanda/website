#!/usr/bin/env python3
"""Bake the hero portrait photo into the density grid the page renders from.

Run this after changing SOURCE or replacing the image it points at:

    python3 tools/ascii_portrait.py

Writes js/portrait-grid.js and prints an ASCII preview so the tuning constants
below can be adjusted by eye.
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "Arindam.jpg"
OUTPUT = ROOT / "js" / "portrait-grid.js"

# Logical grid. Monospace cells are roughly 0.55 as wide as they are tall, so
# rows are derived from the image aspect corrected by that factor.
COLS = 112
# Must match the renderer, which sizes glyphs as min(cellH, cellW / 0.6): any
# lower and cells are taller than the glyph can fill, wasting vertical
# resolution. Keep the two in step.
CELL_ASPECT = 0.60

# Subject mask. Anything appreciably darker OR more colourful than the neutral
# backdrop is the subject; the backdrop is neither. Chroma is used only
# to decide subject-vs-background — never added to density, because skin is
# saturated and adding it flattens the shading that models the face.
MASK_LUMA = (0.16, 0.34)
MASK_CHROMA = (0.10, 0.22)

# Tone comes from luminance alone. These two constants are IMAGE-SPECIFIC —
# re-check them in the preview whenever SOURCE changes.
#
# The percentiles are taken over the masked subject, not the whole frame, and
# WHICH of the two is right depends on the backdrop. This photo is shot against
# paper-white — luma is exactly 1.0 and chroma exactly 0.0 over 38% of the frame
# — so whole-image percentiles return 0.118–1.000. Pinning the bright end to
# white drives the entire face into the dark half of the range: it comes out a
# flat mass with no modelling, and the shirt a solid slab. Over the subject the
# same percentiles give 0.104–0.631 and the face reads.
#
# A photo shot against a *light-grey wall* flips this back, and the previous
# source was one: there the wall leaks into the chroma mask, the "subject" spans
# the full 0–1 anyway, and normalising over it does nothing. If you swap in such
# an image and the face goes flat, try the whole frame — `np.percentile(luma, …)`.
TONE_CLIP = (4.0, 96.0)
TONE_GAMMA = 0.9

# Minimum ink for anything inside the mask, so the subject's lightest areas —
# forehead, cheeks — stay present instead of dissolving into the backdrop. This
# is the single dial for "how visible is the subject at its lightest"; raising it
# lifts them without touching the background, whose mask is ~0. It mattered more
# for a pale-shirted subject than it does here; lower it toward 0.12 if the face
# reads too heavy.
FLOOR = 0.22

# The dark theme paints LIGHT ink, so running it off the same darkness channel
# renders a photographic negative: the hair, being densest, becomes the brightest
# mass and the lit face falls into a hollow. The grid therefore carries a second
# channel with the tone inverted, so ink tracks how far a pixel stands from the
# page in whichever theme is showing — dark ink for the shadows on cream, light
# ink for the highlights on brown.
#
# Inverting alone is not enough, and this is the trap: it drops the subject out
# of the mask, the backdrop lights up solid, and the portrait ends up floating on
# a bright card. The mask still gates it, so only the tone flips. This floor is
# then the silhouette dial — the hair is near-black and would vanish into the
# page without it, taking the head's outline with it. Raise it if the hair
# dissolves, lower it if the head reads as a flat slab.
DARK_FLOOR = 0.28

# Column is treated as holding subject when above this share of the densest one.
INK_THRESHOLD = 0.06

LEVELS = 64
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+-"

# Everything the pool may be drawn from, filtered below by measured ink coverage.
CANDIDATES = ("abcdefghijklmnopqrstuvwxyz"
              "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
              "0123456789"
              ".,:;'\"`^~-_+=<>*#%@$&/\\|()[]{}?!")
# The browser draws every cell from ONE pool and lets opacity carry the tone,
# rather than picking a heavier glyph for darker cells. Glyph weight can't convey
# darkness and stay varied: ink coverage spans only 0.0107–0.1421, so the darkest
# cells would be stuck with `N B @ M W` — no lowercase, no small digits.
#
# Members are taken from a mid-coverage band so they all lay down near-identical
# ink. That is what makes a uniform random pick safe: swapping one glyph for
# another doesn't shift the cell's brightness.
POOL_BAND = 0.35  # fraction of the coverage range to keep, centred
# Members must also SPREAD their ink, not just have the right amount of it: a
# glyph like `|` packs it into a thin bar and reads as a directional streak
# rather than even tone. Minimum share of the cell box the ink must span.
POOL_MIN_SPREAD = 0.45
MONO_FONT = "/System/Library/Fonts/Menlo.ttc"
FALLBACK_POOL = "=><|?ilc[]vLjz7x*t{}fsTJY1CunyFI2oe3wVhk%5Za4SXP$E"
FALLBACK_WEIGHTS = [1.0] * len(FALLBACK_POOL)

# Tone in the terminal preview only — see preview().
PREVIEW_RAMP = " .:-=+*#%@"

assert len(ALPHABET) == LEVELS, "alphabet must have one symbol per level"


def build_pool():
    """Glyphs of near-equal ink coverage, measured by rendering each one.

    Returns the pool and a matching list of relative weights. The renderer picks
    from the pool uniformly and varies brightness instead of weight, so every
    part of the portrait — including the darkest — can show mixed case, digits
    and symbols.

    The weights matter: band members still span ~1.85x in coverage, and picking
    among them at random would inject brightness jitter several times larger than
    the facial modelling itself. The renderer divides each cell's opacity by its
    glyph's weight, so what the eye integrates matches the intended tone whatever
    glyph landed there.
    """
    try:
        font = ImageFont.truetype(MONO_FONT, 64)
    except OSError:
        return FALLBACK_POOL, FALLBACK_WEIGHTS

    coverage = {}
    spread = {}
    for ch in CANDIDATES:
        tile = Image.new("L", (64, 96), 0)
        ImageDraw.Draw(tile).text((8, 8), ch, font=font, fill=255)
        pixels = np.asarray(tile, dtype=np.float32) / 255.0
        coverage[ch] = float(pixels.mean())

        ys, xs = np.nonzero(pixels > 0.3)
        if ys.size:
            spread[ch] = (((xs.max() - xs.min() + 1) / 40.0),
                          ((ys.max() - ys.min() + 1) / 64.0))
        else:
            spread[ch] = (0.0, 0.0)

    lo = min(coverage.values())
    hi = max(coverage.values())
    edge = (1.0 - POOL_BAND) / 2.0
    low = lo + (hi - lo) * edge
    high = lo + (hi - lo) * (1.0 - edge)

    pool = sorted((ch for ch, v in coverage.items()
                   if low <= v <= high
                   and min(spread[ch]) >= POOL_MIN_SPREAD),
                  key=lambda ch: coverage[ch])

    mean = sum(coverage[ch] for ch in pool) / len(pool)
    weights = [round(coverage[ch] / mean, 3) for ch in pool]
    return "".join(pool), weights


def smoothstep(x, edge0, edge1):
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def build_grid(image):
    # Crisp the eye and mouth edges before the downsample averages them away.
    image = image.filter(ImageFilter.UnsharpMask(radius=3, percent=90, threshold=2))
    a = np.asarray(image, dtype=np.float32) / 255.0

    luma = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    top = a.max(axis=2)
    chroma = np.where(top > 0, (top - a.min(axis=2)) / np.maximum(top, 1e-6), 0.0)

    mask = np.maximum(smoothstep(1.0 - luma, *MASK_LUMA),
                      smoothstep(chroma, *MASK_CHROMA))
    # Despeckle so the backdrop gradient doesn't sparkle.
    mask = np.asarray(
        Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(7)),
        dtype=np.float32,
    ) / 255.0

    # Fall back to the whole frame if the mask caught nothing, so a badly tuned
    # MASK_* pair fails as a washed-out preview rather than an empty-slice error.
    subject = luma[mask > 0.5]
    lo, hi = np.percentile(subject if subject.size else luma, TONE_CLIP)
    tone = np.clip((hi - luma) / max(hi - lo, 1e-6), 0.0, 1.0) ** TONE_GAMMA
    # One channel per theme, differing only in which end of the tone range gets
    # the ink. Both stay mask-multiplied — see DARK_FLOOR.
    density = mask * (FLOOR + (1.0 - FLOOR) * tone)
    density_dark = mask * (DARK_FLOOR + (1.0 - DARK_FLOOR) * (1.0 - tone))

    # Average the full-resolution density into cells, so fine structure that a
    # downsample-then-measure order would lose still reaches the grid.
    rows = max(1, round(COLS * (image.height / image.width) * CELL_ASPECT))

    def to_cells(d):
        c = np.asarray(
            Image.fromarray((d * 255).astype(np.uint8))
            .resize((COLS, rows), Image.Resampling.BOX),
            dtype=np.float32,
        ) / 255.0
        # No floor subtraction here. It used to rescale by (cells - FLOOR*0.8) to
        # keep the backdrop clean, but the backdrop is already ~0 — its mask is ~0,
        # and density is mask-multiplied. All the subtraction did was cancel FLOOR,
        # dropping the shirt to roughly the background's own brightness.
        return np.clip(c, 0.0, 1.0)

    light = to_cells(density)
    shift = centre_shift(light)
    return COLS, rows, shift_columns(light, shift), shift_columns(to_cells(density_dark), shift)


def centre_shift(cells):
    """How far to slide the subject to even out the gutters either side of it.

    A subject sitting off-centre — the previous source sat hard against the right
    edge with a quarter of the width empty on the left — leaves the renderer's
    edge fade eating into one shoulder while the other side is blank. Half the
    difference re-centres it without cropping the subject or resizing the frame.

    Measured on the light channel alone and applied to both: the two channels ink
    opposite ends of the tone range, so measuring each separately can hand back
    different shifts and slide the themes out of register with each other.

    The current source is already centred, so this returns 0. Kept for the next
    swap, which may not be.
    """
    _, cols = cells.shape
    column = cells.sum(axis=0)
    inked = np.where(column > column.max() * INK_THRESHOLD)[0]
    if inked.size == 0:
        return 0
    return (int(inked[0]) - (cols - 1 - int(inked[-1]))) // 2


def shift_columns(cells, shift):
    """Slide by `shift` columns, padding the vacated ones."""
    if shift == 0:
        return cells
    _, cols = cells.shape
    out = np.zeros_like(cells)
    if shift > 0:                       # subject sits right — move it left
        out[:, :cols - shift] = cells[:, shift:]
    else:                               # subject sits left — move it right
        out[:, -shift:] = cells[:, :cols + shift]
    return out


def preview(cols, rows, cells):
    """Show the density map as a tone ramp — deliberately NOT what ships.

    The browser draws a uniform glyph pool and varies opacity, which a terminal
    cannot show; rendering that here would be indistinguishable from noise. This
    preview exists to judge the density map (does the face read?), so it uses a
    plain ramp. Glyph variety is verified in the browser, not here.
    """
    for y in range(rows):
        line = []
        for x in range(cols):
            v = cells[y, x]
            line.append(" " if v < 0.05
                        else PREVIEW_RAMP[min(len(PREVIEW_RAMP) - 1,
                                              int(v * len(PREVIEW_RAMP)))])
        print("".join(line))


def main():
    if not SOURCE.exists():
        sys.exit(f"missing source image: {SOURCE}")

    pool, weights = build_pool()
    with Image.open(SOURCE) as image:
        source_w, source_h = image.width, image.height
        cols, rows, cells, cells_dark = build_grid(image.convert("RGB"))

    print("light theme — ink follows the shadows:")
    preview(cols, rows, cells)
    print("\ndark theme — ink follows the highlights, hair held by DARK_FLOOR:")
    preview(cols, rows, cells_dark)

    upper = sum(c.isupper() for c in pool)
    lower = sum(c.islower() for c in pool)
    digit = sum(c.isdigit() for c in pool)
    print(f"\n{cols}x{rows} cells, {int((cells >= 0.05).sum())} inked light, "
          f"{int((cells_dark >= 0.05).sum())} inked dark", file=sys.stderr)
    print(f"pool: {len(pool)} glyphs ({upper} upper, {lower} lower, {digit} digit, "
          f"{len(pool) - upper - lower - digit} symbol)\n  {pool}", file=sys.stderr)

    def encode(c):
        levels = np.clip((c * LEVELS).astype(int), 0, LEVELS - 1)
        return "\\n".join(
            "".join(ALPHABET[levels[y, x]] for x in range(cols)) for y in range(rows)
        )

    data, data_dark = encode(cells), encode(cells_dark)

    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(
        f"/* Generated by tools/ascii_portrait.py from {SOURCE.name} — do not edit by hand.\n"
        f"   Re-run `python3 tools/ascii_portrait.py` after replacing {SOURCE.name}. */\n"
        "window.PORTRAIT_GRID = {\n"
        f"    cols: {cols},\n"
        f"    rows: {rows},\n"
        f"    aspect: '{source_w} / {source_h}',\n"
        f"    levels: {LEVELS},\n"
        f"    alphabet: '{ALPHABET}',\n"
        # json.dumps, not repr: the pool contains ", ' and \ and this has to
        # land as a valid JS string literal.
        f"    pool: {json.dumps(pool)},\n"
        # Same order as pool — the renderer indexes them in lockstep.
        f"    weights: {json.dumps(weights)},\n"
        f"    data: '{data}',\n"
        # Same grid, tone inverted, for the dark theme's light ink — see DARK_FLOOR.
        f"    dataDark: '{data_dark}'\n"
        "};\n"
    )
    print(f"wrote {OUTPUT.relative_to(ROOT)}", file=sys.stderr)


if __name__ == "__main__":
    main()
