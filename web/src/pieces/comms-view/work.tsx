import { useId, useState, type ReactNode } from 'react';

/** Work in a conversation (the how-it-works site's `.cm__work`): a column on the right of the thread where the reader
 * is wide enough, and below that one line over the composer, "Work · 3", that opens in place. Which of the two it is
 * is the sheet's business (a container query on the reader); the heading shows in the column, the button in the line.
 * Its tasks are the kit's own rows (a title over a small mono line: its id, its state, where it came from). */
export function WorkPanel({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false), id = useId();
  return <section className="comms-work" aria-label="Work in this conversation" data-open={open || undefined}>
    <h3 className="loom-reader__label comms-work__label">Work</h3>
    <button type="button" className="comms-work__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>Work · {count}</button>
    <div id={id} className="comms-work__body">{children}</div>
  </section>;
}
/** A pull request: the bordered card (the site's `.refc`) around the Changes app's own reference card. */
export function WorkCard({ label, made, children }: { label: string; made?: boolean; children: ReactNode }) {
  return <div className="comms-refc" role="group" aria-label={label}>{made && <p className="comms-work__made">Made here</p>}{children}</div>;
}
