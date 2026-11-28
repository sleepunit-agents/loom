import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h,useSyncExternalStore} from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import {act,create} from 'react-test-renderer';
const f=vi.hoisted(()=>({snapshot:{} as any,listeners:new Set<()=>void>(),images:[] as string[],queries:[] as any[],decode:vi.fn()}));
vi.mock('./data/graphql',()=>({useDataQuery:(document:string,variables:object)=>{f.queries.push({document,variables});return useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshot);}}));
vi.mock('./access',()=>({reducedMotion:()=>true,motionQuery:()=>({matches:true,addEventListener(){},removeEventListener(){}})}));
import PixelFace,{deskSpriteQuery} from './pixel-face';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>|undefined;
const variant={row:0,frames:2,weight:1};
const asset=(version:string)=>({version,layout:JSON.stringify({cell:[96,84],states:{idle:{south:[variant]}}}),sheets:JSON.stringify({'sheet.png':'AA=='})});
const packet=(version:string)=>({status:'live',data:{deskSprite:asset(version)}});
async function publish(snapshot:any){await act(async()=>{f.snapshot=snapshot;f.listeners.forEach(fn=>fn());});}
const context={clearRect:vi.fn(),save(){},restore(){},drawImage:vi.fn(),translate(){},scale(){}};
async function draw(version:string){await act(async()=>{tree=create(h(PixelFace,{sprite:{agent:'art',v:version},size:96,fallback:h('drawn-fallback')}),{createNodeMock:()=>({dataset:{},width:96,height:84,getContext:()=>context})});});}
beforeEach(()=>{
 f.listeners.clear();f.images=[];f.queries=[];f.decode.mockReset().mockResolvedValue(undefined);context.drawImage.mockClear();
 vi.stubGlobal('window',{setTimeout,clearTimeout});vi.stubGlobal('document',{visibilityState:'visible',addEventListener(){},removeEventListener(){}});
 vi.stubGlobal('IntersectionObserver',class{constructor(private cb:(entries:{isIntersecting:boolean}[])=>void){}observe(){this.cb([{isIntersecting:true}]);}disconnect(){}});
 vi.stubGlobal('Image',class{width=192;set src(value:string){f.images.push(value);}async decode(){await f.decode();}});
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No separate asset HTTP request');}));
});
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;vi.unstubAllGlobals();});
it.each(['loading','offline','denied'])('paints queried bytes and immediately clears retained pixels on %s',async status=>{
 const version='pixel-source-'+status;f.snapshot=packet(version);await draw(version);
 expect(context.drawImage).toHaveBeenCalled();expect(f.images).toEqual(['data:image/png;base64,AA==']);expect(fetch).not.toHaveBeenCalled();
 expect(f.queries.every(query=>query.document===deskSpriteQuery&&query.variables.agent==='art'&&query.variables.version===version)).toBe(true);
 await publish({...f.snapshot,status});expect(tree!.root.findAllByType('canvas')).toHaveLength(0);expect(tree!.root.findAllByType('drawn-fallback')).toHaveLength(1);
});
it('does not paint a retained prior version while the new exact query is pending',async()=>{
 f.snapshot=packet('pixel-old');await draw('pixel-old');expect(tree!.root.findAllByType('canvas')).toHaveLength(1);
 await act(async()=>tree!.update(h(PixelFace,{sprite:{agent:'art',v:'pixel-new'},size:96,fallback:h('drawn-fallback')})));
 expect(tree!.root.findAllByType('canvas')).toHaveLength(0);
 await publish(packet('pixel-new'));expect(tree!.root.findAllByType('canvas')).toHaveLength(1);
});
it('keeps a late image decode from restoring pixels after access is lost',async()=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});f.decode.mockReturnValue(held);f.snapshot=packet('pixel-late');await draw('pixel-late');
 await publish({...f.snapshot,status:'denied'});await act(async()=>{release();await held;});
 expect(tree!.root.findAllByType('canvas')).toHaveLength(0);expect(tree!.root.findAllByType('drawn-fallback')).toHaveLength(1);
});
it('uses the drawn fallback on malformed documents',async()=>{
 f.snapshot={status:'live',data:{deskSprite:{...asset('pixel-bad'),layout:'{}'}}};await draw('pixel-bad');expect(tree!.root.findAllByType('canvas')).toHaveLength(0);
 expect(tree!.root.findAllByType('drawn-fallback')).toHaveLength(1);
});
