#!/usr/bin/env python3
"""Generate the Twin-Brain extension icons without any third-party library.

Pure stdlib PNG writer + signed-distance rendering with 3x supersampling, so the
shapes stay smooth at 128px and still read as a mark at 16px.

Usage:  ./.venv/bin/python scripts/make_icons.py
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "extension" / "icons"
SIZES = (16, 32, 48, 128)

# brand palette (matches popup.css / options.css)
BG_TOP = (26, 33, 48)
BG_BOTTOM = (13, 17, 23)
BORDER = (110, 231, 183)
LEFT = (95, 224, 171)      # mint hemisphere
RIGHT = (79, 195, 247)     # sky hemisphere
DARK = (15, 18, 24)


# --------------------------------------------------------------------------- #
# png writer
# --------------------------------------------------------------------------- #
def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: Path, size: int, pixels: bytearray) -> None:
    raw = bytearray()
    for y in range(size):
        raw.append(0)                                   # filter: none
        raw += pixels[y * size * 4:(y + 1) * size * 4]
    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + _chunk(b"IEND", b""))
    path.write_bytes(png)


# --------------------------------------------------------------------------- #
# signed distances -> coverage
# --------------------------------------------------------------------------- #
def sd_rounded_box(x: float, y: float, cx: float, cy: float,
                   hw: float, hh: float, r: float) -> float:
    dx = abs(x - cx) - (hw - r)
    dy = abs(y - cy) - (hh - r)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    return outside + inside - r


def sd_circle(x: float, y: float, cx: float, cy: float, r: float) -> float:
    return math.hypot(x - cx, y - cy) - r


def coverage(sd: float, pixel: float) -> float:
    """1.0 fully inside, 0.0 fully outside, feathered across one pixel."""
    return max(0.0, min(1.0, 0.5 - sd / max(pixel, 1e-9)))


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def over(dst: tuple[float, float, float, float], src: tuple[int, int, int], a: float):
    """alpha-composite src(a) over dst."""
    sa = a
    da = dst[3]
    oa = sa + da * (1 - sa)
    if oa <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    return ((src[0] * sa + dst[0] * da * (1 - sa)) / oa,
            (src[1] * sa + dst[1] * da * (1 - sa)) / oa,
            (src[2] * sa + dst[2] * da * (1 - sa)) / oa,
            oa)


# --------------------------------------------------------------------------- #
# the mark
# --------------------------------------------------------------------------- #
def sample(x: float, y: float, size: int) -> tuple[float, float, float, float]:
    """x, y in [0,1). Returns premultiplied-ish RGBA floats in 0..255 / 0..1."""
    px = 1.0 / size                                      # one output pixel, in unit space
    col: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)

    # background plate
    bg_sd = sd_rounded_box(x, y, 0.5, 0.5, 0.5, 0.5, 0.24)
    bg_cov = coverage(bg_sd, px)
    if bg_cov <= 0:
        return col
    shade = 1.0 - (y * 0.75 + x * 0.25)                  # soft top-left light
    plate = mix(BG_BOTTOM, BG_TOP, shade)
    col = over(col, plate, bg_cov)

    # hairline brand border, just inside the plate edge
    ring = coverage(bg_sd, px) - coverage(bg_sd + 0.045, px)
    if ring > 0:
        col = over(col, BORDER, ring * 0.32)

    # two hemispheres facing each other, split by a dark gap
    lob_r = 0.235
    left_sd = sd_circle(x, y, 0.335, 0.515, lob_r)
    right_sd = sd_circle(x, y, 0.665, 0.515, lob_r)
    gap = sd_rounded_box(x, y, 0.5, 0.515, 0.028, 0.255, 0.028)
    gap_cov = coverage(gap, px)

    for sd, color, alpha_boost in ((left_sd, LEFT, 0.0), (right_sd, RIGHT, alpha_boost_of(size))):
        cov = coverage(sd, px) * (1.0 - gap_cov)
        if cov > 0:
            # inner shading so the lobes look like bodies, not stickers
            depth = max(0.0, min(1.0, (-sd / lob_r) * 0.85 + 0.25))
            tinted = mix(color, (255, 255, 255), 0.22 * depth)
            col = over(col, tinted, cov * (0.94 + alpha_boost))

    # neurons: only where they survive downscaling
    if size >= 48:
        dots = ((0.29, 0.44), (0.375, 0.56), (0.30, 0.63),
                (0.71, 0.44), (0.625, 0.56), (0.70, 0.63))
        for dx, dy in dots:
            d = coverage(sd_circle(x, y, dx, dy, 0.034), px)
            if d > 0:
                col = over(col, DARK, d * 0.72)

    # stem that joins the two lobes at the bottom (the "twin" link)
    link = coverage(sd_rounded_box(x, y, 0.5, 0.80, 0.19, 0.026, 0.026), px)
    if link > 0:
        col = over(col, mix(LEFT, RIGHT, 0.5), link * 0.85)

    return col


def alpha_boost_of(size: int) -> float:
    return 0.0


def render(size: int) -> bytearray:
    pixels = bytearray(size * size * 4)
    sub = 3                                               # 3x3 supersampling
    step = 1.0 / (size * sub)
    for py in range(size):
        for pxx in range(size):
            r = g = b = a = 0.0
            n = sub * sub
            for sy in range(sub):
                for sx in range(sub):
                    x = (pxx + (sx + 0.5) / sub) / size
                    y = (py + (sy + 0.5) / sub) / size
                    cr, cg, cb, ca = sample(x, y, size)
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
            r, g, b, a = r / n, g / n, b / n, a / n
            i = (py * size + pxx) * 4
            pixels[i] = max(0, min(255, round(r)))
            pixels[i + 1] = max(0, min(255, round(g)))
            pixels[i + 2] = max(0, min(255, round(b)))
            pixels[i + 3] = max(0, min(255, round(a * 255)))
    return pixels


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = ICON_DIR / f"icon-{size}.png"
        write_png(path, size, render(size))
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
