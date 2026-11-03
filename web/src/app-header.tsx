// One header for every app and page (Jonathan, 2026-11-03: "icon, title, at most one short line of context, and
// actions. No verbose filler; the same pattern everywhere"). The page it's under (a breadcrumb) over the title, the
// app's icon tile (or the agent's mark) beside it, one line under it, actions on the right. A page's longer intro
// isn't printed above its content any more: it's behind the ⓘ, for whoever wants it.
import { useEffect, useState, type ReactNode } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { iconFor } from './safe';
import { tintOf } from './tint';

/** An app's icon in its tile, the tint its name gives it (the same in Find, so an app looks the same everywhere). */
export function AppTile({ label, icon, size = 44 }: { label: string; icon: string; size?: number }) {
  return (
    <span aria-hidden className="loom-app-tile grid shrink-0 place-items-center rounded-[28%]" data-tint={tintOf(label)} style={{ width: size, height: size }}>
      <AnimatedIcon name={iconFor(icon)} size="sm" />
    </span>
  );
}

/** A page's intro, as the header's one line: its first sentence when that's short, else nothing (the ⓘ has it). */
export function oneLine(intro?: string): string | undefined {
  const first = intro?.trim().split(/(?<=[.!?])\s+/)[0];
  return first && first.length <= 80 ? first : undefined;
}

export function AppHeader({ title, lead, context, more, crumb, go, actions, where }: {
  title: string; lead?: ReactNode; context?: string; more?: string; crumb?: { label: string; href: string };
  go: (href: string) => void; actions?: ReactNode; where: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [where]);
  const extra = more && more.trim() !== context ? more : undefined;
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        {lead}
        <div className="grid min-w-0 flex-1 leading-tight">
          {crumb && (
            <Breadcrumb aria-label="You are here" className="text-sm"><BreadcrumbList>
              <BreadcrumbItem><BreadcrumbLink href={crumb.href} onClick={(e) => { e.preventDefault(); go(crumb.href); }}>{crumb.label}</BreadcrumbLink></BreadcrumbItem>
              {/* The page itself is the title right under it, whole: said for a screen reader, not printed twice (and cut). */}
              <BreadcrumbSeparator /><BreadcrumbItem className="sr-only"><BreadcrumbPage>{title}</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList></Breadcrumb>
          )}
          {/* A long title (a task's, a secret's name) wraps, a size down, rather than being cut. */}
          {title && <h1 className={`line-clamp-3 break-words text-balance font-[family-name:var(--font-display)] font-semibold leading-tight tracking-tight ${title.length > 28 ? 'text-2xl lg:text-3xl' : 'text-3xl lg:text-4xl'}`}>{title}</h1>}
          {context && <p className="line-clamp-2 break-words text-sm opacity-70">{context}</p>}
        </div>
        {extra && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Hide what this is' : 'What this is'}
            className="loom-head-action grid size-10 shrink-0 place-items-center rounded-full">
            <AnimatedIcon name={iconFor(open ? 'x' : 'info')} size="sm" />
          </button>
        )}
        {actions}
      </div>
      {extra && open && <p className="loom-head-more max-w-prose rounded-2xl px-4 py-3 text-sm leading-relaxed">{extra}</p>}
    </div>
  );
}
