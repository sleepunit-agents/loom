import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {afterEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
const wire=vi.hoisted(()=>({next:undefined as undefined|((value:unknown)=>void),subscribe:vi.fn(),dispose:vi.fn(),close:undefined as undefined|((event:unknown)=>void)}));
vi.mock('graphql-ws',()=>({createClient:(options:{on:{closed:(event:unknown)=>void}})=>{wire.close=options.on.closed;return {subscribe:wire.subscribe,dispose:wire.dispose};}}));
import {useQuery} from './query';
let tree:ReactTestRenderer|undefined;
afterEach(async()=>{if(tree)await act(()=>tree!.unmount());tree=undefined;vi.unstubAllGlobals();});
it('draws shared live Memory selections, decodes null, and clears the screen on a closed connection',async()=>{
 vi.stubGlobal('location',{protocol:'https:',host:'loom.test'});
 wire.subscribe.mockImplementation((_request,sink)=>{wire.next=sink.next;return()=>{};});
 function Screen(){const result=useQuery({query:'query Page($slug:String!) { memoryKnowledgePage(slug:$slug) { title } }',variables:{slug:'fiction'},decode:(data:Record<string,unknown>)=>data.memoryKnowledgePage as {title:string}|null});return createElement('p',null,result.status==='live'?result.data?.title??'Gone':result.status);}
 await act(()=>{tree=create(createElement('div',null,createElement(Screen),createElement(Screen)));});
 expect(wire.subscribe).toHaveBeenCalledOnce();
 await act(()=>wire.next!({data:{observe:{revision:1,patches:[{path:[],removed:false,value:{memoryKnowledgePage:{slug:'fiction',title:'Fictional page',body:'Words'}}}]}}}));
 expect(JSON.stringify(tree!.toJSON())).toContain('Fictional page');
 await act(()=>wire.next!({data:{observe:{revision:2,patches:[{path:['memoryKnowledgePage'],removed:false,value:null}]}}}));
 expect(JSON.stringify(tree!.toJSON())).toContain('Gone');
 await act(()=>wire.close!({code:1006}));expect(JSON.stringify(tree!.toJSON())).toContain('offline');expect(JSON.stringify(tree!.toJSON())).not.toContain('Fictional page');
});
