// What an open item is made of, as the "how it works" site draws a reader: a quiet mono line, a title, facts as
// label and value, ruled sections with a small uppercase label, body text, and small chips for references.
// A reader built from these needs no classes of its own; reader.css holds every size and colour.
import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { LinkButton } from './app';
import './reader.css';

/** Show an identifier compactly and let a reader reveal and select its full value. */
export function ShortIdentifier({value,length=8}:{value:string;length?:number}){
  const [expanded,setExpanded]=useState(false);
  if(value.length<=length)return <span>{value}</span>;
  return <button type="button" className="loom-reader__identifier" title={value}
    aria-label={value} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
    {expanded?value:value.slice(0,length)}
  </button>;
}

/** The open item: an article that stacks its parts with one gap and wraps every word. */
export function Reader({ className = '', ...props }: ComponentProps<'article'>) {
  return <article {...props} className={`loom-reader ${className}`} />;
}
/** The head of an open item that keeps its place while what is under it scrolls (a conversation's, the site's
 * `.cm__head`): something small at its left (an agent's face), the title over its quiet line, and the item's few
 * actions at its right. The words wrap; the actions never shrink. */
export function Head({ leading, actions, children, className = '', ...props }: ComponentProps<'header'> & { leading?: ReactNode; actions?: ReactNode }) {
  return <header {...props} className={`loom-reader__head ${className}`}>{leading}<div className="loom-reader__head-words">{children}</div>{actions}</header>;
}
/** A small, quiet mono line: who and what state over the title, when and where under it. */
export function Meta({ className = '', ...props }: ComponentProps<'p'>) {
  return <p {...props} className={`loom-reader__meta ${className}`} />;
}
/** The item's title. h2 by default: the list's heading is the pane's h2 and the reader is its own landmark. */
export function Title({ as: Tag = 'h2', className = '', ...props }: ComponentProps<'h2'> & { as?: 'h1' | 'h2' | 'h3' }) {
  return <Tag {...props} className={`loom-reader__title ${className}`} />;
}
/** Facts as label and value: the label small uppercase mono on the left, the value beside it; stacked when narrow. */
export function Facts({ className = '', ...props }: ComponentProps<'dl'>) {
  return <dl {...props} className={`loom-reader__facts ${className}`} />;
}
/** One fact. Draws nothing when it has no value, so a caller can list every fact it might have. */
export function Fact({ label, children }: { label: ReactNode; children?: ReactNode }) {
  if (children === undefined || children === null || children === false || children === '') return null;
  return <><dt className="loom-reader__label">{label}</dt><dd>{children}</dd></>;
}
/** A part of the reader under a rule, named by a small uppercase label (which is also its accessible name). */
export function Section({ label, children, className = '', ...props }: Omit<ComponentProps<'section'>, 'aria-label'> & { label: string }) {
  return <section {...props} aria-label={label} className={`loom-reader__section ${className}`}><h3 className="loom-reader__label">{label}</h3>{children}</section>;
}
/** A section that starts closed: its label is the button that opens it in place (developer facts, a long record). */
export function Disclosure({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen), id = useId();
  return <section aria-label={label} className="loom-reader__section">
    <h3 className="loom-reader__label"><button type="button" className="loom-reader__toggle" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>{label}</button></h3>
    {open && <div id={id} className="loom-reader__more">{children}</div>}
  </section>;
}
/** Long words held to a readable height, with "Show all" under them. The caller says whether they are long;
 * short ones are drawn as they are, with no control. */
export function Clamp({ long, children }: { long: boolean; children: ReactNode }) {
  const [all, setAll] = useState(false);
  if (!long) return <>{children}</>;
  return <><div className="loom-reader__clamp" data-all={all || undefined}>{children}</div>
    <LinkButton aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? 'Show less' : 'Show all'}</LinkButton></>;
}
/** Body text; `quiet` for a secondary line. Line breaks in the words are kept. */
export function Body({ quiet, className = '', ...props }: ComponentProps<'p'> & { quiet?: boolean }) {
  return <p {...props} data-quiet={quiet || undefined} className={`loom-reader__body ${className}`} />;
}
/** The reader's last line: a quiet setting about the item (how loudly it is shown), apart from its content. */
export function Foot({ className = '', ...props }: ComponentProps<'footer'>) {
  return <footer {...props} className={`loom-reader__foot ${className}`} />;
}
/** A reference to something another app owns (a pull request): the site's bordered card (`.refc`) around that app's
 * own small card (a kind, a title, its state, Open), with an optional quiet first line ("Made here"). */
export function RefCard({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return <div className="loom-kit-refc" role="group" aria-label={label}>{note && <p className="loom-kit-refc__note">{note}</p>}{children}</div>;
}
/** A row of chips. */
export function Chips({ label, children }: { label: string; children: ReactNode }) {
  return <div className="loom-kit-chips" role="group" aria-label={label}>{children}</div>;
}
/** A reference such as a task id: plain when it only names something, a link or a button when it can be opened. */
export function Chip({ children, href, onClick, label }: { children: ReactNode; href?: string; onClick?: () => void; label?: string }) {
  if (href) return <a className="loom-kit-chip" href={href} aria-label={label}>{children}</a>;
  if (onClick) return <button type="button" className="loom-kit-chip" onClick={onClick} aria-label={label}>{children}</button>;
  return <span className="loom-kit-chip">{children}</span>;
}
