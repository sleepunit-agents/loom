import {expect,it,vi} from 'vitest';
import {QueryStore,type QueryRequest,type QueryTransport} from './query-store';
function fixture(){
 let lost!:(denied:boolean)=>void;
 const streams:Array<{request:QueryRequest;next:(v:unknown)=>void;error:()=>void;complete:()=>void;stop:ReturnType<typeof vi.fn>}>=[];
 const transport:QueryTransport={subscribe:(request,next,error,complete)=>{const stop=vi.fn();streams.push({request,next,error,complete,stop});return stop;},close:vi.fn()};
 const factory=vi.fn(fn=>{lost=fn;return transport;});const store=new QueryStore(factory);
 const frame=(i:number,revision:number,patches:unknown[])=>streams[i].next({data:{observe:{revision,patches}}});
 return {store,streams,factory,transport,frame,lost:(denied=false)=>lost(denied)};
}
const a={query:'query($slug:String!){ memoryKnowledgePage(slug:$slug){title} }',variables:{slug:'fiction'}};
const initial=(value:unknown)=>[{path:[],removed:false,value}];
it('shares identical selections across readers and multiplexes other selections through one transport',()=>{
 const f=fixture(),one=vi.fn(),two=vi.fn(),three=vi.fn();
 const c1=f.store.subscribe(a,one),c2=f.store.subscribe({...a},two),c3=f.store.subscribe({query:'{ memoryPeople { name } }'},three);
 expect(f.factory).toHaveBeenCalledOnce();expect(f.streams).toHaveLength(2);
 expect(f.streams[0].request.variables).toMatchObject({query:a.query,variables:a.variables});
 f.frame(0,1,initial({memoryKnowledgePage:{title:'Fictional'}}));
 expect(one).toHaveBeenCalledOnce();expect(two).toHaveBeenCalledOnce();expect(three).not.toHaveBeenCalled();
 const before=f.store.getSnapshot(a);
 f.frame(0,2,[{path:['memoryKnowledgePage','title'],removed:false,value:'Changed'}]);
 expect(f.store.getSnapshot(a)).toEqual({status:'live',data:{memoryKnowledgePage:{title:'Changed'}}});
 expect(before.data).toEqual({memoryKnowledgePage:{title:'Fictional'}});
 c1();expect(f.streams[0].stop).not.toHaveBeenCalled();c2();expect(f.streams[0].stop).toHaveBeenCalledOnce();
 expect(f.store.getSnapshot(a)).toEqual({status:'loading'});c3();f.store.close();
});
it('applies array removals, additions, nulls and aliases in order',()=>{
 const f=fixture();f.store.subscribe(a,()=>{});
 f.frame(0,1,initial({alias:[{title:'one'},{title:'two'},{title:'three'}],detail:{title:'private'}}));
 f.frame(0,2,[{path:['alias',2],removed:true},{path:['alias',1],removed:true},{path:['alias',1],removed:false,value:{title:'new'}},{path:['detail'],removed:false,value:null}]);
 expect(f.store.getSnapshot(a)).toEqual({status:'live',data:{alias:[{title:'one'},{title:'new'}],detail:null}});f.store.close();
});
it('clears every word on disconnect, accepts fresh revision one and stops on denial',()=>{
 const f=fixture();f.store.subscribe(a,()=>{});f.frame(0,1,initial({word:'private'}));f.lost();
 expect(f.store.getSnapshot(a)).toEqual({status:'offline'});
 f.frame(0,1,initial({word:'new authority'}));expect(f.store.getSnapshot(a).data).toEqual({word:'new authority'});
 f.lost(true);expect(f.store.getSnapshot(a)).toEqual({status:'denied'});
 f.frame(0,1,initial({word:'late private frame'}));expect(f.store.getSnapshot(a)).toEqual({status:'denied'});
 f.store.subscribe({query:'{ other }'},()=>{});expect(f.streams).toHaveLength(1);f.store.close();
});
it.each([
 {data:{observe:{revision:3,patches:initial({word:'gap'})}}},
 {data:{observe:{revision:2,patches:[{path:['__proto__','polluted'],removed:false,value:true}]}}},
 {data:{observe:{revision:2,patches:[{path:['list',-1],removed:false,value:'bad'}]}}},
 {data:{word:'partial'},errors:[{message:'private driver words'}]},
])('discards partial or malformed deltas without retaining errors or words',bad=>{
 const f=fixture();f.store.subscribe(a,()=>{});f.frame(0,1,initial({word:'private',list:[]}));f.streams[0].next(bad);
 expect(f.store.getSnapshot(a)).toEqual({status:'error'});expect(f.streams[0].stop).toHaveBeenCalledOnce();
 expect(({} as Record<string,unknown>).polluted).toBeUndefined();f.store.close();
});
it('disposes the shared transport and releases all selection values',()=>{
 const f=fixture();f.store.subscribe(a,()=>{});f.frame(0,1,initial({word:'private'}));f.store.close();
 expect(f.transport.close).toHaveBeenCalledOnce();expect(f.store.getSnapshot(a)).toEqual({status:'offline'});
});
