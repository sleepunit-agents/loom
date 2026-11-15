/** Trusted shared configuration service. External permissions belong at the
 * operation door; installed modules use this service directly. */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeChannelFilters, bridgeChannels, bridgePeople, bridgeSends } from '../../core/data/schema.js';
const text=z.string().trim().min(1).max(200), platform=z.enum(['discord','slack']);
const address={platform,workspace:text};
export const bridgeConfiguration=z.discriminatedUnion('action',[
 z.object({action:z.literal('connection'),id:text,platform,agent:text,workspace:text,botUser:text,tokenSecret:text,appSecret:text.nullable(),enabled:z.boolean(),only:z.array(text).max(200),ignore:z.array(text).max(200)}).strict(),
 z.object({action:z.literal('disconnect'),id:text}).strict(),
 z.object({action:z.literal('channel'),...address,channel:text,answers:text,botsMayTalk:z.boolean()}).strict(),
 z.object({action:z.literal('removeChannel'),...address,channel:text}).strict(),
 z.object({action:z.literal('person'),...address,user:text,member:text}).strict(),
 z.object({action:z.literal('removePerson'),...address,user:text}).strict(),
]);
export const bridgeSetting=z.discriminatedUnion('action',[...bridgeConfiguration.options,
 z.object({action:z.literal('review'),id:text,decision:z.enum(['release','dismiss'])}).strict(),
]);
export class BridgeSettings {
 constructor(private db:DataDatabase,private now:()=>string,private commit:<T>(write:()=>T)=>T){}
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
     const {action:_action,only,ignore,...config}=input;
     const fields={...config,state:'disconnected' as const,stateAt:this.now()};
     // Every edit retires the prior socket/config lifetime before reconnect.
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
     const {action:_action,...row}=input;this.db.insert(bridgeChannels).values(row).onConflictDoUpdate({target:[bridgeChannels.platform,bridgeChannels.workspace,bridgeChannels.channel],set:row}).run();break;
    }
    case 'removeChannel':this.db.delete(bridgeChannels).where(and(eq(bridgeChannels.platform,input.platform),eq(bridgeChannels.workspace,input.workspace),eq(bridgeChannels.channel,input.channel))).run();break;
    case 'person':{
     const {action:_action,...row}=input;this.db.insert(bridgePeople).values(row).onConflictDoUpdate({target:[bridgePeople.platform,bridgePeople.workspace,bridgePeople.user],set:row}).run();break;
    }
    case 'removePerson':this.db.delete(bridgePeople).where(and(eq(bridgePeople.platform,input.platform),eq(bridgePeople.workspace,input.workspace),eq(bridgePeople.user,input.user))).run();break;
    case 'review':{
     const row=this.db.select().from(bridgeSends).where(eq(bridgeSends.id,input.id)).get();
     if(!row)throw Error('Unknown send');
     const state=input.decision==='release'?'pending':'dismissed';

     if(row.state!=='held'&&(input.decision!=='dismiss'||row.state!=='uncertain'))throw Error('Reply is not awaiting this review');
     if(!this.db.update(bridgeSends).set({state}).where(and(eq(bridgeSends.id,input.id),eq(bridgeSends.state,row.state))).run().changes)throw Error('Reply state changed');
    }
   }
  }));
 }
}
