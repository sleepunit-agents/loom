// The page's ground, and its loader: 000h's contour field (living topographic lines, WebGL with a still fallback)
// over the wash, and its strands (a bundle of ribbons through a sine field) while a page loads. Both their own
// chunk: the first page never waits on them. Jonathan, 2026-10-29: "contour field is also fucking baller ... we
// might at least try that to see how it feels"; strands, "maybe as a loader ... very on brand with the whole
// loom thing".
import { ContourField } from '@/components/ui/contour-field';
import { Strands } from '@/components/ui/strands';

export function Contours() {
  return <div aria-hidden className="loom-ground pointer-events-none fixed inset-0 -z-10"><ContourField tone="warm" speed={0.5} intensity={0.85} /></div>;
}

export function Weaving() {
  return <div className="w-[min(420px,80vw)] overflow-hidden rounded-3xl"><Strands tone="pink" count={22} speed={1.1} height={150} aria-label="Loading" /></div>;
}
