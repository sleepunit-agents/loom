import { it, expect } from 'vitest';
import { DeskRouter, readRoute, writeRoute, currentPath } from '../../web/src/shell/router.js';
import { layout, admit, type AppTile } from '../../web/src/tiling/layout.js';
const apps = [
  {id:'tasks',title:'Tasks',path:'/p/tasks-preview',fit:{min:[520,320] as [number,number],ideal:1040,max:null,big:true,why:'list'}},
  {id:'example',title:'Example',path:'/_dev/live-example',fit:{min:[320,280] as [number,number],ideal:520,max:680,big:false,why:'list'}},
];
function browser() {
  const location = {href:'http://loom/'};
  const listeners = new Set<()=>void>();
  const history = { pushState(_s:unknown,_t:string,path:string) { location.href='http://loom'+path; },replaceState(_s:unknown,_t:string,path:string) { location.href='http://loom'+path; } };
  return {location,history,addEventListener:(_n:string,fn:()=>void)=>listeners.add(fn),removeEventListener:(_n:string,fn:()=>void)=>listeners.delete(fn),pop:(path:string)=>{location.href='http://loom'+path;listeners.forEach(f=>f());}};
}
it('one router restores both app paths, focused/minimized/pinned states, and rejects unknown apps',()=>{
  const b=browser(); const r=new DeskRouter(apps,b as never);r.subscribe(()=>{});
  r.open('tasks');r.go('tasks','/p/tasks-preview/task/t-12');r.open('example');r.go('example','/_dev/live-example/sub?filter=a');r.big('tasks');
  const restored=readRoute(b.location.href,apps);
  expect(restored.tiles.map(t=>[t.id,currentPath(t)])).toEqual([['tasks','/p/tasks-preview/task/t-12'],['example','/_dev/live-example/sub?filter=a']]);
  expect(restored.tiles[0].pinned).toBe(true);expect(restored.focused).toBe('example');
  r.remove('tasks',true);expect(readRoute(b.location.href,apps).tiles.find(t=>t.id==='tasks')?.minimized).toBe(true);
  r.open('tasks');expect(currentPath(r.getSnapshot().tiles[0])).toBe('/p/tasks-preview/task/t-12');
  r.travel('tasks',-1);expect(currentPath(r.getSnapshot().tiles[0])).toBe('/p/tasks-preview');
  r.travel('tasks',1);expect(currentPath(r.getSnapshot().tiles[0])).toBe('/p/tasks-preview/task/t-12');
  b.pop('/?t=alien,*example&paths=%7B%22example%22%3A%22https%3A%2F%2Fevil%22%7D');
  expect(r.getSnapshot().tiles.map(t=>t.id)).toEqual(['example']);expect(currentPath(r.getSnapshot().tiles[0])).toBe('/_dev/live-example');r.close();
});
it('pure tiling draws the registrations without overlap and admits by fit and cap',()=>{
  const tiles:AppTile[]=apps.map(a=>({id:a.id,name:a.title,fit:a.fit}));
  const area={x:0,y:0,w:1232,h:720};const boxes=layout(tiles,area,1280).apps;
  expect(boxes.tasks.x+boxes.tasks.w).toBeLessThan(boxes.example.x);
  expect(boxes.tasks.w).toBeGreaterThanOrEqual(520);expect(boxes.example.w).toBeGreaterThanOrEqual(320);
  const third={...tiles[1],id:'third'};
  const result=admit(tiles,third,area,1100,{usedAt:{tasks:3,example:0}});
  expect(result.apps.map(t=>t.id)).toEqual(['tasks','third']);expect(result.docked[0].app.id).toBe('example');
  expect(readRoute(writeRoute({tiles:[]}),apps)).toEqual({tiles:[],focused:undefined});
});
