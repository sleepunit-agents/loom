import {bridgeConnections} from '../core/data/schema.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {MESSAGE_WORDS_MAX} from '../core/conversations/words.js';
import type {BodyProgramToolResult} from './body-program-tools.js';
import {denialCoversTool} from './tool-denial.js';

export const directAddress=z.object({id:z.uuid(),person:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),via:z.enum(bridgeConnections.platform.enumValues)}).strict();
const address={conversation:z.string().min(1).max(200),...directAddress.partial({person:true,via:true}).shape};
const request=z.discriminatedUnion('operation',[
  z.object({...address,operation:z.literal('send'),text:z.string().min(1).max(MESSAGE_WORDS_MAX)}).strict(),
  z.object({...address,operation:z.literal('status')}).strict(),
]);
export function mayUseHouseSend(denied:readonly string[]):boolean{
  return !denied.some(rule=>['mcp__loom__','mcp__loom_secrets__'].some(prefix=>
    ['loom_command','runtime_send'].some(tool=>denialCoversTool(rule,prefix+tool))));
}
type SendPort={
  conversation:string;venue:string;denied:readonly string[];
  attempted?(id:string,text:string):()=>void;
  allowsCall(input:unknown):boolean;
  call(name:string,args:unknown,signal:AbortSignal):Promise<BodyProgramToolResult>;
};
export async function houseSendRequest(port:SendPort,input:unknown,signal:AbortSignal){
  const intent=request.parse(input);
  if(intent.conversation!==port.conversation||signal.aborted||!mayUseHouseSend(port.denied)||!port.allowsCall(intent))
    throw Error('House send unavailable');
  const call=async(operation:string,body:unknown,id:string,refused?:()=>void)=>{
    const reply=await port.call('loom_command',{operation,input:body,id},signal);
    if(reply.isError&&reply.content.length===1){
      // A structured rejection proves the write was refused. A lost response leaves the attempt available for final reconciliation.
      let error:unknown;
      try{error=JSON.parse(reply.content[0].text);}catch{}
      if(z.object({ok:z.literal(false),code:z.enum(['denied','invalid','not-found','conflict'])}).safeParse(error).success)refused?.();
    }
    if(signal.aborted||reply.isError||reply.content.length!==1)throw Error('House send unavailable');
    const result=z.object({ok:z.literal(true),value:z.unknown()}).parse(JSON.parse(reply.content[0].text));
    if(!port.allowsCall(result))throw Error('House send unavailable');
    return result.value;
  };
  if(intent.person!==undefined||intent.via!==undefined){
    if(!intent.person||!intent.via)throw Error('Incomplete direct recipient');
    const target={id:intent.id,person:intent.person,via:intent.via};
    if(intent.operation==='send'){
      const queued=await call('bridges.direct',{...target,text:intent.text},intent.id);
      z.object({saved:z.literal(true)}).parse(queued);
    }
    return call('bridges.directStatus',target,randomUUID());
  }
  if(port.venue==='loom'&&intent.operation==='send'){
    const refused=port.attempted?.(intent.id,intent.text);
    const reply=await call('conversation.message',{kind:'progress',clientId:intent.id,words:intent.text},intent.id,refused);
    const {seq}=z.object({saved:z.literal(true),seq:z.number().int().positive()}).parse(reply);
    return {state:'recorded',seq};
  }
  if(port.venue!=='slack'&&port.venue!=='discord')throw Error('No current bridge');
  if(intent.operation==='send'){
    const refused=port.attempted?.(intent.id,intent.text);
    const queued=await call('bridges.say',{id:intent.id,text:intent.text},intent.id,refused);
    z.object({saved:z.literal(true)}).parse(queued);
  }
  return call('bridges.sendStatus',{id:intent.id},randomUUID());
}
