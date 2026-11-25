import { useEffect, useState, type ReactNode } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import {ToolbarFrame} from './kit/toolbar';
import { iconFor } from './safe';
import { useTint } from './tint';
import { AppIcon } from './app-icon';

/** An app's icon in its tile, in the app's one colour (tint.ts): the same as its tile in Places or Setup, in the dock and in Find. */
export function AppTile({ app, label, icon, size = 44 }: { /** the app's id: its house icon's name */ app?: string; label: string; icon: string; size?: number }) {
  const tint = useTint();
  return (
    <span aria-hidden className="loom-app-tile grid shrink-0 place-items-center rounded-[var(--loom-r-tile)]" data-tint={tint(label)} style={{ width: size, height: size }}>
      <AppIcon app={app} name={iconFor(icon)} size="sm" />
    </span>
  );
}

/** A page's intro, as the header's one line: its first sentence when that's short, else nothing (the ⓘ has it). */
export function oneLine(intro?: string): string | undefined {
  const first = intro?.trim().split(/(?<=[.!?])\s+/)[0];
  return first && first.length <= 80 ? first : undefined;
}

/** The ⓘ that opens a page's longer intro, and the intro it opens. */
function InfoButton({ open, toggle }: { open: boolean; toggle: () => void }) {
  return (
    <button type="button" onClick={toggle} aria-expanded={open} aria-label={open ? 'Hide what this is' : 'What this is'}
      className="loom-head-action grid size-10 shrink-0 place-items-center rounded-full">
      <AnimatedIcon name={iconFor(open ? 'x' : 'info')} size="sm" />
    </button>
  );
}
const InfoMore = ({ text }: { text: string }) => <p className="loom-head-more max-w-prose rounded-2xl px-4 py-3 text-sm leading-relaxed">{text}</p>;

/** A page's intro beyond its one line, and whether it's open (closed again on another page). */
function useMore(where: string, context?: string, more?: string) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [where]);
  const extra = more && more.trim() !== context ? more : undefined;
  return { open, toggle: () => setOpen((o) => !o), extra };
}

export function AppHeader({ title, lead, context, more, crumb, go, actions, where, filters, children }: {
  title: string; lead?: ReactNode; context?: string; more?: string; crumb?: { label: string; href: string };
  go: (href: string) => void; actions?: ReactNode; where: string; filters?: ReactNode; children?: ReactNode;
}) {
  const { open, toggle, extra } = useMore(where, context, more);
  const controls = (actions || filters || extra) && <>{filters}{actions}{extra && <InfoButton open={open} toggle={toggle}/>}</>;
  return <ToolbarFrame title={title} mark={lead} controls={controls}
    back={crumb && {label:crumb.label,open:()=>go(crumb.href)}}>
    {context && <p className="loom-frame-context">{context}</p>}
    {extra && open && <InfoMore text={extra}/>}
    {children}
  </ToolbarFrame>;
}
