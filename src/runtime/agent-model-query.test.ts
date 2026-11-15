import {afterEach,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const document='{agentModels(orderBy:{agent:{direction:asc,priority:0},position:{direction:asc,priority:1}}){agent model position}}';
async function fixture(){
 const f=await bodyFixture(clean);
 f.db.insert(s.memberAgents).values({member:'bob',agent:'mark'}).run();
 f.db.insert(s.agentModels).values([{agent:'art',model:'fallback',position:1},{agent:'art',model:'preferred',position:0},{agent:'mark',model:'mark-only',position:0}]).run();
 const read=async(token=bodyCredentials.member)=>{const response=await f.root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:document})});const result=await response.json();expect(response.status).toBe(200);expect(result.errors).toBeUndefined();return result.data.agentModels;};
 return {...f,read};
}
it('exposes the ordered list with current agent visibility, including household owners',async()=>{
 const f=await fixture();
 expect(await f.read()).toEqual([{agent:'art',model:'preferred',position:0},{agent:'art',model:'fallback',position:1}]);
 const bob=f.root.writes.run(()=>f.root.services.signin.issue({kind:'owner',member:'bob',label:'Fictitious model reader'})).value;
 try{expect(await f.read(bob.token)).toEqual([{agent:'mark',model:'mark-only',position:0}]);}
 finally{f.root.writes.run(()=>f.root.services.signin.revoke(bob.fingerprint));}
 f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run());
 expect(await f.read()).toHaveLength(3);
});
it('withdraws preferences when the viewers project or agent access ends',async()=>{
 const f=await fixture();
 f.root.writes.run(()=>f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run());
 expect(await f.read()).toHaveLength(3);
 f.root.writes.run(()=>f.db.delete(s.projectMembers).where(and(eq(s.projectMembers.project,'pond'),eq(s.projectMembers.member,'alice'))).run());
 expect(await f.read()).toEqual([{agent:'art',model:'preferred',position:0},{agent:'art',model:'fallback',position:1}]);
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(and(eq(s.memberAgents.member,'alice'),eq(s.memberAgents.agent,'art'))).run());
 expect(await f.read()).toEqual([]);
});
