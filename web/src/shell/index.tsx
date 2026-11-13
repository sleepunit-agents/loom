import { Component, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { DeskRouter, currentPath, type AppRegistration, type Tile } from './router';
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
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); const n = visible.findIndex(t => t.id === route.focused); const next = visible[(n+1)%visible.length]; if(next) router.focus(next.id); }
      if (!typing && e.key === 'Escape') setLauncher(false);
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w' && route.focused) { e.preventDefault(); router.remove(route.focused); }
    };
    window.addEventListener('keydown',key); return () => window.removeEventListener('keydown',key);
  },[visible,route.focused,router]);
  const focused = visible.find(t => t.id === route.focused) ?? visible[0];
  return <div className="next-shell" data-shell={phone ? 'phone' : 'desk'}>
    <header className="next-bar"><strong>LOOM<span aria-hidden="true">//</span>OS</strong><span>{apps.find(a => a.id === focused?.id)?.title ?? 'Home'}</span><Button variant="ghost" size="sm" onClick={() => setLauncher(!launcher)}>All apps</Button></header>
    <div ref={ground} className="next-ground">
      {!visible.length && (Home ? <Home go={path => { const app=apps.find(a=>path===a.path||path.startsWith(a.path+'/')); if(app){open(app.id);router.go(app.id,path);} }} /> : <Empty title="Your desk" text="Open an app from the dock." />)}
      {!phone && Rail && visible.length>0 && <aside className="next-rail" style={{width:railWidth(width)||64}}><Rail go={path => {const app=apps.find(a=>path===a.path||path.startsWith(a.path+'/'));if(app){open(app.id);router.go(app.id,path);}}} /></aside>}
      {(phone ? focused ? [focused] : [] : visible).map(tile => {
        const app = apps.find(a => a.id === tile.id)!;
        const box = boxes[tile.id];
        return <section key={tile.id} className="next-tile" data-tile={tile.id} data-focused={route.focused === tile.id || undefined} aria-label={`${app.title} tile`}
          style={phone ? undefined : {left:box.x,top:box.y,width:box.w,height:box.h}} onFocusCapture={() => { if(route.focused!==tile.id) router.focus(tile.id); }} onPointerDown={() => { if(route.focused!==tile.id) router.focus(tile.id); }}>
          <header className="next-strip">
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
    <nav className="next-dock" aria-label="Dock"><Button variant="ghost" onClick={() => router.home()}>Home</Button>{apps.map(app => <Button variant="outline" key={app.id} aria-label={`Open ${app.title}`} aria-current={route.focused===app.id?'page':undefined} data-open={visible.some(t => t.id===app.id)||undefined} onClick={() => open(app.id)}>{app.title}{route.tiles.find(t => t.id===app.id)?.minimized ? ' ·' : ''}</Button>)}</nav>
    <p className="next-notice" role="status" aria-live="polite">{notice}</p>
  </div>;
}
