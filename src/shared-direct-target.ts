import {and,eq,isNull} from 'drizzle-orm';
import type {BridgeSend} from './pieces/bridges/sends.js';
import type {Viewer} from './policy.js';
import {inHousehold,mayRunPrivateWork} from './policy.js';
import {machineCurrent} from './core/data/authentication.js';
import {assignedConversation} from './core/conversations/body-scope.js';
import type {DataDatabase} from './core/data/database.js';
import {agentPeople,bridgeIncoming,bridgeConnections,bridgePeople,members,type DirectSendTarget} from './core/data/schema.js';
import {outsidePersonKey} from './pieces/bridges/keys.js';
import {conversationPlace} from './pieces/bridges/place.js';
import {deniedTools} from './runtime/harness-traits.js';
import {mayUseHouseSend} from './runtime/house-send-request.js';
import {kitRoom,placeAddress,placeClosed,privateRefusal,wordReach} from './shared-place-mail.js';
import {sharedSharing} from './shared-sharing.js';

type Platform=DirectSendTarget['platform'];
type DirectoryAccount=(viewer:Viewer,person:string,platform:Platform)=>{workspace:string;user:string}|undefined;
export function directTargets(db:DataDatabase,directory:DirectoryAccount){
 function sendScope(jobId:string,origin:string){
  const sharing=sharedSharing(db);
  const work=assignedConversation(db,jobId,scope=>mayRunPrivateWork(scope,sharing));
  if(!work||work.cv.id!==origin||!work.job.box||!machineCurrent(db,work.job.box)||!sharing.agents?.includes(work.job.agent))return;
  const {job,cv}=work;
  const {room,word}=kitRoom(db,job);
  if(!mayUseHouseSend(deniedTools(room)))return;
  return {job,cv,word,sharing};
 }
 function progressAllowed(jobId:string,send:BridgeSend,files:boolean){
  const incoming=send.incoming?db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id,send.incoming)).get():undefined;
  const origin=incoming?.conversation??send.conversation;
  if(!origin||send.incoming&&(!incoming||incoming.state!=='delivered'))return false;
  const scope=sendScope(jobId,origin);
  if(!scope||files&&scope.word.woke==='others'||placeClosed(db,scope.cv))return false;
  const address=incoming??placeAddress(db,scope.cv);
  return !!address&&address.connection===send.connection&&address.channel===send.channel&&address.thread===send.thread;
 }
 function resolve(jobId:string,origin:string,person:string,platform:Platform){
  const scope=sendScope(jobId,origin);
  if(!scope||scope.word.woke==='others')return;
  const {job,word,sharing}=scope;
  const member=db.select({id:members.id}).from(members).where(eq(members.id,person)).get();
  let user:string,workspace:string;
  if(member){
   if(!inHousehold({kind:'member',id:person},sharing)||(word.woke!=='own'&&!word.person)||privateRefusal(person,word.person)||wordReach(db,job.agent,{kind:'member',id:person})!=='owners')return;
   const links=db.select({workspace:bridgePeople.workspace,user:bridgePeople.user}).from(bridgePeople)
    .innerJoin(bridgeConnections,and(eq(bridgeConnections.platform,bridgePeople.platform),eq(bridgeConnections.workspace,bridgePeople.workspace),
      eq(bridgeConnections.agent,job.agent),eq(bridgeConnections.enabled,true),isNull(bridgeConnections.removedAt)))
    .where(and(eq(bridgePeople.member,person),eq(bridgePeople.platform,platform))).limit(2).all();
   if(links.length!==1)return;
   ({workspace,user}=links[0]);
  }else{
   const account=directory({kind:'agent',id:job.agent,...(job.member?{workingFor:job.member}:{})},person,platform);
   if(!account)return;
   ({workspace,user}=account);
   if(db.select({id:bridgePeople.member}).from(bridgePeople).where(and(eq(bridgePeople.platform,platform),
     eq(bridgePeople.workspace,workspace),eq(bridgePeople.user,user))).get())return;
   const tier=db.select({tier:agentPeople.tier}).from(agentPeople).where(and(eq(agentPeople.agent,job.agent),
    eq(agentPeople.person,outsidePersonKey(platform,workspace,user)))).get()?.tier;
   if(!tier||tier<2)return;
  }
  const connection=db.select({id:bridgeConnections.id,bot:bridgeConnections.botUser}).from(bridgeConnections).where(and(
   eq(bridgeConnections.agent,job.agent),eq(bridgeConnections.platform,platform),eq(bridgeConnections.workspace,workspace),
   isNull(bridgeConnections.removedAt),eq(bridgeConnections.enabled,true))).get();
  if(!connection||connection.bot===user)return;
  const target:DirectSendTarget={origin,person,platform,workspace,user,member:member?.id??null};
  return {agent:job.agent,target,connection:connection.id};
 }
 function allowed(job:string,target:DirectSendTarget,connection:string,channel:string){
  const found=resolve(job,target.origin,target.person,target.platform);
  if(!found||found.connection!==connection||found.target.workspace!==target.workspace||found.target.user!==target.user||
   found.target.member!==target.member)return false;
  const place=conversationPlace(target.workspace,{channel,isDm:true},target.member);
  return !placeClosed(db,{id:'',agent:found.agent,venue:target.platform,place});
 }
 return {resolve,allowed,progressAllowed};
}
