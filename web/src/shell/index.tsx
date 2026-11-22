import { Component, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { DeskRouter, currentPath, presentedTiles, type AppRegistration, type Tile } from './router';
import { ContextMenu, type MenuAt } from '../tiling/menu';
import { layout, railWidth, type Rect } from '../tiling/layout';
import { Loading, Error, Button, Empty } from '../kit';
import './shell.css';
import { Dock } from '../components/ui/dock';
import { AppIcon } from '../app-icon';
import { tintOf } from '../tint';
import Launcher from './launcher';
import { useHiding } from './hiding';
import { useCompanion } from './companion';
import { RailContext } from '../desk-rail';
import { useMemberPreferences } from './member-preferences';
import { buzz, HapticLabel, useHaptics } from '../haptic';
import { oneWindowKept } from '../look';
import { recency, useShortcuts } from './shortcuts';
import Switcher from './switcher';
import { WindowLoad } from './loading';
import { useDeparture, useDockRestore } from './window-motion';
export interface RegisteredApp extends AppRegistration { icon: string; Screen: LazyExoticComponent<ComponentType<{ path?: string; go?: (path: string) => void; active?: boolean; visible?: boolean }>> }
/** The shell only consumes registrations. Home and agent rail will register alongside other apps. */
class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed:false };
  static getDerivedStateFromError() { return { failed:true }; }
  render() { return this.state.failed ? <Error text="This app could not open. Close it and try again." /> : this.props.children; }
}
function Screen({ app, tile, router, active, visible }: { app: RegisteredApp; tile: Tile; router: DeskRouter; active: boolean; visible:boolean }) {
  const View = app.Screen;
  return <AppBoundary><Suspense fallback={<Loading label={`Opening ${app.title}…`} />}><View active={active} visible={visible} path={currentPath(tile)} go={path => router.go(tile.id,path)} /></Suspense></AppBoundary>;
}
export interface ShellSurfaces { Notice?: ComponentType<{ go(path: string): void }>; Home?: ComponentType<{ go(path: string): void }>; Rail?: ComponentType<{ go(path: string): void }>; Signals?: ComponentType<{ go(path:string):void; onAttention:(value:boolean)=>void }>; Bar?: ComponentType<{ title: string; go(path: string): void }> }
export default function Shell({ apps, surfaces = {} }: { apps: readonly RegisteredApp[]; surfaces?: ShellSurfaces }) {
  const [router] = useState(() => new DeskRouter(apps, window));
  const route = useSyncExternalStore(router.subscribe,router.getSnapshot);
  const preferences = useMemberPreferences();
  const haptics = useHaptics();
  const [keptOneWindow] = useState(oneWindowKept);
  const lastOneWindow = useRef(keptOneWindow);
  if (preferences.status === 'live') lastOneWindow.current = preferences.records[0]?.prefs.oneWindow === true;
  else if (preferences.status === 'denied') lastOneWindow.current = false;
  const oneWindow = lastOneWindow.current;
  const ground = useRef<HTMLDivElement>(null);
  const depart = useDeparture(ground, (id, minimize) => router.remove(id, minimize));
  const [area,setArea] = useState<Rect>({x:0,y:0,w:innerWidth-48,h:innerHeight-130});
  const [width,setWidth] = useState(innerWidth);
  const phone = width < 1024;
  const [notice,setNotice] = useState('');
  const [menu,setMenu] = useState<MenuAt>();
  const hiding = useHiding(!!menu,setNotice);
  const [attention,setAttention] = useState(false);
  const railAs = hiding.modes.rail==='always'&&!railWidth(width)?'strip':hiding.modes.rail;
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
  const { Home, Rail, Bar, Signals, Notice } = surfaces;
  const companion = useCompanion(!phone&&!!Rail&&visible.length>0&&railWidth(width)>100&&(railAs==='always'||hiding.peek.rail));
  const workArea = { ...area,w:Math.max(1,area.w - (Rail && visible.length ? (railAs==='always'?railWidth(width)+10:railAs==='strip'?24:0) : 0)) };
  useEffect(() => { if(!phone) {const notices=router.fit(workArea,width,oneWindow);if(notices.length)setNotice(notices.join(' '));} },[workArea.w,workArea.h,width,phone,oneWindow,route.maximized,router]);
  const focused = visible.find(t => t.id === route.focused) ?? visible[0];
  // Open apps are the route's tiles, shown or minimized: what the dock marks as open. Most recently in front first;
  // kept here for this visit only, and seeded from the router's own use order for apps not yet seen in front.
  const [recent,setRecent] = useState<readonly string[]>([]);
  const recentNow = recency(recent,[...route.tiles].sort((a,b)=>b.used-a.used).map(t=>t.id),focused?.id);
  if (recentNow !== recent) setRecent(recentNow);
  // Where the caret was in each app, so landing on an app puts typing back where it was.
  const carets = useRef(new Map<string,HTMLElement>());
  const [landed,setLanded] = useState<{id:string}>();
  const presented = presentedTiles(route,phone||oneWindow);
  const boxes = layout(router.asTiles(presented),workArea,width).apps;
  useDockRestore(ground, boxes, phone, route.tiles);
  const open = (id: string, tap = false) => {
    buzz(haptics,tap);
    const gone = router.open(id,phone ? undefined : workArea,phone ? 1920 : width,undefined,oneWindow);
    setNotice(gone?.map(t => t.why).join('. ') ?? ''); setLauncher(false);
    if (document.documentElement.dataset.sound === 'on') void import('../sound').then(s => s.chime('done'));
  };
  const keys = useShortcuts({
    toggleLauncher: () => setLauncher(v => !v),
    apps: () => ({ order: recentNow, focused: focused?.id }),
    land: id => { open(id); setLanded({id}); },
  });
  // The switcher takes no focus; a landing moves it, once the app is on the page, to where it last was in that app.
  useEffect(() => {
    if (!landed) return;
    const tile = document.querySelector<HTMLElement>(`[data-tile="${landed.id}"]`), caret = carets.current.get(landed.id);
    (caret?.isConnected && tile?.contains(caret) ? caret : tile)?.focus();
  },[landed]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable=true]');
      if (!typing && e.key === 'Escape') setLauncher(false);
      if(typing||document.querySelector(':is([role=dialog],[role=menu]):not([hidden], [hidden] *, .next-tile:not([data-focused]) *)')||!e.altKey) return;
      if(!e.shiftKey&&e.key.toLowerCase()==='h'){e.preventDefault();router.home();return;}
      const tile=visible.find(t=>t.id===route.focused);if(!tile)return;
      const key=e.key.toLowerCase();let acted=true;
      if(!e.shiftKey&&key==='h') router.home();
      else if(!e.shiftKey&&key==='arrowleft'&&tile.at>0) router.travel(tile.id,-1);
      else if(!e.shiftKey&&key==='arrowright'&&tile.at<tile.trail.length-1) router.travel(tile.id,1);
      else if(!phone&&e.shiftKey&&(e.code==='KeyF'||key==='f')) router.maximize(tile.id);
      else if(e.shiftKey&&key==='enter') router.big(tile.id);
      else if(e.shiftKey&&key==='m') depart(tile.id,true);
      else if(e.shiftKey&&key==='w') depart(tile.id);
      else if(e.shiftKey&&(e.code==='Comma'||e.code==='Period')){const n=visible.findIndex(t=>t.id===tile.id);const other=visible[n+(e.code==='Comma'?-1:1)];if(other)router.swap(tile.id,other.id);}
      else if(e.shiftKey&&key.startsWith('arrow')) {
        const here=boxes[tile.id];const cx=here.x+here.w/2,cy=here.y+here.h/2;
        const candidates=visible.filter(t=>t.id!==tile.id&&boxes[t.id]).filter(t=>{const r=boxes[t.id];return key==='arrowleft'?r.x+r.w<=here.x:key==='arrowright'?r.x>=here.x+here.w:key==='arrowup'?r.y+r.h<=here.y:r.y>=here.y+here.h;});
        candidates.sort((a,b)=>{const dist=(id:string)=>{const r=boxes[id];return (r.x+r.w/2-cx)**2+(r.y+r.h/2-cy)**2;};return dist(a.id)-dist(b.id);});
        if(candidates[0]){router.focus(candidates[0].id);document.querySelector<HTMLElement>(`[data-tile="${candidates[0].id}"]`)?.focus();}
      } else acted=false;
      if(acted)e.preventDefault();
    };
    window.addEventListener('keydown',key); return () => window.removeEventListener('keydown',key);
  },[visible,route.focused,router,boxes,phone]);
  const go = (path:string) => {
    if(path === '/') {router.home();return;}
    const app=apps.find(a=>path===a.path||path.startsWith(a.path+'/'));
    if(app){open(app.id);router.go(app.id,path);}
  };
  return <RailContext.Provider value={phone?null:companion}><div className="next-shell" data-shell={phone ? 'phone' : 'desk'} data-dock-mode={phone?'always':hiding.modes.dock}>
    {Notice && <Notice go={go} />}
    {Bar ? <Bar title={apps.find(a => a.id === focused?.id)?.title ?? 'Home'} go={go} /> : <header className="next-bar"><strong>LOOM<span aria-hidden="true">//</span>OS</strong><span>{apps.find(a => a.id === focused?.id)?.title ?? 'Home'}</span><Button variant="ghost" size="sm" onClick={() => setLauncher(!launcher)}>All apps</Button></header>}
    <div ref={ground} className="next-ground">
      {!visible.length && (Home ? <Home go={path => { const app=apps.find(a=>path===a.path||path.startsWith(a.path+'/')); if(app){open(app.id);router.go(app.id,path);} }} /> : <Empty title="Your desk" text="Open an app from the dock." />)}
      {!phone && Rail && visible.length>0 && <>
        {visible.length>0&&railAs!=='always'&&<button type="button" data-hide-part="rail" className="next-rail-edge" data-mode={railAs} data-attention={attention||undefined} aria-label="Show agents rail" aria-expanded={hiding.peek.rail}
          onClick={()=>hiding.show('rail',true)} onPointerEnter={()=>{if(railAs==='auto')hiding.show('rail',true);}} onPointerDown={e=>{if(e.pointerType==='touch')hiding.show('rail',true);}} onContextMenu={e=>setMenu(hiding.menu('rail',e))}><span aria-hidden="true">‹</span></button>}
        <aside aria-label="Your agents" tabIndex={-1} data-hide-part="rail" className="next-rail" data-mode={railAs} data-peek={hiding.peek.rail||undefined} inert={railAs!=='always'&&!hiding.peek.rail} style={{width:railWidth(width)||296}}
          onPointerEnter={()=>{if(railAs==='auto')hiding.show('rail',true);}} onPointerLeave={e=>{if(railAs==='auto'&&e.pointerType==='mouse'&&!menu)hiding.show('rail',false);}} onContextMenu={e=>setMenu(hiding.menu('rail',e))}>
          <Rail go={path => {const app=apps.find(a=>path===a.path||path.startsWith(a.path+'/'));if(app){open(app.id);router.go(app.id,path);}}} />
        </aside>
      </>}
      {route.tiles.map(tile => {
        const shown=presented.some(t => t.id === tile.id);
        const app = apps.find(a => a.id === tile.id)!;
        const isMaximized = route.maximized === tile.id;
        const box = boxes[tile.id];
        return <section key={tile.id} className="next-tile" data-tint={tintOf(app.title)} data-tile={shown?tile.id:undefined} hidden={!shown} tabIndex={-1} data-focused={route.focused === tile.id || undefined} aria-label={`${app.title} tile`}
          style={!shown?{display:'none'}:phone?undefined:{left:box.x,top:box.y,width:box.w,height:box.h}} onFocusCapture={e => { if(e.target!==e.currentTarget) carets.current.set(tile.id,e.target as HTMLElement); if(route.focused!==tile.id) router.focus(tile.id); }} onPointerDown={() => { if(route.focused!==tile.id) router.focus(tile.id); }}>
          <header className="next-strip" draggable={!phone} onDragStart={()=>{drag.current=tile.id;}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(drag.current)router.swap(drag.current,tile.id);drag.current=undefined;}} onDoubleClick={e=>{if(!(e.target as HTMLElement).closest('button'))depart(tile.id,true);}} onContextMenu={e=>{e.preventDefault();setMenu({x:e.clientX,y:e.clientY,title:app.title,back:e.currentTarget,items:[{id:'min',label:'Minimize',run:()=>depart(tile.id,true)},...(!phone?[{id:'maximize',label:isMaximized?'Restore size':'Maximize',run:()=>router.maximize(tile.id)}]:[]),...(visible[0]?.id!==tile.id?[{id:'big',label:'Make this the big one',run:()=>router.big(tile.id)}]:[]),{id:'close',label:'Close',run:()=>depart(tile.id)}]});}}>
            <button className="next-app-key" aria-label={`Go to ${app.title}`} onClick={() => router.go(tile.id,app.path)}><AppIcon app={app.id} name={app.icon} size="sm" house={24} /></button>
            <Button variant="ghost" size="sm" onClick={() => router.go(tile.id,app.path)} className="next-strip-title" onDoubleClick={() => depart(tile.id,true)}>{app.title}</Button>
            <span className="next-spacer" />
            {/* The three window controls, drawn as the how-it-works site draws them: a square, a line, a cross. */}
            {!phone && <button type="button" className="next-win" data-act={isMaximized?'restore':'maximize'} aria-label={`${isMaximized?'Restore':'Maximize'} ${app.title}`} title={isMaximized?'Restore size':'Maximize'} onClick={() => router.maximize(tile.id)}><i aria-hidden="true" /></button>}
            <button type="button" className="next-win" data-act="dock" aria-label={`Minimize ${app.title}`} title="Send to the dock" onClick={() => depart(tile.id,true)}><i aria-hidden="true" /></button>
            <button type="button" className="next-win" data-act="close" aria-label={`Close ${app.title}`} title="Close" onClick={() => depart(tile.id)}><i aria-hidden="true" /></button>
          </header>
          <WindowLoad app={app.id} icon={app.icon} title={app.title} visible={shown}><Screen app={app} tile={tile} router={router} visible={shown} active={shown && route.focused === tile.id} /></WindowLoad>
        </section>;
      })}
    </div>
    {!phone&&Signals&&<Signals onAttention={setAttention} go={path=>{const app=apps.find(a=>path===a.path||path.startsWith(a.path+'/'));if(app){open(app.id);router.go(app.id,path);}}}/>}
    <Launcher apps={apps} open={launcher&&!keys.switching} onOpenChange={setLauncher} launch={open} />
    <Switcher apps={apps} switching={keys.switching} pick={keys.pick} />
    {!phone&&hiding.modes.dock!=='always'&&<button type="button" data-hide-part="dock" className="next-dock-edge" data-mode={hiding.modes.dock} data-attention={attention||undefined} aria-label="Show dock" aria-expanded={hiding.peek.dock}
      onClick={()=>hiding.show('dock',true)} onPointerEnter={()=>{if(hiding.modes.dock==='auto')hiding.show('dock',true);}} onPointerDown={e=>{if(e.pointerType==='touch')hiding.show('dock',true);}} onContextMenu={e=>setMenu(hiding.menu('dock',e))}><span aria-hidden="true">⌃</span></button>}
    <div className="next-dock-bar loom-dock-bar" data-hide-part="dock" data-peek={hiding.peek.dock||undefined} inert={!phone&&hiding.modes.dock!=='always'&&!hiding.peek.dock}
      onPointerEnter={()=>{if(hiding.modes.dock==='auto')hiding.show('dock',true);}} onPointerLeave={e=>{if(hiding.modes.dock==='auto'&&e.pointerType==='mouse'&&!menu)hiding.show('dock',false);}}
      onContextMenu={e=>{if(!phone&&(!(e.target as Element).closest('button')||(e.target as Element).closest('button[aria-label="Home"],button[aria-label="All apps"]')))setMenu(hiding.menu('dock',e));}}><Dock variant="shelf" className="next-dock" aria-label="Dock" itemSize={44} magnification={1.25} value={route.focused??'home'} items={[
      {value:'home',label:'Home',tint:'pink',icon:<><AppIcon app="home" name="home" /><HapticLabel on={haptics}/></>,onSelect:()=>{buzz(haptics,true);router.home();}},
      ...apps.filter(app=>app.id!=='home-preview').map(app=>({value:app.id,label:app.title,name:`Open ${app.title}`,tint:tintOf(app.title),icon:<><AppIcon app={app.id} name={app.icon} /><HapticLabel on={haptics}/></>,open:route.tiles.some(t=>t.id===app.id),onSelect:()=>{if(route.focused===app.id){buzz(haptics,true);depart(app.id,true);}else open(app.id,true);}})),
      {value:'launcher',label:'All apps',tint:'olive',divider:true,icon:<><AppIcon app="launcher" name="grid-2x2" /><HapticLabel on={haptics}/></>,onSelect:()=>{buzz(haptics,true);setLauncher(true);}},
    ]} /></div>
    {menu&&<ContextMenu at={menu} close={()=>setMenu(undefined)} />}
    <p className="next-notice" role="status" aria-live="polite">{notice}</p>
  </div></RailContext.Provider>;
}
