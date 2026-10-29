// A choice of many (more than a few chips hold): 000h's select. Its own chunk (Radix's select, its positioning and
// scrolling are heavy), loaded with the first form that needs it.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function ChoiceSelect({ id, value, options, set }: { id: string; value: string; options: { value: string; label: string }[]; set: (v: string) => void }) {
  return (
    <Select value={value === '' ? '_' : value} onValueChange={(v) => set(v === '_' ? '' : v)}>
      <SelectTrigger id={id} className="w-full min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o.value || '_'} value={o.value || '_'}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}
