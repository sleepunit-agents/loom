/** A ticket chosen inside a brick: the member types words of its title, or its id, and picks one of the tickets
 * found. The page has no native picker, and a ticket's id is not something a member remembers. What is typed is
 * this page's state alone; the caller is given a ticket's id once one is chosen or typed exactly.
 *
 * The search is the desktop's own rule for "Search tasks" (pieces/tasks/shared-view.tsx): every word typed is
 * somewhere in the ticket, in any case. It runs over the tickets the caller has read (the member's readable
 * tickets, by id and title); loom has no ticket search read of its own. */
export type Pickable = { id: string; title: string };
export const pickerResults = 6;
export function ticketMatches<T extends Pickable>(tickets: readonly T[], typed: string): T[] {
  const sought = typed.toLowerCase().match(/\S+/g);
  if (!sought) return [];
  return tickets.filter((t) => { const text = [t.id, t.title].join(' ').toLowerCase(); return sought.every((word) => text.includes(word)); });
}

/** `value` is what is typed, or a chosen ticket's id. `tickets` are the ones that may be chosen. */
export function TicketPicker({ label, value, onChange, tickets, disabled }: { label: string; value: string; onChange(value: string): void; tickets: readonly Pickable[]; disabled?: boolean }) {
  const typed = value.trim(), chosen = tickets.find((t) => t.id === typed);
  const found = chosen ? [] : ticketMatches(tickets, typed);
  return (
    <>
      <input className="board-input" aria-label={label} placeholder="Search tickets, or t-…" value={value} disabled={disabled}
        onChange={(e) => { const raw = e.target.value, exact = raw.trim(); onChange(tickets.some((t) => t.id === exact) ? exact : raw); }} />
      {chosen && <span className="text-muted-foreground">{chosen.title}</span>}
      {found.length > 0 && (
        <span className="board-line" role="group" aria-label={`${label}: tickets found`}>
          {found.slice(0, pickerResults).map((t) => (
            <button type="button" key={t.id} className="board-action" disabled={disabled} onClick={() => onChange(t.id)}>{t.title} · <span className="font-mono">{t.id}</span></button>
          ))}
          {found.length > pickerResults && <span className="text-muted-foreground">and {found.length - pickerResults} more: type more of its title</span>}
        </span>
      )}
      {typed && !chosen && !found.length && <span className="text-muted-foreground">No ticket matches.</span>}
    </>
  );
}
