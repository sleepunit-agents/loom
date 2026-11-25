/** The address and its browser history are the sole owner of app paths and tile state. */
import { admit, promote, underMinimum, capFor, swap, type AppTile, type Rect } from '../tiling/layout';
import type { Fit } from '../tiling/fit';
export interface AppRegistration { id: string; title: string; path: string; fit: Fit; aliases?: readonly {id:string;path:string;destination:string}[] }
export interface Tile { id: string; trail: string[]; at: number; minimized?: boolean; pinned?: boolean; used: number }
export interface DeskRoute { tiles: Tile[]; focused?: string; maximized?: string; home?: string[] }
/** One-window presentation preserves the other tiles and their navigation trails. */
export function presentedTiles(route: DeskRoute, oneWindow: boolean): Tile[] {
  const visible = route.tiles.filter(t => !t.minimized);
  const focused = visible.find(t => t.id === route.focused) ?? visible[0];
  return oneWindow || (focused && route.maximized === focused.id) ? visible.filter(t => t.id === focused?.id) : visible;
}
export const currentPath = (tile: Tile) => tile.trail[tile.at];
const ownsPath = (root:string,path:string) => path===root || path.startsWith(root+'/') || path.startsWith(root+'?');

export function resolveAppPath<T extends AppRegistration>(path:string,apps:readonly T[]) {
  for (const app of apps) {
    if (ownsPath(app.path,path)) return {app,path};
    const alias=app.aliases?.find(entry=>ownsPath(entry.path,path));
    if (alias) return {app,path:alias.destination+path.slice(alias.path.length)};
  }
}

function migrateTiles(route:DeskRoute, apps:readonly AppRegistration[]):DeskRoute {
  const owner=(id:string)=>apps.find(app=>app.aliases?.some(alias=>alias.id===id))?.id ?? id;
  if (!route.tiles.some(tile=>owner(tile.id)!==tile.id)) return route;
  const tiles:Tile[]=[];
  for (const id of new Set(route.tiles.map(tile=>owner(tile.id)))) {
    const group=route.tiles.filter(tile=>owner(tile.id)===id);
    const active=group.find(tile=>tile.id===route.focused) ?? group.find(tile=>!tile.minimized) ?? group[0];
    const ordered=[...group.filter(tile=>tile!==active),active];
    const trail=ordered.flatMap(tile=>tile.trail.map(path=>resolveAppPath(path,apps)?.path ?? path));
    tiles.push({...active,id,trail,at:trail.length-active.trail.length+active.at,
      pinned:group.some(tile=>tile.pinned),minimized:group.every(tile=>tile.minimized)});
  }
  return {tiles,focused:route.focused && owner(route.focused),maximized:route.maximized && owner(route.maximized),
    home:route.home && [...new Set(route.home.map(owner))]};
}

export function readRoute(href: string, apps: readonly AppRegistration[]): DeskRoute {
  const registrations=apps.flatMap(app=>[app,...(app.aliases ?? []).map(alias=>({...app,id:alias.id,path:alias.path}))]);
  const url = new URL(href, 'http://loom');
  let paths: Record<string,string> = {};
  try { paths = JSON.parse(url.searchParams.get('paths') ?? '{}'); } catch { /* malformed address */ }
  const entries = (url.searchParams.get('t') ?? '').split(',');
  const minimized = (url.searchParams.get('m') ?? '').split(',');
  if (!url.searchParams.has('t') && !url.searchParams.has('m')) {
    const destination=resolveAppPath(url.pathname+url.search,apps);
    return destination ? { tiles: [{ id: destination.app.id, trail: [destination.path], at: 0, used: 0 }], focused: destination.app.id } : { tiles: [] };
  }
  const tiles: Tile[] = []; let focused: string | undefined;
  for (const [raw, min] of [...entries.map(x => [x,false] as const), ...minimized.map(x => [x,true] as const)]) {
    const id = raw.replace(/^\*/, '').replace(/!$/, '');
    const app = registrations.find(a => a.id === id); if (!app || tiles.some(t => t.id === id)) continue;
    const path = paths && typeof paths[id] === 'string' && (paths[id] === app.path || paths[id].startsWith(app.path + '/') || paths[id].startsWith(app.path + '?')) ? paths[id] : app.path;
    if (!min && raw.startsWith('*') && !focused) focused = id;
    tiles.push({ id, trail: [path], at: 0, used: 0, minimized: min, pinned: !min && tiles.length === 0 && raw.endsWith('!') });
  }
  focused ??= tiles.find(t => !t.minimized)?.id;
  return migrateTiles({ tiles, focused, ...(focused && url.searchParams.get('maxTile') === focused ? {maximized:focused} : {}), ...(url.searchParams.has('h') ? {home:(url.searchParams.get('h')??'').split(',').filter(id=>tiles.some(t=>t.id===id))}: {}) },apps);
}
export function writeRoute(route: DeskRoute): string {
  const focused = route.tiles.find(t => t.id === route.focused && !t.minimized);
  const url = new URL(focused ? currentPath(focused) : '/', 'http://loom');
  const visible = route.tiles.filter(t => !t.minimized);
  url.searchParams.set('t', visible.map(t => `${t.id === route.focused ? '*' : ''}${t.id}${t.pinned ? '!' : ''}`).join(','));
  const min = route.tiles.filter(t => t.minimized);
  if (min.length) url.searchParams.set('m', min.map(t => t.id).join(',')); else url.searchParams.delete('m');
  if(focused && route.maximized === focused.id) url.searchParams.set('maxTile',focused.id); else url.searchParams.delete('maxTile');
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
  private oneWindow = false;
  constructor(readonly apps: readonly AppRegistration[], private browser: Pick<Window,'location'|'history'|'addEventListener'|'removeEventListener'>) {
    this.route = this.read();
    this.serial = Math.max(0,...this.route.tiles.map(t => t.used));
  }
  private read(): DeskRoute {
    const address = readRoute(this.browser.location.href,this.apps);
    const saved = this.browser.history.state?.loomNext as DeskRoute | undefined;
    if (saved && Array.isArray(saved.tiles) && saved.tiles.every(t => this.apps.some(a => a.id===t.id || a.aliases?.some(alias=>alias.id===t.id)) && Array.isArray(t.trail) && t.trail.every(p => typeof p==='string') && Number.isInteger(t.at) && t.at>=0 && t.at<t.trail.length)) {
      const migrated=migrateTiles(saved,this.apps);
      if(writeRoute(migrated)===writeRoute(address)) return migrated;
    }
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
  open(id: string, area?: Rect, screen = this.screen, from?: string, oneWindow = this.oneWindow, destination?: string) {
    this.oneWindow = oneWindow;
    const app = this.apps.find(a => a.id === id); if (!app) return;
    const old = this.route.tiles.find(t => t.id === id);
    if (old && !old.minimized) {
      if (destination) this.go(id,destination);
      else this.focus(id);
      return;
    }
    const added: Tile = old ? { ...old, minimized: false, used: ++this.serial } : { id, trail: [app.path], at: 0, used: ++this.serial };
    if (destination && currentPath(added) !== destination) {
      added.trail = [...added.trail.slice(0,added.at+1),destination];
      added.at = added.trail.length-1;
    }
    const others = this.route.tiles.filter(t => t.id !== id);
    const tile = { id, name: app.title, fit: app.fit, pinned: added.pinned };
    const result = oneWindow ? { apps: [...this.asTiles(others), tile], docked: [] } : admit(this.asTiles(others), tile, area ?? this.area, screen, { from: from ? { tile: from } : undefined, usedAt: Object.fromEntries(others.map(t => [t.id,t.used])) });
    const order = result.apps.map(t => ({ ...(t.id === id ? added : others.find(o => o.id === t.id)!), pinned: t.pinned }));
    const live = new Set(order.map(t => t.id));
    this.save({ tiles: [...order, ...others.filter(t => !live.has(t.id)).map(t => ({ ...t,minimized:true,pinned:false }))], focused: id });
    return result.docked;
  }
  focus(id: string) { if (this.route.tiles.some(t => t.id === id && !t.minimized)) this.save({ ...this.route, maximized:this.route.maximized===id?id:undefined, focused: id, tiles: this.route.tiles.map(t => t.id === id ? { ...t, used: ++this.serial } : t) },true); }
  go(id: string, path: string) {
    path=resolveAppPath(path,this.apps)?.path ?? path;
    const app = this.apps.find(a => a.id === id);
    if (!app || !(path === app.path || path.startsWith(app.path + '/') || path.startsWith(app.path + '?'))) {
      const other = this.apps.find(a => path === a.path || path.startsWith(a.path + '/') || path.startsWith(a.path + '?'));
      if (other) this.open(other.id,undefined,undefined,id,this.oneWindow,path);
      return;
    }
    this.save({ maximized:this.route.maximized===id?id:undefined, focused:id, tiles: this.route.tiles.map(t => t.id === id ? { ...t, used: ++this.serial, trail: [...t.trail.slice(0,t.at+1),path], at:t.at+1 } : t) });
  }
  travel(id: string, step: number) { this.save({ ...this.route, tiles: this.route.tiles.map(t => t.id === id ? { ...t, used: ++this.serial, at: Math.max(0,Math.min(t.trail.length-1,t.at+step)) } : t) }); }
  remove(id: string, minimize = false) {
    const tiles = minimize ? this.route.tiles.map(t => t.id === id ? { ...t, minimized:true,pinned:false } : t) : this.route.tiles.filter(t => t.id !== id);
    this.save({ tiles, focused: this.route.focused === id ? tiles.find(t => !t.minimized)?.id : this.route.focused });
  }
  maximize(id: string) {
    if (!this.route.tiles.some(tile => tile.id === id && !tile.minimized)) return;
    this.save({ ...this.route, focused:id, maximized:this.route.maximized===id?undefined:id });
  }
  big(id: string) {
    const order = promote(this.asTiles(),id);
    this.save({ ...this.route, maximized:undefined, tiles: [...order.map(t => ({ ...this.route.tiles.find(o => o.id === t.id)!,pinned:t.pinned })), ...this.route.tiles.filter(t => t.minimized)] });
  }
  fit(area: Rect, screen: number, oneWindow = false) {
    this.area=area;this.screen=screen;this.oneWindow=oneWindow;
    if(oneWindow || this.route.maximized) return [];
    const tiles = this.route.tiles.map(t => ({...t})); const notices: string[]=[];
    for (;;) {
      const active = this.asTiles(tiles); const under = underMinimum(active,area,screen);
      if (active.length<=capFor(screen) && !under) break;
      const eligible = tiles.filter(t=>!t.minimized&&t.id!==this.route.focused);
      if(!eligible.length) break;
      const gone=eligible.reduce((a,b)=>b.used<a.used?b:a); gone.minimized=true;gone.pinned=false;
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
