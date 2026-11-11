import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { AppHeader } from '../app-header';
import { aboutAttr, type About } from '../about';
import { Empty as PrimitiveEmpty, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import './app.css';

/** Header, filters and content. about participates in the desktop's Chat about this menu. */
export function AppFrame({ children, filters, about, header: showHeader = true, ...heading }: ComponentProps<typeof AppHeader> & { children: ReactNode; filters?: ReactNode; about?: About; header?: boolean }) {
  return <section className="loom-kit-frame" {...(about ? aboutAttr(about) : {})}>
    {showHeader && <AppHeader {...heading} />}{filters && <div className="loom-kit-filters">{filters}</div>}{children}
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

/** Say what's absent, then (only if useful) how something gets here. */
export function Empty({ title, text, children, compact = false }: { title: string; text?: string; children?: ReactNode; compact?: boolean }) {
  return <PrimitiveEmpty data-compact={compact || undefined} className="loom-kit-state grid justify-items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center">
    <EmptyTitle className="text-base">{title}</EmptyTitle>{text && <EmptyDescription className="text-sm">{text}</EmptyDescription>}{children}
  </PrimitiveEmpty>;
}
export function Loading({ label = 'Loading…' }: { label?: string }) { return <p className="loom-kit-state" role="status" aria-live="polite">{label}</p>; }
export function Error({ title = 'Couldn’t load this', text, retry }: { title?: string; text?: string; retry?: () => void }) {
  return <div role="alert"><Empty title={title} text={text}>{retry && <Button variant="outline" onClick={retry}>Try again</Button>}</Empty></div>;
}

/** A row with ordinary link semantics (modifier click, new tab and copy address). */
export function LinkRow({ title, meta, status, href, ...props }: Omit<ComponentProps<'a'>, 'title'> & { title: ReactNode; meta?: ReactNode; status?: ReactNode }) {
  const content = <span className="loom-kit-words"><span className="loom-kit-title">{title}</span>{meta && <span className="loom-kit-meta">{meta}</span>}{status && <span className="loom-kit-status">{status}</span>}</span>;
  return href ? <a {...props} href={href} className={`loom-kit-row ${props.className ?? ''}`}>{content}</a> : <div className="loom-kit-row">{content}</div>;
}
