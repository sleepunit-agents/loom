// What a list row opens to in place (docs/extensions.md, "Blocks", list `more`): its label and value pairs side by side
// where there's room (a task's goal, why and done-when), one under another where there isn't, and the row's link as a
// button under them ("Open task"). Its own chunk: it loads the first time a row opens.
import { Button } from '@/components/ui/button';
import { useEnv } from './blocks';
import { pageHref, type ListItem } from './loom';
import { tidy } from './tidy';
import './row-more.css';

export default function RowMore({ more, page, href, indent }: { more: NonNullable<ListItem['more']>; page?: string; href?: string; indent?: boolean }) {
  const { ctx, go } = useEnv();
  const to = href ?? (page !== undefined ? pageHref(page, ctx.source) : undefined);
  return (
    <div className="loom-row-more" data-indent={indent ? '' : undefined}>
      <dl>{more.items.map((m, n) => (
        <div key={n}><dt>{m.label}</dt><dd>{tidy(m.value)}</dd></div>))}</dl>
      {to && (
        <Button asChild size="sm" variant="outline">
          <a href={to} {...(href ? { target: '_blank', rel: 'noopener noreferrer' } : {
            onClick: (e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey || to === '#') return; e.preventDefault(); go(to); } })}>{more.open ?? 'Open'}</a>
        </Button>
      )}
    </div>
  );
}
