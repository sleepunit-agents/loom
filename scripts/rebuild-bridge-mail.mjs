import assert from 'node:assert/strict';
import {and,eq} from 'drizzle-orm';
import {bridgeChannelFilters,bridgeChannels,bridgeConnections,bridgeIncoming,bridgePeople,conversations,inbox,secrets} from '../dist/core/data/schema.js';
import {BridgeIncoming} from '../dist/pieces/bridges/incoming.js';
import {normalizeDiscord,normalizeSlack} from '../dist/pieces/bridges/normalize.js';

/** Exercise both room filters and the default speaker using the same normalized
 * provider event that the selected connection will subsequently deliver. */
function checkRoomRouting(db, ingress, connection, platform, message, tokenSecret, now, agent) {
 const peer = {...connection,id:connection.id+'-peer',agent:'moss',botUser:'fictional-peer',tokenSecret,
   platform,enabled:true,state:'connected',stateAt:now()};
 db.insert(bridgeConnections).values(peer).run();
 const denied = ingress.receive({...message,connection:peer.id});
 assert.equal(denied.state,'dropped');
 assert.equal(denied.reason,'Another agent or no channel answer');
 const channel = and(eq(bridgeChannels.platform,platform),eq(bridgeChannels.workspace,connection.workspace),eq(bridgeChannels.channel,message.channel));
 db.update(bridgeChannels).set({answers:peer.agent}).where(channel).run();
 const redirected = {...message,id:message.id+'-rerouted',text:'Rerouted walkthrough message'};
 assert.equal(ingress.receive(redirected).state,'dropped');
 const received=ingress.receive({...redirected,connection:peer.id});
 assert.equal(received.state,'delivered');
 const recipients=db.select({agent:inbox.to}).from(inbox).where(eq(inbox.conversation,received.conversation)).all();
 assert.deepEqual(recipients,[{agent:peer.agent}]);
 db.update(bridgeChannels).set({answers:agent}).where(channel).run();
 db.update(bridgeConnections).set({enabled:false}).where(eq(bridgeConnections.id,peer.id)).run();

 const filter = {connection:connection.id,channel:message.channel,rule:'only'};
 db.insert(bridgeChannelFilters).values(filter).run();
 const outside = ingress.receive({...message,channel:message.channel+'-outside',id:message.id+'-outside'});
 assert.equal(outside.state,'dropped');
 assert.equal(outside.reason,'Channel filtered');
 db.insert(bridgeChannelFilters).values({...filter,rule:'ignore'}).run();
 const ignored = ingress.receive({...message,id:message.id+'-ignored'});
 assert.equal(ignored.state,'dropped');
 assert.equal(ignored.reason,'Channel filtered');
 db.delete(bridgeChannelFilters).where(and(eq(bridgeChannelFilters.connection,connection.id),eq(bridgeChannelFilters.rule,'ignore'))).run();
 for (const row of [denied,outside,ignored]) {
   const saved=db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id,row.id)).get();
   assert.equal(saved.state,'dropped');
   assert.equal(saved.conversation,null);
 }
}

/** Provider-shaped events in the disposable household. The daemon only sees disabled fixture connections. */
export async function bridgeMail({app,clock}) {
 const db=app.services.comms.db, agent='fern', ch='example-intake-channel', user='fictional-gardener';
 const now=()=>new Date(clock.now()).toISOString();
 const ingress=new BridgeIncoming(db,now);
 const sent=app.writes.run(()=>{
  const tokenSecret='walkthrough-intake-placeholder';
  db.insert(secrets).values({name:tokenSecret,description:'Fixture metadata',changedAt:now(),changedBy:'alex'}).run();
  return ['discord','slack'].map(platform=>{
   // The same external user string must resolve through its own platform and workspace.
   const member=platform==='discord'?'alex':'robin';
   const connection={id:'walkthrough-intake-'+platform,workspace:'walkthrough-space-'+platform}, words='Walkthrough intake from '+platform;
   db.insert(bridgeConnections).values({...connection,platform,agent,botUser:'fictional-bot',tokenSecret,enabled:true,state:'connected',stateAt:now()}).run();
   db.insert(bridgePeople).values({platform,workspace:connection.workspace,user,member}).run();
   db.insert(bridgeChannels).values({platform,workspace:connection.workspace,channel:ch,answers:agent,botsMayTalk:false}).run();
   const message=platform==='discord'
    ? normalizeDiscord(connection,{op:0,t:'MESSAGE_CREATE',d:{type:0,id:'fictional-discord-message',channel_id:ch,
      guild_id:connection.workspace,author:{id:user},content:words,timestamp:now(),mentions:[]}}, {id:ch,guild:connection.workspace,kind:'channel'})
    : normalizeSlack(connection,{type:'event_callback',team_id:connection.workspace,event:{type:'message',user,channel:ch,channel_type:'channel',ts:Math.floor(clock.now()/1000)+'.000001',text:words}});
   assert.ok(message);
   checkRoomRouting(db,ingress,connection,platform,message,tokenSecret,now,agent);
   const delivered=ingress.receive(message);
   assert.equal(delivered.state,'delivered');
   assert.equal(delivered.member,member);
   assert.equal(delivered.channel,ch);
   assert.equal(ingress.receive(message).id,delivered.id);
   db.update(bridgeConnections).set({enabled:false}).where(eq(bridgeConnections.id,connection.id)).run();
   const held=ingress.receive({...message,id:message.id+'-offline'});
   assert.equal(held.state,'held');
   assert.equal(held.reason,'Connection disabled');
   assert.equal(held.conversation,null);
   const room=db.select().from(conversations).where(eq(conversations.id,delivered.conversation)).get();
   assert.equal(room.agent,agent);
   assert.equal(room.venue,platform);
   assert.equal(db.select().from(inbox).where(eq(inbox.conversation,room.id)).all().length,1);
   return {source:platform,member,words,conversation:delivered.conversation};
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
  for(const {source,member,words,conversation} of sent) {
   assert.ok(conversation);
   assert.deepEqual(rows.find(row=>row.source===source),{toKind:'agent',to:agent,source,fromKind:'person',fromId:member,conversation,body:{words}});
  }
  assert.notEqual(sent[0].conversation,sent[1].conversation);
  return {ok:true,reason:'The receiving agent read one Discord and one Slack Inbox item through GraphQL. The same outside ID resolved to Alex on Discord and Robin on Slack through their respective person links. Only the designated agent received the room message, once across replay. A second bot and room filters dropped other deliveries with reasons. A disabled connection held its message.'};
 } finally {app.services.signin.revoke(credential.fingerprint);}
}
