import assert from 'node:assert/strict';
import {eq} from 'drizzle-orm';
import {bridgeChannels,bridgeConnections,bridgePeople,secrets} from '../dist/core/data/schema.js';
import {BridgeIncoming} from '../dist/pieces/bridges/incoming.js';
import {normalizeDiscord,normalizeSlack} from '../dist/pieces/bridges/normalize.js';

/** Provider-shaped events in the disposable household. The daemon only sees disabled fixture connections. */
export async function bridgeMail({app,clock}) {
 const db=app.services.comms.db, agent='fern', member='alex', ch='example-intake-channel', user='fictional-gardener';
 const now=()=>new Date(clock.now()).toISOString();
 const ingress=new BridgeIncoming(db,now);
 const sent=app.writes.run(()=>{
  const tokenSecret='walkthrough-intake-placeholder';
  db.insert(secrets).values({name:tokenSecret,description:'Fixture metadata',changedAt:now(),changedBy:member}).run();
  return ['discord','slack'].map(platform=>{
   const connection={id:'walkthrough-intake-'+platform,workspace:'walkthrough-space-'+platform}, words='Walkthrough intake from '+platform;
   db.insert(bridgeConnections).values({...connection,platform,agent,botUser:'fictional-bot',tokenSecret,enabled:true,state:'connected',stateAt:now()}).run();
   db.insert(bridgePeople).values({platform,workspace:connection.workspace,user,member}).run();
   db.insert(bridgeChannels).values({platform,workspace:connection.workspace,channel:ch,answers:agent,botsMayTalk:false}).run();
   const message=platform==='discord'
    ? normalizeDiscord(connection,{op:0,t:'MESSAGE_CREATE',d:{type:0,id:'fictional-discord-message',channel_id:ch,
      guild_id:connection.workspace,author:{id:user},content:words,timestamp:now(),mentions:[]}}, {id:ch,guild:connection.workspace,kind:'channel'})
    : normalizeSlack(connection,{type:'event_callback',team_id:connection.workspace,event:{type:'message',user,channel:ch,channel_type:'channel',ts:Math.floor(clock.now()/1000)+'.000001',text:words}});
   assert.ok(message);
   const delivered=ingress.receive(message);
   assert.equal(delivered.state,'delivered');
   assert.equal(ingress.receive(message).id,delivered.id);
   db.update(bridgeConnections).set({enabled:false}).where(eq(bridgeConnections.id,connection.id)).run();
   return {source:platform,words,conversation:delivered.conversation};
  });
 }).value;
 const credential=app.services.signin.issue({kind:'agent',agent,label:'Fictional bridge Inbox reader'});
 try {
  const response=await fetch(new URL('/graphql',app.url),{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},
   body:JSON.stringify({query:'{inboxItems(folder:"all",search:"Walkthrough intake from",limit:20){toKind to source fromKind fromId conversation body{words}}}'})});
  assert.equal(response.status,200);
  const reply=await response.json();
  assert.equal(reply.errors,undefined);
  const rows=reply.data.inboxItems;
  assert.equal(rows.length,2);
  for(const {source,words,conversation} of sent) {
   assert.ok(conversation);
   assert.deepEqual(rows.find(row=>row.source===source),{toKind:'agent',to:agent,source,fromKind:'person',fromId:member,conversation,body:{words}});
  }
  assert.notEqual(sent[0].conversation,sent[1].conversation);
  return {ok:true,reason:'The receiving agent read one Discord and one Slack Inbox item through GraphQL. Each retained its source, linked sender, text and delivered conversation after a repeated provider event.'};
 } finally {app.services.signin.revoke(credential.fingerprint);}
}
