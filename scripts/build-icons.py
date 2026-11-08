#!/usr/bin/env python3
"""Export loom's app icons from the approved master (assets/icons/source/loom-master.png).

The mark is Mark's v7 fractal-L squircle, approved by Jonathan 2026-10-26 in
Discord #gallery. Re-run this after replacing the master; it rewrites every
file in assets/icons/ that src/ui/pwa.ts and render.ts point at.

    python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow
    /tmp/v/bin/python scripts/build-icons.py

What each export is:
  loom-512.png, loom-192.png  the squircle on transparent, for "any" purpose
  loom-maskable-512.png       full-bleed and opaque: the squircle zoomed until its
                              rounded edge is off the canvas, so a platform mask
                              (circle, rounded square) never shows a hole or rim
  loom-180.png                apple-touch-icon; iOS fills transparency black and
                              rounds the corners itself, so it is the maskable art
  loom-32.png                 the favicon, optically tuned: the weave turns to
                              noise at 32px, so it is softened and dimmed while
                              the cyan L fold is lifted, which keeps the letter
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'assets' / 'icons'
BG = (14, 14, 13, 255)  # #0E0E0D, the manifest's background_color


def master():
    src = Image.open(ICONS / 'source' / 'loom-master.png').convert('RGBA')
    r, g, b, a = src.split()
    # The generator left the inside at alpha ~252: make it solid, keep the edge's antialiasing.
    a = a.point(lambda v: 255 if v >= 240 else v)
    src = Image.merge('RGBA', (r, g, b, a))
    return src.crop(a.point(lambda v: 255 if v > 128 else 0).getbbox())


def square(art, margin=0.0):
    """The squircle centred on a transparent square canvas."""
    side = round(max(art.size) * (1 + 2 * margin))
    sq = Image.new('RGBA', (side, side))
    sq.paste(art, ((side - art.width) // 2, (side - art.height) // 2))
    return sq


def full_bleed(art):
    """The largest centred square whose whole border is solid art, so no mask shows the squircle's edge."""
    a = art.getchannel('A')
    side = min(art.size)
    while True:
        l, t = (art.width - side) // 2, (art.height - side) // 2
        edge = [a.getpixel((x, y)) for i in range(side) for x, y in ((l + i, t), (l + i, t + side - 1), (l, t + i), (l + side - 1, t + i))]
        if min(edge) == 255:
            break
        side -= 4
    out = Image.new('RGBA', (side, side), BG)
    out.alpha_composite(art.crop((l, t, l + side, t + side)))
    return out.convert('RGB')


def favicon(sq, n=32):
    m = sq.resize((256, 256), Image.LANCZOS)
    rgb = m.convert('RGB').filter(ImageFilter.GaussianBlur(2))
    r, g, b = rgb.split()
    cyan = ImageChops.subtract(ImageChops.multiply(g, b), r).point(lambda v: min(255, v * 2)).filter(ImageFilter.GaussianBlur(3))
    rgb = Image.composite(ImageEnhance.Brightness(rgb).enhance(1.15), ImageEnhance.Brightness(rgb).enhance(0.75), cyan)
    out = ImageEnhance.Color(rgb).enhance(1.15).convert('RGBA')
    out.putalpha(m.getchannel('A'))
    return out.resize((n, n), Image.LANCZOS)


def save(img, name, n):
    img.resize((n, n), Image.LANCZOS).save(ICONS / name, optimize=True)


art = master()
sq = square(art, margin=0.02)
save(sq, 'loom-512.png', 512)
save(sq, 'loom-192.png', 192)
bleed = full_bleed(art)
save(bleed, 'loom-maskable-512.png', 512)
save(bleed, 'loom-180.png', 180)
favicon(sq).save(ICONS / 'loom-32.png', optimize=True)
