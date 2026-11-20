import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {MESSAGE_WORDS_MAX} from './core/conversations/words.js';
import {SHA256_HEX_WITHIN} from './core/sha256-hex.js';
import type {ServeIo} from './index.js';

const usage='Usage: loom runtime send --conversation <id> --text <text|-> [--person <id> --via discord|slack] [--id <uuid>]\n';
const receipt=z.discriminatedUnion('state',[
  z.object({state:z.literal('recorded'),seq:z.number().int().positive()}).strict(),
  z.object({state:z.enum(['pending','held','sending','sent','uncertain','dismissed']),postedIds:z.array(z.string().min(1))}).strict(),
]);
const handle=new RegExp('^([1-9][0-9]{0,4})\\.('+SHA256_HEX_WITHIN+')$');

async function pipedText():Promise<string>{
  if(process.stdin.isTTY)throw Error('Expected a pipe');
  const chunks:Buffer[]=[];
  let size=0;
  for await(const value of process.stdin){
    const chunk=Buffer.from(value);
    size+=chunk.length;
    if(size>MESSAGE_WORDS_MAX*4)throw Error('Text too long');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}

export async function houseRuntimeCli(args:string[],io:ServeIo,env=process.env):Promise<number>{
  if(args[0]==='--help'||args[0]==='-h'){io.stdout(usage);return 0;}
  if(args[0]!=='send'){io.stderr(usage);return 2;}
  let text:string,conversation:string,ref:string,person:string|undefined,via:string|undefined;
  try{
    const argv=[];
    for(let i=1;i<args.length;i++){
      if(args[i]==='--text'&&i+1<args.length)argv.push('--text='+args[++i]);
      else argv.push(args[i]);
    }
    const {values}=parseArgs({args:argv,options:{help:{type:'boolean',short:'h'},conversation:{type:'string'},text:{type:'string'},
      person:{type:'string'},via:{type:'string'},id:{type:'string'}}});
    if(values.help){io.stdout(usage);return 0;}
    conversation=z.string().min(1).max(200).parse(values.conversation);
    ref=z.uuid().parse(values.id??randomUUID());
    person=z.string().min(1).max(200).optional().parse(values.person);
    via=z.enum(['discord','slack']).optional().parse(values.via);
    if((person===undefined)!==(via===undefined))throw Error('Target incomplete');
    text=z.string().min(1).max(MESSAGE_WORDS_MAX).parse(values.text==='-'?await pipedText():values.text);
  }catch{io.stderr(usage);return 2;}
  const cap=handle.exec(env.LOOM_BODY_HOUSE_SEND??'');
  if(!cap||Number(cap[1])>65535){io.stderr('Loom runtime send needs an active worker job with shell access.\n');return 1;}
  io.stderr('Send receipt --id '+ref+'\n');
  const signal=AbortSignal.timeout(45_000);
  const post=async(input:unknown)=>{
    const reply=await fetch('http://127.0.0.1:'+cap[1]+'/house/send',{method:'POST',redirect:'error',signal,
      headers:{authorization:'Bearer '+cap[2],'content-type':'application/json'},body:JSON.stringify(input)});
    if(!reply.ok)throw Error('Receipt unavailable');
    return receipt.parse(await reply.json());
  };
  const print=(value:unknown)=>io.stdout(JSON.stringify(value)+'\n');
  let postedIds:string[]=[];
  try{
    let result=await post({operation:'send',conversation,text,id:ref,person,via});
    for(;;){
      if(result.state==='recorded'){print({ok:true,recorded:true,ref,seq:result.seq});return 0;}
      postedIds=result.postedIds;
      if(result.state==='sent'&&postedIds.length){
        print({ok:true,posted:true,ref,id:postedIds[postedIds.length-1],postedIds});return 0;
      }
      if(result.state!=='pending'&&result.state!=='sending'){
        print({ok:false,ref,state:result.state,postedIds,unconfirmed:true});return 1;
      }
      await delay(1000,undefined,{signal});
      result=await post({operation:'status',conversation,id:ref,person,via});
    }
  }catch{
    print({ok:false,ref,postedIds,unconfirmed:true,reason:'Delivery could not be confirmed. Reuse the same receipt for this message.'});
    return 1;
  }
}
