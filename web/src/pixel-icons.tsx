// The household's pixel icons, worn (app-icon.tsx loads this chunk only for someone with "Pixel icons" on and a set
// installed). Each icon is the household's 32×32 PNG at 1× (whole pixels: image-rendering pixelated), recoloured to its
// key's ramp by an SVG filter (pixel-ramp.ts): feColorMatrix puts each pixel's luminance in all three channels, then
// feComponentTransfer's tables map it onto the ramp. The browser applies it as it paints, so nothing is redrawn by the
// page per icon or per render, and the ramp follows the look's own colours (looks/looks.css): when the look, its light
// or dark, or Higher contrast changes, the filters are rebuilt from what's computed then, once.
//
// Why a filter and not PNGs baked per ramp at install: the ramp's middle is each key's tint, and the tints are the
// look's (looks.css, per look and per contrast). Baked, the server would have to carry a copy of every look's palette
// and re-bake on every change to it; filtered, the page reads the palette it's already wearing.
import { useState, type ReactNode } from 'react';
import { parseColor, rampFor, tablesFor, type KeyColours } from './pixel-ramp';
import { TINTS, type Tint } from './tint';
import './pixel-icons.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Each tint's three filters: normal (n), normal with a line-only icon inverted first (ni), and lit (l). */
export const filterId = (tint: Tint, state: 'n' | 'ni' | 'l') => `loom-pix-${tint}-${state}`;

let defs: SVGSVGElement | null = null;
let probe: HTMLDivElement | null = null;

/** The look's colours as they're computed now: a hidden probe wears each token, and the browser resolves it. */
function colours(): { mode: 'light' | 'dark'; more: boolean; keys: Record<Tint, KeyColours> } {
  const root = document.documentElement;
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    probe.innerHTML = '<i data-c="canvas" style="color:var(--v-canvas)"></i><i data-c="ink" style="color:var(--v-ink)"></i><i data-c="on" style="color:var(--v-on-accent)"></i>'
      + TINTS.map((t) => `<i data-c="${t}" data-tint="${t}" style="color:var(--t)"></i>`).join('');
    document.body.append(probe);
  }
  const c = (k: string) => parseColor(getComputedStyle(probe!.querySelector(`[data-c="${k}"]`)!).color);
  const mode = root.dataset.mode === 'light' ? 'light' : 'dark';
  const base = { mode, canvas: c('canvas'), ink: c('ink'), onAccent: c('on') } as const;
  return { mode, more: root.dataset.contrast === 'more', keys: Object.fromEntries(TINTS.map((t) => [t, { ...base, tint: c(t) }])) as Record<Tint, KeyColours> };
}

/** Build (or rebuild) every tint's filters from the look being worn. */
function paint(): void {
  const { mode, more, keys } = colours();
  // A line-only icon is inverted so its lines glow: on a dark key only. Daylight's normal key is light, where light
  // lines would vanish, so there its ink stays the shadow, as it does on every lit key.
  const invertLines = mode === 'dark';
  const filter = (id: string, k: KeyColours, lit: boolean, invert: boolean) => {
    const [r, g, b] = tablesFor(rampFor(k, lit, more), invert, more);
    return `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">`
      + '<feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0"/>'
      + `<feComponentTransfer><feFuncR type="table" tableValues="${r.join(' ')}"/><feFuncG type="table" tableValues="${g.join(' ')}"/><feFuncB type="table" tableValues="${b.join(' ')}"/></feComponentTransfer></filter>`;
  };
  defs!.innerHTML = '<defs>' + TINTS.map((t) => filter(filterId(t, 'n'), keys[t], false, false) + filter(filterId(t, 'ni'), keys[t], false, invertLines)
    + filter(filterId(t, 'l'), keys[t], true, false)).join('') + '</defs>';
}

/** The filters, once: in an SVG of no size at the end of <body>, rebuilt when <html>'s look, mode or contrast change. */
function install(): void {
  if (defs) return;
  defs = document.createElementNS(SVG_NS, 'svg');
  defs.setAttribute('aria-hidden', 'true');
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.setAttribute('data-loom-pix', '');
  defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  document.body.append(defs);
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-look', 'data-mode', 'data-contrast'] });
}
install();

/** An app's pixel icon: its tint's ramp (lit on the current key), a line-only icon inverted unless lit. Its line icon if the file won't load. */
export default function PixelIcon({ app, v, tint, lit, line, fallback }: { app: string; v: string; tint: Tint; lit?: boolean; line?: boolean; fallback: ReactNode }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <>{fallback}</>;
  return (
    <img className="loom-pix" src={`/pixel-icons/${app}.png?v=${encodeURIComponent(v)}`} width={32} height={32} alt="" draggable={false} decoding="async"
      data-tint={tint} data-lit={lit ? '' : undefined} data-line={line ? '' : undefined} data-app={app} onError={() => setBroken(true)} />
  );
}
