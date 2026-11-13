import { useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AppIcon } from '../app-icon';
import { tintOf } from '../tint';
import type { RegisteredApp } from './index';
import '../launcher.css';

/** The registrations are the inventory; no legacy Shell or route discovery. */
export default function Launcher({ apps, open, onOpenChange, launch }: { apps: readonly RegisteredApp[]; open: boolean; onOpenChange(open: boolean): void; launch(id: string): void }) {
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => apps.filter(a => a.title.toLowerCase().includes(query.trim().toLowerCase())), [apps, query]);
  const go = (id: string) => { onOpenChange(false); launch(id); };
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal><Dialog.Overlay className="loom-lscrim" />
      <Dialog.Content className="loom-launcher" aria-describedby={undefined} onOpenAutoFocus={e => { e.preventDefault(); setQuery(''); field.current?.focus(); }} onKeyDown={e => {
        const tiles = [...(body.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Enter' && at < 0 && shown[0]) { e.preventDefault(); go(shown[0].id); }
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) return;
        if (at < 0) { if(e.key==='ArrowDown') { e.preventDefault(); tiles[0]?.focus(); } return; }
        e.preventDefault();
        if(e.key==='Home') return tiles[0]?.focus();
        if(e.key==='End') return tiles.at(-1)?.focus();
        if(e.key==='ArrowLeft'||e.key==='ArrowRight') return tiles[Math.max(0,Math.min(tiles.length-1,at+(e.key==='ArrowLeft'?-1:1)))]?.focus();
        const here=tiles[at].getBoundingClientRect(), down=e.key==='ArrowDown';
        const candidates=tiles.filter(t=>down?t.getBoundingClientRect().top>here.top+4:t.getBoundingClientRect().top<here.top-4);
        candidates.sort((a,b)=>{const score=(t:HTMLElement)=>{const r=t.getBoundingClientRect();return Math.abs(r.top-here.top)*10000+Math.abs(r.left-here.left);};return score(a)-score(b);});
        if(candidates[0]) candidates[0].focus(); else if(!down) field.current?.focus();
      }}>
        <div className="loom-launcher__head"><Dialog.Title className="loom-launcher__title">Apps</Dialog.Title>
          <label className="loom-launcher__field"><AppIcon label="Find" name="search" size="sm" /><input ref={field} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Type to find an app" aria-label="Find an app" autoComplete="off" spellCheck={false} aria-controls="next-launcher-apps" /></label>
          <Dialog.Close aria-label="Close app launcher">×</Dialog.Close>
        </div>
        <div ref={body} id="next-launcher-apps" className="loom-launcher__body"><section className="loom-lsec" aria-label="Installed apps"><h3 className="loom-lsec__name">Your apps</h3><div className="loom-lgrid">
          {shown.map((app,i)=><button key={app.id} type="button" className="loom-lapp" data-tint={tintOf(app.title)} data-first={i===0||undefined} onClick={()=>go(app.id)}>
            <span className="loom-lapp__ico loom-launch-tile" data-tint={tintOf(app.title)}><AppIcon label={app.title} name={app.icon} /></span><span className="loom-lapp__nm">{app.title}</span>
          </button>)}
        </div>{!shown.length&&<p className="loom-launcher__none" role="status">No app called “{query.trim()}”.</p>}</section></div>
        <div className="loom-launcher__foot" aria-hidden="true"><span><kbd>Enter</kbd> opens the first match</span><span><kbd>←↑↓→</kbd> move</span><span><kbd>Esc</kbd> closes</span></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
