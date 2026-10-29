// The phone's More (…) drawer as 000h's navigation menu, its directory look (Jonathan, 2026-10-29: "navigation menu
// feels like something we might explore for our sheet popup menu things"): the pages that didn't fit the dock,
// then the agents and the household. Its own chunk: it loads when the drawer opens.
import { NavigationMenu, NavigationMenuCount, NavigationMenuItem, NavigationMenuLabel, NavigationMenuLink, NavigationMenuList } from '@/components/ui/navigation-menu';
import { iconFor } from './safe';

type Tab = { label: string; href: string; current: boolean; count?: number };
type Agent = { id: string; label: string; bg: string; fg: string; href: string; asks?: number };

export default function MoreMenu({ pages, agents, here, icon, go }: {
  pages: Tab[]; agents: Agent[]; here?: string; icon: (label: string) => string; go: (href: string) => void;
}) {
  // As 000h's directory: each group one item, its heading (with how many), then its links, each with an adornment.
  const link = (href: string, label: string, adornment: unknown, opts: { current?: boolean; count?: number } = {}) => (
    <NavigationMenuLink key={href + label} href={href} active={opts.current} adornment={adornment as never} adornmentId={href}
      onClick={(e) => { e.preventDefault(); go(href); }}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {opts.count ? <NavigationMenuCount>{opts.count}</NavigationMenuCount> : null}
    </NavigationMenuLink>
  );
  const head = (label: string, n: number, unit = 'place') => (
    <NavigationMenuLabel className="mb-1 flex items-baseline justify-between gap-3 border-b pb-3 text-xs font-semibold uppercase tracking-[.1em]">
      <span className="truncate">{label}</span><small className="shrink-0 text-[10px] font-medium opacity-70">{n} {n === 1 ? unit : `${unit}s`}</small>
    </NavigationMenuLabel>
  );
  const mark = (a: Agent) => <span className="grid size-8 shrink-0 place-items-center rounded-xl text-sm font-semibold" style={{ background: a.bg, color: a.fg }}>{a.label[0]}</span>;
  return (
    <NavigationMenu appearance="directory" aria-label="More pages">
      <NavigationMenuList>
        {pages.length > 0 && (
          <NavigationMenuItem value="pages">
            {head(here ? `${here}'s pages` : 'Pages', pages.length)}
            {pages.map((t) => link(t.href, t.label, { icon: iconFor(icon(t.label)) }, { current: t.current, count: t.count }))}
          </NavigationMenuItem>
        )}
        {agents.length > 1 && (
          <NavigationMenuItem value="agents">
            {head('Agents', agents.length, 'agent')}
            {agents.map((a) => link(a.href, a.label, mark(a), { count: a.asks }))}
            {link('/', 'The household', { icon: 'house' })}
          </NavigationMenuItem>
        )}
      </NavigationMenuList>
    </NavigationMenu>
  );
}
