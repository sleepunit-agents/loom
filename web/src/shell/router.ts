/** The address and its browser history are the sole owner of app paths and tile state. */
import { admit, promote, underMinimum, capFor, swap, type AppTile, type Rect } from '../tiling/layout';
import type { Fit } from '../tiling/fit';
export interface AppRegistration { id: string; title: string; path: string; fit: Fit }
export interface Tile { id: string; trail: string[]; at: number; minimized?: boolean; pinned?: boolean; used: number }
export interface DeskRoute { tiles: Tile[]; focused?: string; home?: string[] }
export const currentPath = (tile: Tile) => tile.trail[tile.at];
export function readRoute(href: string, apps: readonly AppRegistration[]): DeskRoute {
  const url = new URL(href, 'http://loom');
  let paths: Record<string,string> = {};
  try { paths = JSON.parse(url.searchParams.get('paths') ?? '{}'); } catch { /* malformed address */ }
  const entries = (url.searchParams.get('t') ?? '').split(',');
  const minimized = (url.searchParams.get('m') ?? '').split(',');
  if (!url.searchParams.has('t') && !url.searchParams.has('m')) {
    const app = apps.find(a => url.pathname === a.path || url.pathname.startsWith(a.path + '/'));
    return app ? { tiles: [{ id: app.id, trail: [url.pathname + url.search], at: 0, used: 0 }], focused: app.id } : { tiles: [] };
  }
  const tiles: Tile[] = []; let focused: string | undefined;
  for (const [raw, min] of [...entries.map(x => [x,false] as const), ...minimized.map(x => [x,true] as const)]) {
    const id = raw.replace(/^\*/, '').replace(/!$/, '');
    const app = apps.find(a => a.id === id); if (!app || tiles.some(t => t.id === id)) continue;
    const path = paths && typeof paths[id] === 'string' && (paths[id] === app.path || paths[id].startsWith(app.path + '/') || paths[id].startsWith(app.path + '?')) ? paths[id] : app.path;
    if (!min && raw.startsWith('*') && !focused) focused = id;
    tiles.push({ id, trail: [path], at: 0, used: 0, minimized: min, pinned: !min && tiles.length === 0 && raw.endsWith('!') });
  }
  return { tiles, focused: focused ?? tiles.find(t => !t.minimized)?.id, ...(url.searchParams.has('h') ? {home:(url.searchParams.get('h')??'').split(',').filter(id=>tiles.some(t=>t.id===id))}: {}) };
}
export function writeRoute(route: DeskRoute): string {
  const focused = route.tiles.find(t => t.id === route.focused && !t.minimized);
  const url = new URL(focused ? currentPath(focused) : '/', 'http://loom');
  const visible = route.tiles.filter(t => !t.minimized);
  url.searchParams.set('t', visible.map(t => `${t.id === route.focused ? '*' : ''}${t.id}${t.pinned ? '!' : ''}`).join(','));
  const min = route.tiles.filter(t => t.minimized);
  if (min.length) url.searchParams.set('m', min.map(t => t.id).join(',')); else url.searchParams.delete('m');
  if(route.home) url.searchParams.set('h',route.home.join(',')); else url.searchParams.delete('h');
  url.searchParams.set('paths', JSON.stringify(Object.fromEntries(route.tiles.map(t => [t.id,currentPath(t)]))));
  return url.pathname + url.search;
}
export class DeskRouter {
  private route: DeskRoute;
  private subscribers = new Set<() => void>();
  private serial = 0;
  private area: Rect = {x:0,y:0,w:1920,h:900};
  private screen = 1920;
  constructor(readonly apps: readonly AppRegistration[], private browser: Pick<Window,'location'|'history'|'addEventListener'|'removeEventListener'>) {
    this.route = this.read();
    this.serial = Math.max(0,...this.route.tiles.map(t => t.used));
  }
  private read(): DeskRoute {
    const address = readRoute(this.browser.location.href,this.apps);
    const saved = this.browser.history.state?.loomNext as DeskRoute | undefined;
    if (saved && Array.isArray(saved.tiles) && saved.tiles.every(t => this.apps.some(a => a.id===t.id) && Array.isArray(t.trail) && t.trail.every(p => typeof p==='string') && Number.isInteger(t.at) && t.at>=0 && t.at<t.trail.length) && writeRoute(saved)===writeRoute(address)) return saved;
    return address;
  }
  private pop = () => { this.route = this.read(); this.emit(); };
  close = () => this.browser.removeEventListener('popstate', this.pop);
  getSnapshot = () => this.route;
  subscribe = (fn: () => void) => { this.subscribers.add(fn); this.browser.addEventListener('popstate',this.pop); return () => { this.subscribers.delete(fn); if(!this.subscribers.size) this.close(); }; };
  private emit() { this.subscribers.forEach(fn => fn()); }
  private save(route: DeskRoute, replace = false) {
    this.route = route;
    this.browser.history[replace ? 'replaceState' : 'pushState']({loomNext:route}, '', writeRoute(route)); this.emit();
  }
  asTiles(tiles = this.route.tiles): AppTile[] { return tiles.filter(t => !t.minimized).map(t => ({ id: t.id, name: this.apps.find(a => a.id === t.id)!.title, fit: this.apps.find(a => a.id === t.id)!.fit, pinned: t.pinned })); }
  open(id: string, area?: Rect, screen = this.screen, from?: string) {
    const app = this.apps.find(a => a.id === id); if (!app) return;
    const old = this.route.tiles.find(t => t.id === id);
    if (old && !old.minimized) { this.focus(id); return; }
    const added: Tile = old ? { ...old, minimized: false, used: ++this.serial } : { id, trail: [app.path], at: 0, used: ++this.serial };
    const others = this.route.tiles.filter(t => t.id !== id);
    const tile = { id, name: app.title, fit: app.fit, pinned: added.pinned };
    const result = admit(this.asTiles(others), tile, area ?? this.area, screen, { from: from ? { tile: from } : undefined, usedAt: Object.fromEntries(others.map(t => [t.id,t.used])) });
    const order = result.apps.map(t => ({ ...(t.id === id ? added : others.find(o => o.id === t.id)!), pinned: t.pinned }));
    const live = new Set(order.map(t => t.id));
    this.save({ tiles: [...order, ...others.filter(t => !live.has(t.id)).map(t => ({ ...t,minimized:true,pinned:false }))], focused: id });
    return result.docked;
  }
  focus(id: string) { if (this.route.tiles.some(t => t.id === id && !t.minimized)) this.save({ ...this.route, focused: id, tiles: this.route.tiles.map(t => t.id === id ? { ...t, used: ++this.serial } : t) },true); }
  go(id: string, path: string) {
    const app = this.apps.find(a => a.id === id);
    if (!app || !(path === app.path || path.startsWith(app.path + '/') || path.startsWith(app.path + '?'))) {
      const other = this.apps.find(a => path === a.path || path.startsWith(a.path + '/')); if (other) { this.open(other.id,undefined,undefined,id); this.go(other.id,path); } return;
    }
    this.save({ focused:id, tiles: this.route.tiles.map(t => t.id === id ? { ...t, trail: [...t.trail.slice(0,t.at+1),path], at:t.at+1 } : t) });
  }
  travel(id: string, step: number) { this.save({ ...this.route, tiles: this.route.tiles.map(t => t.id === id ? { ...t, at: Math.max(0,Math.min(t.trail.length-1,t.at+step)) } : t) }); }
  remove(id: string, minimize = false) {
    const tiles = minimize ? this.route.tiles.map(t => t.id === id ? { ...t, minimized:true,pinned:false } : t) : this.route.tiles.filter(t => t.id !== id);
    this.save({ tiles, focused: this.route.focused === id ? tiles.find(t => !t.minimized)?.id : this.route.focused });
  }
  big(id: string) {
    const order = promote(this.asTiles(),id);
    this.save({ ...this.route, tiles: [...order.map(t => ({ ...this.route.tiles.find(o => o.id === t.id)!,pinned:t.pinned })), ...this.route.tiles.filter(t => t.minimized)] });
  }
  fit(area: Rect, screen: number) {
    this.area=area;this.screen=screen;
    const tiles = this.route.tiles.map(t => ({...t})); const notices: string[]=[];
    for (;;) {
      const active = this.asTiles(tiles); const under = underMinimum(active,area,screen);
      if (active.length<=capFor(screen) && !under) break;
      const eligible = tiles.filter(t=>!t.minimized&&!t.pinned&&t.id!==this.route.focused);
      if(!eligible.length) break;
      const gone=eligible.reduce((a,b)=>b.used<a.used?b:a); gone.minimized=true;
      notices.push(`${this.apps.find(a=>a.id===gone.id)!.title} went to the dock to keep tiles usable.`);
    }
    if(notices.length) this.save({...this.route,tiles},true);
    return notices;
  }
  swap(id: string, other: string) {
    const active=this.asTiles();const order=swap(active,active.findIndex(t=>t.id===id),active.findIndex(t=>t.id===other));
    this.save({...this.route,tiles:[...order.map(t=>({...this.route.tiles.find(o=>o.id===t.id)!,pinned:t.pinned})),...this.route.tiles.filter(t=>t.minimized)]});
  }
  home() {
    if(this.route.home) {const order=this.route.home;this.save({tiles:[...order.flatMap(id=>{const t=this.route.tiles.find(t=>t.id===id);return t?[{...t,minimized:false}]:[]}),...this.route.tiles.filter(t=>!order.includes(t.id))],focused:order[0]});}
    else this.save({ tiles: this.route.tiles.map(t => ({ ...t,minimized:true })),home:this.route.tiles.filter(t=>!t.minimized).map(t=>t.id) });
  }
}
