import { randomUUID } from 'node:crypto';
import { SHA256_HEX_WITHIN } from './core/sha256-hex.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { ServeIo } from './index.js';

const usage = 'Usage: loom note read <path> [--json]\n       loom note pin|unpin|delete <path> [--id receipt] [--json]\n       loom note list [prefix] [--limit 1..500] [--json]\n       loom note write <path> [--lifespan keep|while|short] [--body text] [--id receipt] [--json]\n';
const row = z.object({ path:z.string(), lifespan:z.string(), updated:z.string(), pinned:z.boolean(), files:z.number() }).passthrough();

async function stdinBody() {
  if(process.stdin.isTTY) throw Error('Supply --body or pipe note text on stdin');
  const chunks:Buffer[]=[];
  let size=0;
  for await(const chunk of process.stdin){
    const bytes=Buffer.from(chunk);
    size+=bytes.length;
    if(size>1024*1024)throw Error('Note text exceeds 1 MiB');
    chunks.push(bytes);
  }
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}

export async function houseNoteCli(args:string[],io:ServeIo,env=process.env):Promise<number>{
  if(args[0]==='--help'||args[0]==='-h'){io.stdout(usage);return 0;}
  const [operation,...rest]=args;
  const manage=['pin','unpin','delete'].includes(operation);
  const mutates=manage||operation==='write';
  if(!['list','read'].includes(operation)&&!mutates){io.stderr(usage);return 2;}
  let input:Record<string,unknown>, generatedReceipt:string|undefined, json=false;
  try{
    // parseArgs regards a dash-prefixed string after an option as ambiguous.
    // A note's body is literal text, including option-looking words.
    const options:string[]=[];
    for(let i=0;i<rest.length;i++){
      if(operation==='write'&&rest[i]==='--body'&&i+1<rest.length)options.push('--body='+rest[++i]);
      else options.push(rest[i]);
    }
    const {positionals,values}=parseArgs({args:options,allowPositionals:true,options:{
      help:{type:'boolean',short:'h'},
      json:{type:'boolean'},
      ...(operation==='list'?{limit:{type:'string' as const}}:{}),
      ...(operation==='write'?{body:{type:'string' as const},lifespan:{type:'string' as const},}:{}),
      ...(mutates?{id:{type:'string' as const}}:{}),
    }});
    if(values.help){io.stdout(usage);return 0;}
    const [path]=positionals;
    if(positionals.length>1||(operation!=='list'&&!path))throw Error('Expected one note path');
    json=!!values.json;
    if(mutates&&values.id===undefined)generatedReceipt=randomUUID();
    if(manage)input={operation,path,id:values.id??generatedReceipt};
    else if(operation==='list'){
      const limit=values.limit===undefined?100:Number(values.limit);
      if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('--limit must be 1 to 500');
      input={operation,prefix:path,limit};
    }else if(operation==='read')input={operation,path};
    else {
      if(values.lifespan&&!['short','while','keep'].includes(String(values.lifespan)))throw Error('Unknown lifespan');
      input={operation,path,lifespan:values.lifespan,id:values.id??generatedReceipt,body:values.body??await stdinBody()};
    }
  }catch{io.stderr('Invalid note arguments or input.\n'+usage);return 2;}
  const cap=new RegExp('^([1-9][0-9]{0,4})\\.('+SHA256_HEX_WITHIN+')$').exec(env.LOOM_BODY_HOUSE_NOTE??'');
  if(!cap||Number(cap[1])>65535){io.stderr('Loom note needs an active worker job with shell access.\n');return 1;}
  if(generatedReceipt)io.stderr('Write receipt --id '+generatedReceipt+'\n');
  try{
    const reply=await fetch('http://127.0.0.1:'+cap[1]+'/house/note',{method:'POST',redirect:'error',
      headers:{authorization:'Bearer '+cap[2],'content-type':'application/json'},body:JSON.stringify(input)});
    if(!reply.ok)throw Error();
    const value=await reply.json();
    if(manage){
      const result=operation==='delete'
        ? z.object({deleted:z.boolean()}).parse(value.value)
        : z.union([z.object({path:z.string(),pinned:z.boolean(),expires:z.string().nullable()}),z.object({missing:z.literal(true)})]).parse(value.value);
      if(value.ok!==true)throw Error();
      const missing='missing' in result||('deleted' in result&&!result.deleted);
      io.stdout(json?JSON.stringify({...result,...(generatedReceipt?{id:generatedReceipt}:{})})+'\n':
        (missing?'No note '+input.path:'path' in result?result.path+(result.pinned?' pinned':' unpinned'):'Deleted '+input.path)+'\n');
      if(missing)return 3;
    }else if(operation==='write'){
      z.object({ok:z.literal(true),value:z.object({saved:z.literal(true)})}).parse(value);
      io.stdout(json?JSON.stringify({...value.value,...(generatedReceipt?{id:generatedReceipt}:{})})+'\n':'Saved '+input.path+'\n');
    }else if(operation==='read'){
      if(value.errors||!value.data||!Object.hasOwn(value.data,'memoryNote'))throw Error();
      if(value.data.memoryNote===null){io.stderr('No note '+input.path+'\n');return 3;}
      const note=row.extend({body:z.string()}).parse(value.data.memoryNote);
      io.stdout(json?JSON.stringify(note)+'\n':note.body+(note.body.endsWith('\n')?'':'\n'));
    }else{
      if(value.errors)throw Error();
      const rows=row.array().parse(value.data?.memoryNotes);
      io.stdout(json?JSON.stringify(rows)+'\n':rows.map(n=>n.updated.slice(0,10)+'  '+n.lifespan.padEnd(5)+(n.pinned?' pinned':'')+'  '+n.path+(n.files?'  ('+n.files+' file'+(n.files===1?'':'s')+')':'')+'\n').join(''));
    }
    return 0;
  }catch{
    io.stderr('Loom note request failed.'+(mutates?' Check the note before retrying. '+(generatedReceipt?'Reuse --id '+generatedReceipt:'Reuse the supplied --id')+' for the same '+operation+'.':'')+'\n');
    return 1;
  }
}
