# loom's house icons

loom's own icon for each app: what the dock's keys, a window's title-strip key, the launcher's tiles, the app switcher
and any small row draw (`web/src/app-icon.tsx`). An app with no file here keeps its line icon until its art is drawn.

## What's here

- `source/<app>-src.png`: the art, as the artist delivered it.
- `<app>.png`: the 128 x 128 master. `<app>.small.png`: 32 x 32, made from the art, for small slots and 1x screens.
- `index.ts`: the list the web app reads. Written by the script; `index.test.ts` holds it to the files.

`<app>` is the app's **id** in its registration (`web/src/pieces/*/registration.ts`: `inbox`, `tasks`, `tempo`, …),
never its title: titles are renamed. The dock's two keys that aren't apps are `home` and `launcher`.

## The art

Greyscale on pure black, square, drawn to read at 32 px. Colour is thrown away; only luminance is used
(`web/src/house-ramp.ts`):

- black is clear: the key shows through, so the background must be pure black to the edges;
- mid grey (about 50%) is the key's tint; darker greys are the tint, thinner;
- white is the highlight (near white on a dark look; the tint's dark shade on the light look, where the glyph is dark
  on light); lighter greys are partway there.

No frame or plate (the key is the plate), no text, no hairlines: the same file is drawn at 16 px.

## Replacing or adding an icon

Name the art `<app>-src.png` (any size from about 512 px), put it in a directory, and run, from the repo's root:

    python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow
    /tmp/v/bin/python scripts/build-house-icons.py <directory>

That copies the art into `source/`, makes both files for every icon in `source/` again, and rewrites `index.ts`. With
no directory it only makes them again from `source/`. Commit all of it. To take an icon away, delete its three files
and run the script with no directory.
