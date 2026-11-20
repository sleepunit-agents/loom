import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {MESSAGE_WORDS_MAX} from '../core/conversations/words.js';
import type {BodyProgramToolResult} from './body-program-tools.js';
import {denialCoversTool} from './tool-denial.js';

const address={conversation:z.string().min(1).max(200),id:z.uuid()};
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
  accepted?(id:string,text:string):void;
  allowsCall(input:unknown):boolean;
  call(name:string,args:unknown,signal:AbortSignal):Promise<BodyProgramToolResult>;
};
export async function houseSendRequest(port:SendPort,input:unknown,signal:AbortSignal){
  const intent=request.parse(input);
  if(intent.conversation!==port.conversation||signal.aborted||!mayUseHouseSend(port.denied)||!port.allowsCall(intent))
    throw Error('House send unavailable');
  const call=async(operation:string,body:unknown,id:string)=>{
    const reply=await port.call('loom_command',{operation,input:body,id},signal);
    if(signal.aborted||reply.isError||reply.content.length!==1)throw Error('House send unavailable');
    const result=z.object({ok:z.literal(true),value:z.unknown()}).parse(JSON.parse(reply.content[0].text));
    if(!port.allowsCall(result))throw Error('House send unavailable');
    return result.value;
  };
  if(port.venue==='loom'&&intent.operation==='send'){
    const reply=await call('conversation.message',{kind:'progress',clientId:intent.id,words:intent.text},intent.id);
    const {seq}=z.object({saved:z.literal(true),seq:z.number().int().positive()}).parse(reply);
    port.accepted?.(intent.id,intent.text);
    return {state:'recorded',seq};
  }
  if(port.venue!=='slack'&&port.venue!=='discord')throw Error('No current bridge');
  if(intent.operation==='send'){
    const queued=await call('bridges.say',{id:intent.id,text:intent.text},intent.id);
    z.object({saved:z.literal(true)}).parse(queued);
    port.accepted?.(intent.id,intent.text);
  }
  return call('bridges.sendStatus',{id:intent.id},randomUUID());
}
