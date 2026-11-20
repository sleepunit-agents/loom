#!/usr/bin/env python3
"""Make loom's house icons (web/src/assets/house-icons/) from the art.

    python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow
    /tmp/v/bin/python scripts/build-house-icons.py [<directory of <app>-src.png>]

The art is kept beside the icons, in source/. Given a directory, its `<app>-src.png` files are copied into source/
first (replacing an app's, or adding one); then everything in source/ is made again.

Each `<app>-src.png` becomes `<app>.png` and `<app>.small.png`, where <app> is the app's id in its registration
(web/src/pieces/*/registration.ts: `inbox`, `tasks`, …; the dock's own two keys are `home` and `launcher`). Then index.ts, the list the
web app draws from, is rewritten from the files there. To take an icon away, delete its three files and run this.

The art (README.md beside the icons): greyscale on pure black, square, drawn for 32 px. What this does to it:
  - drops colour and transparency (flattened onto black), pads to a square with black;
  - scales to 128 x 128 with Lanczos: the master, four times the 32 px it's drawn at, enough for a 3x screen;
  - and again, from the art and not from the master, to 32 x 32: what a 16 px slot draws (1:1 on a 2x screen, 2:1 on
    a 1x one), since a browser taking 128 px down to 16 in one step is softer than Lanczos is;
  - sets anything nearly black to black, so a generator's noise in the background can't show as a faint square;
  - writes 8-bit greyscale, optimised.
It does not stretch levels or sharpen: the tones are the artist's (black, a dark grey, a mid grey, white).
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'web' / 'src' / 'assets' / 'house-icons'
SOURCE = OUT / 'source'
SIZE = 128
SMALL = 32
FLOOR = 6  # of 255: at or under this is background
APP = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def master(path: Path, size: int):
    from PIL import Image

    art = Image.open(path).convert('RGBA')
    flat = Image.new('RGBA', art.size, (0, 0, 0, 255))
    flat.alpha_composite(art)
    grey = flat.convert('L')
    side = max(grey.size)
    square = Image.new('L', (side, side), 0)
    square.paste(grey, ((side - grey.width) // 2, (side - grey.height) // 2))
    small = square.resize((size, size), Image.LANCZOS, reducing_gap=3.0)
    return small.point(lambda v: 0 if v <= FLOOR else v)


def index() -> list[str]:
    apps = sorted(p.stem for p in OUT.glob('*.png') if '.' not in p.stem)
    for app in apps:
        if not (OUT / f'{app}.small.png').exists():
            raise SystemExit(f'{app}.png has no {app}.small.png beside it: make both from the art')
    name = lambda app: re.sub(r'-(.)', lambda m: m.group(1).upper(), app)  # noqa: E731
    lines = [
        '// Written by scripts/build-house-icons.py from the files beside it: do not edit (index.test.ts checks it).',
        '// ?no-inline: each icon is a file of its own in the build, named by its content, never text inside the script.',
        *[f"import {name(app)} from './{app}.png?no-inline';\nimport {name(app)}Small from './{app}.small.png?no-inline';" for app in apps],
        '',
        "/** loom's own icon for an app, by the app's id in its registration: the built files' addresses, the 128 px",
        " * master (`art`) and the 32 px one a 16 px slot draws (`small`). An app that isn't here has no art yet and keeps",
        ' * its line icon (app-icon.tsx). */',
        'export const HOUSE_ICONS: Readonly<Record<string, { art: string; small: string }>> = {',
        *[f"  {app if app == name(app) else repr(app)}: {{ art: {name(app)}, small: {name(app)}Small }}," for app in apps],
        '};',
        '',
    ]
    (OUT / 'index.ts').write_text('\n'.join(lines))
    return apps


def main(argv: list[str]) -> int:
    if len(argv) > 2 or (len(argv) == 2 and argv[1] in ('-h', '--help')):
        print(__doc__)
        return 2
    SOURCE.mkdir(parents=True, exist_ok=True)
    if len(argv) == 2:
        given = sorted(Path(argv[1]).glob('*-src.png'))
        if not given:
            print(f'no <app>-src.png in {argv[1]}', file=sys.stderr)
            return 1
        for art in given:
            if art.resolve().parent != SOURCE.resolve():
                shutil.copyfile(art, SOURCE / art.name)
    for art in sorted(SOURCE.glob('*-src.png')):
        app = art.name[: -len('-src.png')]
        if not APP.match(app):
            print(f'{art.name}: "{app}" is not an app id (lower case letters, digits and single hyphens)', file=sys.stderr)
            return 1
        for size, file in ((SIZE, f'{app}.png'), (SMALL, f'{app}.small.png')):
            master(art, size).save(OUT / file, optimize=True)
            print(f'{file}  {(OUT / file).stat().st_size} bytes')
    print('index.ts:', ', '.join(index()))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
