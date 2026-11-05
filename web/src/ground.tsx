// The page's ground: 000h's contour field (living topographic lines, WebGL with a still fallback) over the wash.
// Its own chunk: the first page never waits on it. Jonathan, 2026-10-29: "contour field is also fucking baller ...
// we might at least try that to see how it feels"; then "we're too zoomed in" (--field-zoom).
import { ContourField } from '@/components/ui/contour-field';
import { DepthBackground } from '@/components/ui/depth-background';

/** --field-zoom (index.css) sets how much terrain shows; a dev knob, localStorage 'loom-contour-zoom', tries others. */
export function Contours() {
  let zoom: string | undefined;
  try { zoom = localStorage.getItem('loom-contour-zoom') ?? undefined; } catch { /* private window */ }
  return <div aria-hidden className="loom-ground pointer-events-none fixed inset-0 -z-10" style={zoom ? ({ '--field-zoom': zoom } as React.CSSProperties) : undefined}>
    <ContourField tone="warm" speed={0.5} intensity={0.85} /></div>;
}

/** The other trial ground: 000h's depth background, its contour look (contours on three planes, drifting with the
 * pointer and the scroll), over the wash. Jonathan, 2026-10-29: "lets enable that as one of our choices too". */
export function Depth() {
  return <div aria-hidden className="loom-ground pointer-events-none fixed inset-0 -z-10"><DepthBackground variant="contour" density={1} intensity={1} />
    <GlowFilter /></div>;
}

/** The glow on the depth background's lines (looks.css: filter: var(--glow-ground), url(#loom-neon-glow) where a look
 * glows): each line's own colour, blurred under it. */
function GlowFilter() {
  return <svg width="0" height="0" className="absolute" aria-hidden focusable="false"><filter id="loom-neon-glow" x="-10%" y="-10%" width="120%" height="120%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter></svg>;
}
