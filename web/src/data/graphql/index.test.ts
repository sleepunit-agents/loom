import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
// @ts-expect-error The renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
const f=vi.hoisted(()=>({
 sinks:[] as {next(value:unknown):void}[],
 stops:[] as ReturnType<typeof vi.fn>[],
 closed:undefined as undefined|((event:{code:number})=>void),
 create:vi.fn(),dispose:vi.fn(),
}));
vi.mock('graphql-ws',()=>({createClient:(options:{url:string;on:{closed(event:{code:number}):void}})=>{
 f.create(options);f.closed=options.on.closed;
 return {subscribe:(_request:unknown,sink:{next(value:unknown):void})=>{f.sinks.push(sink);const stop=vi.fn();f.stops.push(stop);return stop;},dispose:f.dispose};
}}));
import { useDataQuery } from './index';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('uses one window connection for both consumers and drops retained rows on access loss',async()=>{
 vi.stubGlobal('location',{protocol:'https:',host:'desk.invalid'});
 function Read({agent}:{agent:string}){const snapshot=useDataQuery<{currentJobs:{id:string}[]}>('query Jobs($agent:String!){currentJobs(agent:$agent){id}}',{agent});return createElement('p',null,JSON.stringify(snapshot));}
 let tree:ReturnType<typeof create>|undefined;
 try{
  await act(async()=>{tree=create(createElement('div',null,createElement(Read,{agent:'art'}),createElement(Read,{agent:'mark'})));});
  expect(f.create).toHaveBeenCalledOnce();expect(f.create).toHaveBeenCalledWith(expect.objectContaining({url:'wss://desk.invalid/graphql'}));expect(f.sinks).toHaveLength(2);
  await act(async()=>{for(const sink of f.sinks)sink.next({data:{observe:{revision:1,patches:[{path:[],removed:false,value:{currentJobs:[{id:'job'}]}}]}}});});
  expect(JSON.stringify(tree!.toJSON())).toContain('job');
  await act(async()=>{f.closed!({code:4403});});
  expect(JSON.stringify(tree!.toJSON())).toContain('denied');expect(JSON.stringify(tree!.toJSON())).not.toContain('job');
 }finally{if(tree)await act(async()=>tree!.unmount());vi.unstubAllGlobals();}
 expect(f.stops.every(stop=>stop.mock.calls.length>=1)).toBe(true);
});
