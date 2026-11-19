import { AppIcon } from '../app-icon';
import { tintOf } from '../tint';
import type { RegisteredApp } from './index';
import type { Switching } from './shortcuts';

/** The app switcher while Control is held. It never takes focus: the caret stays in the text field the person was
 * typing in, so the selection is spoken through the status line, and marked for a reader that follows the list. */
export default function Switcher({ apps, switching, pick }: { apps: readonly RegisteredApp[]; switching: Switching | null; pick(id: string): void }) {
  const items = switching?.order.flatMap(id => apps.find(app => app.id === id) ?? []) ?? [];
  const selected = switching && apps.find(app => app.id === switching.order[switching.index]);
  return <>
    <p className="sr-only" role="status" aria-live="assertive">{selected ? `${selected.title}, ${switching.index + 1} of ${switching.order.length}. Let go of Control to switch, Escape to stay.` : ''}</p>
    {switching && <div className="next-switcher" role="listbox" aria-label="Switch apps" aria-orientation="horizontal" aria-activedescendant={selected ? `next-switch-${selected.id}` : undefined}>
      {items.map(app => <div key={app.id} id={`next-switch-${app.id}`} role="option" aria-selected={app === selected} className="loom-lapp next-switch-item" data-tint={tintOf(app.title)}
        onPointerDown={e => e.preventDefault()} onMouseDown={e => e.preventDefault()} onClick={() => pick(app.id)}>
        <span className="loom-lapp__ico loom-launch-tile" data-tint={tintOf(app.title)}><AppIcon app={app.id} name={app.icon} house={40} /></span><span className="next-switch-name">{app.title}</span>
      </div>)}
    </div>}
  </>;
}
