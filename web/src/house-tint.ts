// The house icons' tint (app-icon.tsx): each icon is one greyscale image, coloured as the browser paints it by an SVG
// filter made from its key's ramp (house-ramp.ts). The filter reads each pixel's luminance, colours it from the ramp's
// table, and makes it as solid as it is bright up to the ramp's knee, so the art's black is clear and the key shows
// through: no square around the glyph on any key, in any look, lit or not.
//
// Why a filter and not a CSS mask: the art has several tones (a dark grey, a mid grey, white), each at its own place
// on the ramp; a mask has one colour. Why not images coloured ahead of time: the tints are the look's own tokens, per
// look and per contrast, and a filter follows what the page is wearing.
//
// Nothing is done per icon or per render. The filters are made once, and again only when <html>'s look, light or dark,
// or Higher contrast change. Which filter an icon wears is CSS: its nearest [data-tint] names the tint, and a lit key's
// own selector (the dock's current key, a window's title-strip key) picks the lit one.
import { parseColor, rampFor, tablesFor, type KeyColours } from './house-ramp';
import { TINTS, type Tint } from './tint';

/** Each tint's two filters: on a dark or light key (n) and on a lit, solid one (l). */
export const filterId = (tint: Tint, state: 'n' | 'l') => `loom-house-${tint}-${state}`;

/** Where a house icon sits on a lit key: solid tint behind it, so it wears the key's ink. */
export const LIT = ['.v-dock [data-part="lane"][data-active="true"]', '.next-app-key'] as const;

/** Which filter an icon wears. A custom property carries the tint's two down from the nearest [data-tint]; outside
 * any (nothing draws one there today) an icon is pink, never the raw art. In the page itself, not a stylesheet file,
 * so url(#…) is this document's whatever the browser. */
export const filterRules = (): string => TINTS.map((t) => `[data-tint="${t}"]{--loom-house:url(#${filterId(t, 'n')});--loom-house-lit:url(#${filterId(t, 'l')})}`).join('\n')
  + `\n.loom-house{filter:var(--loom-house,url(#${filterId('pink', 'n')}))}`
  + `\n:is(${LIT.join(',')}) .loom-house{filter:var(--loom-house-lit,url(#${filterId('pink', 'l')}))}`;

/** One filter: the luminance in every channel, coloured by the ramp's tables; the luminance again as how solid; the first inside the second. */
export function filterMarkup(id: string, k: KeyColours, lit: boolean, more: boolean): string {
  const t = tablesFor(rampFor(k, lit, more), more);
  const L = '0.2126 0.7152 0.0722 0 0';
  return `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">`
    + `<feColorMatrix in="SourceGraphic" type="matrix" values="${L} ${L} ${L} 0 0 0 0 1"/>`
    + `<feComponentTransfer result="c"><feFuncR type="table" tableValues="${t.r.join(' ')}"/><feFuncG type="table" tableValues="${t.g.join(' ')}"/><feFuncB type="table" tableValues="${t.b.join(' ')}"/></feComponentTransfer>`
    + `<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${L}"/>`
    + `<feComponentTransfer result="a"><feFuncA type="linear" slope="${t.slope}"/></feComponentTransfer>`
    + '<feComposite in="c" in2="a" operator="in"/></filter>';
}

/** Every tint's filters for a look's colours. */
export const defsMarkup = (keys: Record<Tint, KeyColours>, more: boolean): string => '<defs>'
  + TINTS.map((t) => filterMarkup(filterId(t, 'n'), keys[t], false, more) + filterMarkup(filterId(t, 'l'), keys[t], true, more)).join('') + '</defs>';

const SVG_NS = 'http://www.w3.org/2000/svg';
let defs: SVGSVGElement | null = null;
let probe: HTMLDivElement | null = null;

/** The look's colours as they're computed now: a hidden probe wears each token, and the browser resolves it. */
function colours(): { more: boolean; keys: Record<Tint, KeyColours> } {
  const root = document.documentElement;
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    probe.innerHTML = '<i data-c="ink" style="color:var(--v-ink)"></i><i data-c="on" style="color:var(--v-on-accent)"></i>'
      + TINTS.map((t) => `<i data-c="${t}" data-tint="${t}" style="color:var(--t,var(--loom-tint-${t}))"></i>`).join('');
    document.body.append(probe);
  }
  const c = (k: string) => parseColor(getComputedStyle(probe!.querySelector(`[data-c="${k}"]`)!).color);
  const base = { mode: root.dataset.mode === 'light' ? 'light' : 'dark', ink: c('ink'), onAccent: c('on') } as const;
  return { more: root.dataset.contrast === 'more', keys: Object.fromEntries(TINTS.map((t) => [t, { ...base, tint: c(t) }])) as Record<Tint, KeyColours> };
}

function paint(): void {
  const { more, keys } = colours();
  defs!.innerHTML = defsMarkup(keys, more);
}

/** The filters, once: in an SVG of no size at the end of <body> (their rules in a <style> in <head>), made again when
 * <html>'s look, mode or contrast change. Safe to call again, and where there is no page. */
export function installHouseTint(): void {
  if (defs || typeof document === 'undefined') return;
  if (!document.body) { document.addEventListener('DOMContentLoaded', installHouseTint, { once: true }); return; }
  defs = document.createElementNS(SVG_NS, 'svg');
  defs.setAttribute('aria-hidden', 'true');
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.setAttribute('data-loom-house', '');
  defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  document.body.append(defs);
  const style = document.createElement('style');
  style.dataset.loomHouse = '';
  style.textContent = filterRules();
  document.head.append(style);
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-look', 'data-mode', 'data-contrast'] });
}
