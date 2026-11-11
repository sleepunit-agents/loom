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

export function ListTitle({ className = '', ...props }: ComponentProps<'h2'>) { return <h2 {...props} className={`loom-kit-list-title ${className}`} />; }

export function List({ children, label, title }: { children: ReactNode; label: string; title?: ReactNode }) {
  return <div className="loom-kit-list" role="group" aria-label={label}>{title !== undefined && title !== null && title !== false && title !== '' && <ListTitle>{title}</ListTitle>}{children}</div>;
}

type WordsProps = { title: ReactNode; meta?: ReactNode; status?: ReactNode; tone?: 'bad' | 'warn' | 'ok' };
function Words({ title, meta, status, tone }: WordsProps) {
  return <span className="loom-kit-words"><span className="loom-kit-title">{title}</span>{meta && <span className="loom-kit-meta">{meta}</span>}{status && <span className="loom-kit-status" data-tone={tone}>{status}</span>}</span>;
}

type RowProps = Omit<ComponentProps<'button'>, 'title'> & {
  title: ReactNode; meta?: ReactNode; icon?: ReactNode; status?: ReactNode; trailing?: ReactNode; actions?: ReactNode;
  selected?: boolean; unread?: boolean; layout?: 'stack' | 'inline'; tone?: 'bad' | 'warn' | 'ok';
};
/** Open target and optional trailing controls are siblings, so actions never nest inside a button. */
export const Row = forwardRef<HTMLButtonElement, RowProps>(function Row({ title, meta, icon, status, trailing, actions, selected, unread, tone, layout = 'inline', className = '', ...props }, ref) {
  const target = <button {...props} ref={ref} type="button" data-split-row="" className={`loom-kit-row ${className}`} data-layout={layout} data-icon={!!icon || undefined}
    data-unread={unread || undefined} aria-current={selected ? 'true' : undefined}>
    {unread && <span className="loom-kit-dot" aria-label="Unread" />}{icon}
    <Words title={title} meta={meta} status={status} tone={tone} />
    {trailing && <span className="loom-kit-trailing">{trailing}</span>}
  </button>;
  return actions ? <div className="loom-kit-row-shell">{target}<div className="loom-kit-row-actions">{actions}</div></div> : target;
});

/** Say what's absent, then (only if useful) how something gets here. */
export function Empty({ title, text, children, compact = false, framed = true }: { title: string; text?: string; children?: ReactNode; compact?: boolean; framed?: boolean }) {
  return <PrimitiveEmpty data-framed={framed ? undefined : 'false'} data-compact={compact || undefined} className="loom-kit-state grid justify-items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center">
    <EmptyTitle className="text-base">{title}</EmptyTitle>{text && <EmptyDescription className="text-sm">{text}</EmptyDescription>}{children}
  </PrimitiveEmpty>;
}
export function Loading({ label = 'Loading…' }: { label?: string }) { return <p className="loom-kit-state" role="status" aria-live="polite">{label}</p>; }
export function Error({ title = 'Couldn’t load this', text, retry, framed }: { title?: string; text?: string; retry?: () => void; framed?: boolean }) {
  return <div role="alert"><Empty title={title} text={text} framed={framed}>{retry && <Button variant="outline" onClick={retry}>Try again</Button>}</Empty></div>;
}

/** A row with ordinary link semantics (modifier click, new tab and copy address). */
export function LinkRow({ title, meta, status, tone, href, wrap, ...props }: Omit<ComponentProps<'a'>, 'title'> & WordsProps & { wrap?: boolean }) {
  const content = <Words title={title} meta={meta} status={status} tone={tone} />;
  return href ? <a {...props} href={href} data-wrap={wrap || undefined} className={`loom-kit-row ${props.className ?? ''}`}>{content}</a> : <div data-wrap={wrap || undefined} className="loom-kit-row">{content}</div>;
}
