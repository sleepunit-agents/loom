import { expect, it, vi } from 'vitest';
import { createElement as h } from '../../../web/node_modules/react/index.js';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from '../../../web/node_modules/react-test-renderer/index.js';
import Database from 'better-sqlite3';
import { graphql } from 'graphql/index.js';
import { sql } from 'drizzle-orm';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { withQueryFields } from './http';
import { taskVisibility } from './visibility';
import { agents, members, memberAgents, memberPreferences } from './schema';
import { CommsQueries, commsQueryFields } from '../conversations/comms-query';
const wire=vi.hoisted(()=>({create:vi.fn(),subscribe:vi.fn(),closed:undefined as undefined|(()=>void)}));
vi.mock('../../../web/node_modules/graphql-ws/dist/index.js',()=>({createClient:(options:{on:{closed:()=>void}})=>{
  wire.create();wire.closed=options.on.closed;return {subscribe:wire.subscribe,dispose:vi.fn()};
}}));
import { useDeskRoster } from '../../../web/src/pieces/attention/roster';
import { useMemberPreferences } from '../../../web/src/shell/member-preferences';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('runs roster and preferences through one canonical client, applying current member changes and clearing disconnected readers',async()=>{
 const client=new Database(':memory:');let tree:ReturnType<typeof create>|undefined;
 vi.stubGlobal('location',{protocol:'https:',host:'desk.invalid'});
 try {
  const at='2026-11-14T00:00:00Z',db=createDataSchema(client,()=>at);
  db.insert(members).values([{id:'sam',role:'owner',joinedAt:at},{id:'other',role:'owner',joinedAt:at}]).run();
  const agent={about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble' as const,faceEyes:'dot' as const};
  db.insert(agents).values([{...agent,id:'art',position:2},{...agent,id:'mark',position:1}]).run();
  db.insert(memberAgents).values([{member:'sam',agent:'art'},{member:'other',agent:'mark'}]).run();
  const prefs={ground:'depth' as const,sound:false,pixel:true,icons:false,haptics:true,oneWindow:false,zoom:false,motion:'follow' as const,contrast:'follow' as const,changedAt:at};
  db.insert(memberPreferences).values([{...prefs,member:'sam',look:'daylight'},{...prefs,member:'other',look:'lowlight'}]).run();
  const key={seal:async(s:string)=>Buffer.from(s),hash:(s:string)=>s,open:async()=>{throw Error('Desk must not read words');}};
  const service=new CommsQueries(db,key,()=>sql`false`,()=>at);
  let member='sam';
  const selections=new Map<string,{revision:number;sink:{next(value:unknown):void};stop:ReturnType<typeof vi.fn>}>();
  wire.subscribe.mockImplementation((request:{variables:{query:string}},sink:{next(value:unknown):void})=>{
    const stop=vi.fn();selections.set(request.variables.query,{revision:0,sink,stop});return stop;
  });
  const refresh=async()=>{
    const viewer={kind:'member' as const,id:member};
    // This deliberately broad preference fixture proves the adapter uses the
    // authenticated member. It is not the production preference policy.
    const schema=withQueryFields(dataQueries(client,{tables:['agents','memberPreferences'],visibility:{...taskVisibility(viewer),memberPreferences:()=>sql`true`}}),commsQueryFields(service));
    await act(async()=>{
      for(const [query,selection] of selections){
        const result=await graphql({schema,source:query,contextValue:{viewer}});expect(result.errors).toBeUndefined();
        selection.sink.next({data:{observe:{revision:++selection.revision,patches:[{path:[],removed:false,value:result.data}]}}});
      }
    });
  };
  function Desk(){const roster=useDeskRoster(),preferences=useMemberPreferences();return h('desk-readers',{roster,preferences});}
  await act(async()=>{tree=create(h(Desk));});
  await act(async()=>{await expect.poll(()=>selections.size).toBe(3);});
  expect(wire.create).toHaveBeenCalledTimes(1);
  const state=()=>tree!.root.findByType('desk-readers').props;
  await refresh();expect(state().roster.records.map((a:{id:string})=>a.id)).toEqual(['art']);
  expect(state().preferences.records[0]).toMatchObject({id:'sam',prefs:{look:'daylight'}});
  member='other';await refresh();
  expect(state().roster.records.map((a:{id:string})=>a.id)).toEqual(['mark']);
  expect(state().preferences.records[0]).toMatchObject({id:'other',prefs:{look:'lowlight'}});
  db.delete(memberAgents).run();await refresh();expect(state().roster.records).toEqual([]);
  member='missing';await refresh();
  expect(state().roster).toEqual({status:'denied',records:[]});
  expect(state().preferences).toEqual({status:'denied',records:[]});
  member='other';await refresh();expect(state().preferences.records[0].id).toBe('other');
  await act(async()=>wire.closed!());
  expect(state().roster).toEqual({status:'offline',records:[]});
  expect(state().preferences).toEqual({status:'offline',records:[]});
  await act(async()=>tree!.unmount());tree=undefined;
  expect([...selections.values()].every(s=>s.stop.mock.calls.length===1)).toBe(true);
 }finally{if(tree)await act(async()=>tree!.unmount());vi.unstubAllGlobals();client.close();}
});
