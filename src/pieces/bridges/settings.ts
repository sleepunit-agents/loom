/** Trusted shared configuration service. External permissions belong at the
 * operation door; installed modules use this service directly. */
import { channelTarget } from '../../core/conversations/handoff.js';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeChannelFilters, bridgeChannels, bridgePeople } from '../../core/data/schema.js';
import { reviewReply } from './sends.js';
import { PAGE_NAME } from '../../slug.js';
const text=z.string().trim().min(1).max(200), platform=z.enum(bridgeConnections.platform.enumValues);
const address={platform,workspace:text};
export const bridgeConfiguration=z.discriminatedUnion('action',[
 z.object({action:z.literal('connection'),id:text,platform,agent:text,workspace:text,botUser:text,tokenSecret:text,appSecret:text.nullable(),enabled:z.boolean(),only:z.array(text).max(200),ignore:z.array(text).max(200)}).strict(),
 z.object({action:z.literal('disconnect'),id:text}).strict(),
 // `brief` names a role page of the answering agent (roles/<brief>.md in its Memory), handed to the body of
 // every conversation in the channel beside the venue's own page. Left out or null: the channel has none.
 z.object({action:z.literal('channel'),...address,channel:text,answers:text,botsMayTalk:z.boolean(),brief:z.string().regex(PAGE_NAME).nullable().optional(),
  // Where a body working in this channel for a guest may hand a note: one channel on any of the answering agent's bridges.
  reportsTo:channelTarget.omit({thread:true}).strict().nullable().optional()}).strict(),
 z.object({action:z.literal('removeChannel'),...address,channel:text}).strict(),
 z.object({action:z.literal('person'),...address,user:text,member:text}).strict(),
 z.object({action:z.literal('removePerson'),...address,user:text}).strict(),
]);
/** A person's answer about one held reply. The one shape of it: the door (shared-bridge-commands.ts) takes
 * this and hands it on unchanged, so who may answer and what is changed are decided about the same id.
 * The id is the reply's own, taken as it was sent; unlike the names above it is never trimmed. */
export const bridgeReview=z.object({action:z.literal('review'),id:z.string().min(1).max(200),decision:z.enum(['release','dismiss'])}).strict();
export const bridgeSetting=z.discriminatedUnion('action',[...bridgeConfiguration.options,bridgeReview]);
export class BridgeSettings {
 constructor(private db:DataDatabase,private now:()=>string,private commit:<T>(write:()=>T)=>T){}
 /** What a configuration change would replace, or null when there is nothing there yet. */
 read(value:z.infer<typeof bridgeConfiguration>):Record<string,unknown>|null{
  const sorted=(values:string[])=>[...new Set(values)].sort();
  switch(value.action){
   case 'connection':case 'disconnect':{
    const row=this.db.select().from(bridgeConnections).where(eq(bridgeConnections.id,value.id)).get();if(!row)return null;
    const {state:_state,stateAt:_at,...config}=row,filters=this.db.select().from(bridgeChannelFilters).where(eq(bridgeChannelFilters.connection,value.id)).all();
    return {...config,only:sorted(filters.filter(row=>row.rule==='only').map(row=>row.channel)),ignore:sorted(filters.filter(row=>row.rule==='ignore').map(row=>row.channel))};
   }
   case 'channel':case 'removeChannel':return this.db.select().from(bridgeChannels).where(and(eq(bridgeChannels.platform,value.platform),eq(bridgeChannels.workspace,value.workspace),eq(bridgeChannels.channel,value.channel))).get()??null;
   case 'person':case 'removePerson':return this.db.select().from(bridgePeople).where(and(eq(bridgePeople.platform,value.platform),eq(bridgePeople.workspace,value.workspace),eq(bridgePeople.user,value.user))).get()??null;
  }
 }
 change(raw:z.input<typeof bridgeSetting>){
  const input=bridgeSetting.parse(raw);
  return this.commit(()=>this.db.transaction(()=>{
   switch(input.action){
    case 'connection':{
     if(input.platform==='slack'&&!input.appSecret)throw Error('Slack app secret required');
     if(input.platform==='discord'&&input.appSecret)throw Error('Discord app secret unsupported');
     const existing=this.db.select().from(bridgeConnections).where(eq(bridgeConnections.id,input.id)).get();
     // Retained frames and history belong to one bot/workspace/agent identity.
     // Credential names, filters and enablement may change; a new identity needs
     // a new connection rather than reinterpretation of old private receipts.
     if(existing&&(['platform','workspace','botUser','agent'] as const).some(key=>existing[key]!==input[key]))throw Error('Connection identity is fixed');
     // A removed connection is out of use until it is restored (apps/household.ts, setRemoved). Intake
     // counts it as nobody's and holds what it hears, so it is not given a socket either.
     if(existing?.removedAt&&input.enabled)throw Error('Connection is removed; restore it before enabling it');
     // A Discord bot's session hears every guild the bot is in and every direct message to it. Enabled
     // connections for one bot in two guilds would each receive, and deliver, the same direct messages
     // (docs/accepted-tradeoffs.md, "A Discord bot is connected in one guild at a time").
     if(input.platform==='discord'&&input.enabled&&this.db.select({id:bridgeConnections.id}).from(bridgeConnections).where(and(eq(bridgeConnections.platform,'discord'),eq(bridgeConnections.botUser,input.botUser),
      eq(bridgeConnections.enabled,true),ne(bridgeConnections.workspace,input.workspace),ne(bridgeConnections.id,input.id))).get())throw Error('This bot already has an enabled connection in another guild');
     const {action:_action,only,ignore,...config}=input;
     const sameSocket=existing&&existing.enabled===config.enabled&&existing.tokenSecret===config.tokenSecret&&existing.appSecret===config.appSecret;
     // Filters are read live by the receiver; they do not retire this socket.
     const fields={...config,state:sameSocket?existing.state:'disconnected' as const,stateAt:sameSocket?existing.stateAt:this.now()};
     this.db.insert(bridgeConnections).values(fields).onConflictDoUpdate({target:bridgeConnections.id,set:fields}).run();
     this.db.delete(bridgeChannelFilters).where(eq(bridgeChannelFilters.connection,input.id)).run();
     for(const [rule,channels] of [['only',only],['ignore',ignore]] as const){
      for(const channel of new Set(channels))this.db.insert(bridgeChannelFilters).values({connection:input.id,channel,rule}).run();
     }
     break;
    }
    case 'disconnect':{
     if(!this.db.update(bridgeConnections).set({enabled:false,state:'disconnected',stateAt:this.now()}).where(eq(bridgeConnections.id,input.id)).run().changes)throw Error('Unknown connection');break;
    }
    case 'channel':{
     const {action:_action,brief,reportsTo,...rest}=input,row={...rest,brief:brief??null,reportsTo:reportsTo?JSON.stringify([reportsTo.platform,reportsTo.workspace,reportsTo.channel]):null};this.db.insert(bridgeChannels).values(row).onConflictDoUpdate({target:[bridgeChannels.platform,bridgeChannels.workspace,bridgeChannels.channel],set:row}).run();break;
    }
    case 'removeChannel':this.db.delete(bridgeChannels).where(and(eq(bridgeChannels.platform,input.platform),eq(bridgeChannels.workspace,input.workspace),eq(bridgeChannels.channel,input.channel))).run();break;
    case 'person':{
     const {action:_action,...row}=input;this.db.insert(bridgePeople).values(row).onConflictDoUpdate({target:[bridgePeople.platform,bridgePeople.workspace,bridgePeople.user],set:row}).run();break;
    }
    case 'removePerson':this.db.delete(bridgePeople).where(and(eq(bridgePeople.platform,input.platform),eq(bridgePeople.workspace,input.workspace),eq(bridgePeople.user,input.user))).run();break;
    case 'review':reviewReply(this.db,input.id,input.decision);
   }
  }));
 }
}
