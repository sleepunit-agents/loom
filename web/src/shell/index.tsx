import { Component, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { DeskRouter, currentPath, type AppRegistration, type Tile } from './router';
import { ContextMenu, type MenuAt } from '../tiling/menu';
import { layout, railWidth, type Rect } from '../tiling/layout';
import { Loading, Error, Button, Empty } from '../kit';
import './shell.css';
export interface RegisteredApp extends AppRegistration { icon: string; Screen: LazyExoticComponent<ComponentType<{ path?: string; go?: (path: string) => void }>> }
/** The shell only consumes registrations. Home and agent rail will register alongside other apps. */
class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed:false };
  static getDerivedStateFromError() { return { failed:true }; }
  render() { return this.state.failed ? <Error text="This app could not open. Close it and try again." /> : this.props.children; }
}
function Screen({ app, tile, router }: { app: RegisteredApp; tile: Tile; router: DeskRouter }) {
  const View = app.Screen;
  return <AppBoundary><Suspense fallback={<Loading label={`Opening ${app.title}…`} />}><View path={currentPath(tile)} go={path => router.go(tile.id,path)} /></Suspense></AppBoundary>;
}
export interface ShellSurfaces { Home?: ComponentType<{ go(path: string): void }>; Rail?: ComponentType<{ go(path: string): void }> }
export default function Shell({ apps, surfaces = {} }: { apps: readonly RegisteredApp[]; surfaces?: ShellSurfaces }) {
  const [router] = useState(() => new DeskRouter(apps, window));
  const route = useSyncExternalStore(router.subscribe,router.getSnapshot);
  // Pick a shell once. Resizing relays layout room, never replaces its navigation owner.
  const [phone] = useState(() => innerWidth < 1024);
  const ground = useRef<HTMLDivElement>(null);
  const [area,setArea] = useState<Rect>({x:0,y:0,w:innerWidth-48,h:innerHeight-130});
  const [width,setWidth] = useState(innerWidth);
  const [notice,setNotice] = useState('');
  const [menu,setMenu] = useState<MenuAt>();
  const drag = useRef<string | undefined>(undefined);
  const [launcher,setLauncher] = useState(false);
  useEffect(() => {
    const element = ground.current!;
    const observer = new ResizeObserver(() => { const r = element.getBoundingClientRect(); setWidth(innerWidth); setArea({x:0,y:0,w:r.width,h:r.height}); });
    observer.observe(element); return () => { observer.disconnect(); };
  },[]);
  useEffect(() => () => router.close(),[router]);
  const visible = route.tiles.filter(t => !t.minimized);
  // Until Home's piece registers a rail there is no invented agent data or empty reserved column.
  const { Home, Rail } = surfaces;
  const workArea = { ...area,w:Math.max(1,area.w - (Rail && visible.length ? (railWidth(width)||64)+10 : 0)) };
  useEffect(() => { if(!phone) {const notices=router.fit(workArea,width);if(notices.length)setNotice(notices.join(' '));} },[area.w,area.h,width,phone,router,!!Rail]);
  const boxes = layout(router.asTiles(),workArea,width).apps;
  const open = (id: string) => {
    const gone = router.open(id,phone ? undefined : workArea,phone ? 1920 : width);
    setNotice(gone?.map(t => t.why).join('. ') ?? ''); setLauncher(false);
    if (document.documentElement.dataset.sound === 'on') void import('../sound').then(s => s.chime('done'));
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable=true]');
      if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.code==='Space'){e.preventDefault();setLauncher(v=>!v);return;}
      if (!typing && e.key === 'Escape') setLauncher(false);
      if(typing||document.querySelector('[role=dialog],[role=menu]')||!e.altKey) return;
      if(!e.shiftKey&&e.key.toLowerCase()==='h'){e.preventDefault();router.home();return;}
      const tile=visible.find(t=>t.id===route.focused);if(!tile)return;
      const key=e.key.toLowerCase();let acted=true;
      if(!e.shiftKey&&key==='h') router.home();
      else if(!e.shiftKey&&key==='arrowleft'&&tile.at>0) router.travel(tile.id,-1);
      else if(!e.shiftKey&&key==='arrowright'&&tile.at<tile.trail.length-1) router.travel(tile.id,1);
      else if(e.shiftKey&&key==='enter') router.big(tile.id);
      else if(e.shiftKey&&key==='m') router.remove(tile.id,true);
      else if(e.shiftKey&&key==='w') router.remove(tile.id);
      else if(e.shiftKey&&(e.code==='Comma'||e.code==='Period')){const n=visible.findIndex(t=>t.id===tile.id);const other=visible[n+(e.code==='Comma'?-1:1)];if(other)router.swap(tile.id,other.id);}
      else if(e.shiftKey&&key.startsWith('arrow')) {
        const here=boxes[tile.id];const cx=here.x+here.w/2,cy=here.y+here.h/2;
        const candidates=visible.filter(t=>t.id!==tile.id).filter(t=>{const r=boxes[t.id];return key==='arrowleft'?r.x+r.w<=here.x:key==='arrowright'?r.x>=here.x+here.w:key==='arrowup'?r.y+r.h<=here.y:r.y>=here.y+here.h;});
        candidates.sort((a,b)=>{const dist=(id:string)=>{const r=boxes[id];return (r.x+r.w/2-cx)**2+(r.y+r.h/2-cy)**2;};return dist(a.id)-dist(b.id);});
        if(candidates[0]){router.focus(candidates[0].id);document.querySelector<HTMLElement>(`[data-tile="${candidates[0].id}"]`)?.focus();}
      } else acted=false;
      if(acted)e.preventDefault();
    };
    window.addEventListener('keydown',key); return () => window.removeEventListener('keydown',key);
  },[visible,route.focused,router]);
  const focused = visible.find(t => t.id === route.focused) ?? visible[0];
  return <div className="next-shell" data-shell={phone ? 'phone' : 'desk'}>
    <header className="next-bar"><strong>LOOM<span aria-hidden="true">//</span>OS</strong><span>{apps.find(a => a.id === focused?.id)?.title ?? 'Home'}</span><Button variant="ghost" size="sm" onClick={() => setLauncher(!launcher)}>All apps</Button></header>
    <div ref={ground} className="next-ground">
      {!visible.length && (Home ? <Home go={path => { const app=apps.find(a=>path===a.path||path.startsWith(a.path+'/')); if(app){open(app.id);router.go(app.id,path);} }} /> : <Empty title="Your desk" text="Open an app from the dock." />)}
      {!phone && Rail && visible.length>0 && <aside className="next-rail" style={{width:railWidth(width)||64}}><Rail go={path => {const app=apps.find(a=>path===a.path||path.startsWith(a.path+'/'));if(app){open(app.id);router.go(app.id,path);}}} /></aside>}
      {route.tiles.map(tile => {
        const shown=!tile.minimized&&(!phone||tile.id===focused?.id);
        const app = apps.find(a => a.id === tile.id)!;
        const box = boxes[tile.id];
        return <section key={tile.id} className="next-tile" data-tile={shown?tile.id:undefined} hidden={!shown} tabIndex={-1} data-focused={route.focused === tile.id || undefined} aria-label={`${app.title} tile`}
          style={!shown?{display:'none'}:phone?undefined:{left:box.x,top:box.y,width:box.w,height:box.h}} onFocusCapture={() => { if(route.focused!==tile.id) router.focus(tile.id); }} onPointerDown={() => { if(route.focused!==tile.id) router.focus(tile.id); }}>
          <header className="next-strip" draggable={!phone} onDragStart={()=>{drag.current=tile.id;}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(drag.current)router.swap(drag.current,tile.id);drag.current=undefined;}} onDoubleClick={e=>{if(!(e.target as HTMLElement).closest('button,summary'))router.remove(tile.id,true);}} onContextMenu={e=>{e.preventDefault();setMenu({x:e.clientX,y:e.clientY,title:app.title,back:e.currentTarget,items:[{id:'min',label:'Minimize',run:()=>router.remove(tile.id,true)},{id:'big',label:'Make this the big one',run:()=>router.big(tile.id)},{id:'close',label:'Close',run:()=>router.remove(tile.id)}]});}}>
            <Button variant="ghost" size="sm" aria-label={`Back in ${app.title}`} disabled={!tile.at} onClick={() => router.travel(tile.id,-1)}>←</Button>
            <Button variant="ghost" size="sm" aria-label={`Forward in ${app.title}`} disabled={tile.at===tile.trail.length-1} onClick={() => router.travel(tile.id,1)}>→</Button>
            <Button variant="ghost" size="sm" onClick={() => router.go(tile.id,app.path)} onDoubleClick={() => router.remove(tile.id,true)}>{app.title}</Button>
            <details><summary aria-label={`${app.title} history`}>Trail</summary><ol>{tile.trail.map((path,i) => <li key={i}><Button variant="ghost" size="sm" aria-current={i===tile.at?'page':undefined} onClick={() => router.travel(tile.id,i-tile.at)}>{path.slice(app.path.length)||app.title}</Button></li>)}</ol></details>
            <span className="next-spacer" />
            {!phone && <Button variant="ghost" size="sm" aria-label={`Make ${app.title} big`} onClick={() => router.big(tile.id)}>↗</Button>}
            <Button variant="ghost" size="sm" aria-label={`Minimize ${app.title}`} onClick={() => router.remove(tile.id,true)}>−</Button>
            <Button variant="ghost" size="sm" aria-label={`Close ${app.title}`} onClick={() => router.remove(tile.id)}>×</Button>
          </header>
          <div className="next-page"><Screen app={app} tile={tile} router={router} /></div>
        </section>;
      })}
    </div>
    {launcher && <nav className="next-launcher" aria-label="App launcher">{apps.map(app => <Button variant="outline" key={app.id} onClick={() => open(app.id)}>{app.title}</Button>)}</nav>}
    <nav className="next-dock" aria-label="Dock"><Button variant="ghost" onClick={() => router.home()}>Home</Button>{apps.map(app => <Button variant="outline" key={app.id} aria-label={`Open ${app.title}`} aria-current={route.focused===app.id?'page':undefined} data-open={visible.some(t => t.id===app.id)||undefined} onClick={() => route.focused===app.id?router.remove(app.id,true):open(app.id)}>{app.title}{route.tiles.find(t => t.id===app.id)?.minimized ? ' ·' : ''}</Button>)}</nav>
    {menu&&<ContextMenu at={menu} close={()=>setMenu(undefined)} />}
    <p className="next-notice" role="status" aria-live="polite">{notice}</p>
  </div>;
}
