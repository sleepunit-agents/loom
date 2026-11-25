import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { AppHeader } from '../app-header';
import { aboutAttr, type About } from '../about';
import { Button } from '@/components/ui/button';
import './app.css';
import './controls.css';

/** Header, filters and content. about participates in the desktop's Chat about this menu. */
export function AppFrame({ children, filters, about, ...header }: ComponentProps<typeof AppHeader> & { children: ReactNode; filters?: ReactNode; about?: About }) {
  return <section className="loom-kit-frame" {...(about ? aboutAttr(about) : {})}>
    <AppHeader {...header} filters={filters}>{children}</AppHeader>
  </section>;
}

export function List({ children, label }: { children: ReactNode; label: string }) {
  return <div className="loom-kit-list" role="group" aria-label={label}>{children}</div>;
}

type RowProps = Omit<ComponentProps<'button'>, 'title'> & {
  title: ReactNode; meta?: ReactNode; icon?: ReactNode; status?: ReactNode; trailing?: ReactNode; actions?: ReactNode;
  selected?: boolean; unread?: boolean; layout?: 'stack' | 'inline';
};
/** Open target and optional trailing controls are siblings, so actions never nest inside a button. */
export const Row = forwardRef<HTMLButtonElement, RowProps>(function Row({ title, meta, icon, status, trailing, actions, selected, unread, layout = 'inline', className = '', ...props }, ref) {
  const target = <button {...props} ref={ref} type="button" data-split-row="" className={`loom-kit-row ${className}`} data-layout={layout} data-icon={!!icon || undefined}
    data-unread={unread || undefined} aria-current={selected ? 'true' : undefined}>
    {unread && <span className="loom-kit-dot" aria-label="Unread" />}{icon}
    <span className="loom-kit-words"><span className="loom-kit-title">{title}</span>{meta && <span className="loom-kit-meta">{meta}</span>}{status && <span className="loom-kit-status">{status}</span>}</span>
    {trailing && <span className="loom-kit-trailing">{trailing}</span>}
  </button>;
  return actions ? <div className="loom-kit-row-shell">{target}<div className="loom-kit-row-actions">{actions}</div></div> : target;
});

/** A row that reports something and opens nothing (the outcome of an action): the same words as a Row, no target.
 * Its controls sit beside it; it takes no part in the list's arrow keys. */
export function NoteRow({ title, meta, status, actions, children, ...props }: Omit<ComponentProps<'div'>, 'title'> & { title: ReactNode; meta?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return <div {...props} className="loom-kit-row-shell loom-kit-note">
    <div className="loom-kit-row" data-static=""><span className="loom-kit-words"><span className="loom-kit-title">{title}</span>{meta && <span className="loom-kit-meta">{meta}</span>}{status && <span className="loom-kit-status">{status}</span>}{children}</span></div>
    {actions && <div className="loom-kit-row-actions">{actions}</div>}
  </div>;
}

/** Say what's absent, then (only if useful) how something gets here. A quiet line or two, centred in its pane. */
export function Empty({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return <div className="loom-kit-empty" data-slot="empty">
    <p className="loom-kit-empty__title">{title}</p>{text && <p className="loom-kit-empty__text">{text}</p>}{children}
  </div>;
}
export { Loading } from './loading';
export function Error({ title = 'Couldn’t load this', text, retry }: { title?: string; text?: string; retry?: () => void }) {
  return <div role="alert"><Empty title={title} text={text}>{retry && <Button variant="outline" onClick={retry}>Try again</Button>}</Empty></div>;
}

/** A group of buttons: one row that wraps, 8px apart. Give it a label when the group needs a name. */
export function Actions({ label, className = '', ...props }: ComponentProps<'div'> & { label?: string }) {
  return <div {...props} className={`loom-kit-actions ${className}`} {...(label ? { role: 'group', 'aria-label': label } : {})} />;
}

/** An action that reads as a link ("Open the task"): it goes somewhere, so it is not drawn as a button. */
export function LinkButton({ className = '', ...props }: ComponentProps<'button'>) {
  return <button type="button" {...props} className={`loom-kit-link ${className}`} />;
}

/** A compact search box. Its words are the placeholder; `label` is its accessible name. */
export function Search({ label, placeholder = label, value, onChange, disabled }: { label: string; placeholder?: string; value: string; onChange(value: string): void; disabled?: boolean }) {
  return <label className="loom-kit-search">
    <input type="search" aria-label={label} placeholder={placeholder} value={value} disabled={disabled} autoComplete="off" onChange={event => onChange(event.target.value)} />
  </label>;
}

/** Earlier and later pages of a list. Draws nothing when there is only one page. */
export function Pager({ label, hasPrevious, hasNext, previous, next, disabled }: { label: string; hasPrevious: boolean; hasNext: boolean; previous(): void; next(): void; disabled?: boolean }) {
  if (!hasPrevious && !hasNext) return null;
  return <nav className="loom-kit-pager" aria-label={label}>
    <Button disabled={disabled || !hasPrevious} onClick={previous}>Previous page</Button>
    <Button disabled={disabled || !hasNext} onClick={next}>Next page</Button>
  </nav>;
}
