import { afterEach, expect, it } from 'vitest';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { agentKitProjects, agentKits, projectOutsidePeople, kitUses, memberAgents } from './core/data/schema.js';

const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse()) await close();});
it('shows grants, the exact outside roster and filtered history only to the owner or owning body',async()=>{
  const f = await bodyFixture(clean), agent = 'art', kit = 'field', project = 'pond';
  f.db.insert(agentKits).values({agent,kit,tools:[]}).run();
  f.db.insert(agentKitProjects).values({agent,kit,project}).run();
  f.db.insert(projectOutsidePeople).values({project,platform:'slack',workspace:'T1',user:'U1'}).run();
  for(const person of ['sam','lee']) f.db.insert(kitUses).values({
    id:person,personKind:'member',person,agent,kit,job:'job',conversation:f.thread.conversation,
    at:new Date(f.clock.now()).toISOString(),tool:'lookup',outcome:'ran',
  }).run();
  const read = async(token:string)=>{
    const query = '{ kitCatalog(agent:"art"){definitions{kit} grants{kit project} projects{project outside{workspace user}} uses(kit:"field",person:"sam"){job person tool outcome}} }';
    const response=await f.root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query})});
    const result=await response.json();
    if (token === bodyCredentials.runner) {
      expect(result.errors).toEqual([{message:"Caller has no data projection"}]);
      return null;
    }
    expect(result.errors).toBeUndefined();
    return result.data.kitCatalog;
  };
  for(const token of [bodyCredentials.member,bodyCredentials.agent,bodyCredentials.body]){
    expect(await read(token)).toMatchObject({definitions:[{kit}],grants:[{kit,project}],projects:[{project,outside:[{workspace:'T1',user:'U1'}]}],uses:[{job:'job',person:'sam',tool:'lookup',outcome:'ran'}]});
  }
  expect(await read(bodyCredentials.runner)).toBeNull();
  f.db.delete(memberAgents).run();
  expect(await read(bodyCredentials.body)).toBeNull();
  expect(await read(bodyCredentials.member)).toBeNull();
});
