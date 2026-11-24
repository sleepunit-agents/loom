import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
import {FakeClock} from '../dist/core/clock.js';
import {agentPeople,bridgeConnections,bridgePeople,secrets} from '../dist/core/data/schema.js';
import {exampleHome} from '../dist/example-home.js';
import {BridgeIncoming} from '../dist/pieces/bridges/incoming.js';
import {outsidePersonKey} from '../dist/pieces/bridges/keys.js';
import {normalizeDiscord,normalizeSlack} from '../dist/pieces/bridges/normalize.js';
import {startSharedHome} from '../dist/shared-startup.js';

export async function bridgeMessageVisibility(){
 const dir=await mkdtemp(join(tmpdir(),'loom-private-bridge-'));
 let app;
 try{
  const home=join(dir,'home'),example=await exampleHome(home);
  assert(example.fictional);
  const clock=new FakeClock(Date.parse(example.createdAt)),now=()=>new Date(clock.now()).toISOString();
  app=await startSharedHome({home,clock,port:0,stdout(){}});
  const services=app.services,db=services.comms.db,write=fn=>app.writes.run(fn).value;
  assert.equal(services.bridges.daemon,undefined);
  const ingress=new BridgeIncoming(db,now),records=[];
  write(()=>{
   services.household.setMember({id:'casey',role:'owner',fullOwner:false,agents:[]});
   const tokenSecret='bridge-privacy-placeholder';
   db.insert(secrets).values({name:tokenSecret,description:'Fictional',changedBy:'alex',changedAt:now()}).run();
   for(const platform of ['discord','slack']){
    const connection={id:'visibility-'+platform,workspace:'workspace-'+platform};
    db.insert(bridgeConnections).values({...connection,platform,agent:'fern',botUser:'fictional-bot',tokenSecret,enabled:true,state:'connected',stateAt:now()}).run();
    db.insert(bridgePeople).values({platform,workspace:connection.workspace,user:'linked',member:'robin'}).run();
    db.insert(agentPeople).values({agent:'fern',person:outsidePersonKey(platform,connection.workspace,'guest'),tier:2}).run();
    for(const enabled of [true,false]){
     db.update(bridgeConnections).set({enabled}).where(eq(bridgeConnections.id,connection.id)).run();
     for(const [index,kind] of ['member','guest','group'].entries()){
      const channel=kind+'-'+enabled,user=kind==='guest'?'guest':'linked',words=[platform,channel,'private fixture words'].join(' ');
      const msg=platform==='slack'
       ?normalizeSlack(connection,{type:'event_callback',team_id:connection.workspace,event:{type:'message',channel,channel_type:kind==='group'?'mpim':'im',user,text:words,ts:Math.floor(clock.now()/1000)+'.00000'+(index+(enabled?1:4))}})
       :normalizeDiscord(connection,{op:0,t:'MESSAGE_CREATE',d:{type:0,id:channel,channel_id:channel,author:{id:user},content:words,timestamp:now(),mentions:[]}}, {id:channel,kind:'dm',group:kind==='group'});
      assert(msg);
      const receipt=ingress.receive(msg);
      assert.equal(receipt.state,enabled?'delivered':'held',receipt.reason);
      records.push({id:receipt.id,text:words,reader:kind==='member'?'robin':'alex'});
     }
    }
   }
  });
  for(const member of ['alex','robin','casey']){
   const token=write(()=>services.signin.issue({kind:'owner',member,label:'Fictional bridge reader '+member})).token;
   const ids=records.map(row=>row.id);
   const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:'query ReadIncoming($ids:[String!]!){bridgeIncoming(where:{id:{inArray:$ids}}){id text}}',variables:{ids}})});
   assert.equal(response.status,200);
   const result=await response.json();
   assert.equal(result.errors,undefined);
   const sorted=rows=>rows.slice().sort((a,b)=>a.id.localeCompare(b.id));
   assert.deepEqual(sorted(result.data.bridgeIncoming), sorted(records.filter(r=>r.reader===member).map(({id,text})=>({id,text}))));
  }
  return {ok:true,reason:'Three authenticated readers queried the retained words of twelve delivered or held Slack and Discord receipts. Linked private messages reached the member. Group and guest direct messages reached the agent’s owner. A household owner without the agent received none.'};
 }finally{
  try{await app?.close();}finally{await rm(dir,{recursive:true,force:true});}
 }
}
