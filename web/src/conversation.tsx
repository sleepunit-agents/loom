// Venue-rendered conversation groups keep their domain words and links. Only the
// shared frame, rows and empty states belong here; rendering remains source-owned.
import { AppFrame, Empty, LinkRow, List } from './kit';
import { BlockView, useEnv, Who } from './blocks';
import { pageHref, type Page, type ListItem } from './loom';

export default function ConversationView({ page }: { page: Page }) {
  const { ctx, go } = useEnv();
  return <AppFrame header={false} title={page.title} where={ctx.path} go={go}>
    {!page.sections.length && <Empty title="No conversation entries yet" />}
    {page.sections.map((section) => <List key={section.id} label={section.title ?? 'Conversation entries'}>
      {section.title && <h2 className="px-4 py-3 text-sm font-semibold">{section.title}</h2>}
      {section.blocks.map((block, index) => {
        if (block.type !== 'list') return <div key={index} className="px-4 py-2"><BlockView b={block} /></div>;
        const items = (block as { items: ListItem[] }).items;
        return <div key={index}>
        {!items.length && <Empty title="No entries yet" />}
        {items.map((item, i) => {
          const href = item.page ? pageHref(item.page, ctx.source) : item.href;
          return <LinkRow wrap key={i} href={href} title={<>{item.person && <Who person={item.person} />} {item.text}</>}
            meta={item.meta} status={item.badge}
            onClick={(event) => { if (!item.page || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return; event.preventDefault(); if (href) go(href); }} />;
        })}
      </div>; })}
    </List>)}
  </AppFrame>;
}
