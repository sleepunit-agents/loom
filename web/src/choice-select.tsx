// A choice of many (more than a few chips hold): 000h's select. Its own chunk (Radix's select, its positioning and
// scrolling are heavy), loaded with the first form that needs it.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePortalContainer } from '@/components/ui/portal-container';

export default function ChoiceSelect({ id, value, options, set }: { id: string; value: string; options: { value: string; label: string }[]; set: (v: string) => void }) {
  // In a tile (the tiled desktop), the browser's own list: Radix's select is always modal to the whole screen (it hides
  // every other tile from a screen reader while it's open), and a tile's pop-ups are its own (desk-tiling.md).
  if (usePortalContainer()) return (
    <select id={id} className="loom-native-select" value={value} onChange={(e) => set(e.target.value)}>
      {options.map((o) => <option key={o.value || '_'} value={o.value}>{o.label}</option>)}
    </select>
  );
  return (
    <Select value={value === '' ? '_' : value} onValueChange={(v) => set(v === '_' ? '' : v)}>
      <SelectTrigger id={id} className="w-full min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o.value || '_'} value={o.value || '_'}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}
