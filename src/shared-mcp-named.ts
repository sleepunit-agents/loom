/** The names a terminal session already calls (remember, recall, note_read, ...),
 * each a thin mapping onto one registered command or one query on the same door.
 * No tool here reads a store directly: what works here works in the data layer. */
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {McpServer} from '@modelcontextprotocol/server';

type Variables=Record<string,string|number|null>;
type QueryReply={data?:Record<string,unknown>|null;errors?:readonly unknown[]|null};
export interface NamedToolPorts{
 /** The authenticated agent, or undefined for a caller that is not one. */
 agent?:string;
 valid():boolean;
 query(input:{query:string;variables?:Variables}):Promise<QueryReply>;
 command(name:string,input:unknown,id:string):Promise<unknown>;
}
type Result={content:{type:'text';text:string}[];isError?:boolean};
const say=(text:string):Result=>({content:[{type:'text',text}]});
const refuse=(text:string):Result=>({isError:true,content:[{type:'text',text}]});

const category=z.enum(['user','project','self','feedback','reference','pursuit','episode']);
const memoryId=z.string().regex(/^[^:]+:[a-f0-9-]{36}$/);
const notePath=z.string().min(1).max(300);

interface Memory{id:string;title:string;content:string;category:string;updated:string}
interface NoteSummary{path:string;lifespan:string;updated:string;by:string;bytes:number;files:number;expires:string|null}
interface Note{path:string;body:string;lifespan:string;created:string;updated:string;by:string}
interface Page{slug:string;title:string;domain:string;updated:string;verified_at:string|null;body:string}
interface Entry{id:string;at:string;title:string;line:string|null;where:string;what:string}

export function registerNamedTools(server:McpServer,ports:NamedToolPorts){
 /** A command's value, or a thrown refusal carrying the door's own words. */
 const run=async(name:string,input:unknown)=>{
  const reply=await ports.command(name,input,randomUUID()) as {ok?:boolean;value?:unknown;error?:{code?:string;message?:string}};
  if(reply?.ok!==true)throw new Refusal(reply?.error?.message??reply?.error?.code??'The command was refused');
  return reply.value;
 };
 const read=async<T>(query:string,variables:Variables={})=>{
  const reply=await ports.query({query,variables});
  if(reply.errors?.length||!reply.data)throw new Refusal('The read was refused');
  return reply.data as T;
 };
 const tool=<S extends z.ZodObject>(name:string,description:string,inputSchema:S,handle:(input:z.infer<S>,agent:string)=>Promise<string>)=>
  server.registerTool(name,{description,inputSchema:inputSchema as z.ZodObject},async(args:Record<string,unknown>)=>{
   if(!ports.valid())return refuse('Authentication ended');
   if(!ports.agent)return refuse('This tool needs an agent credential');
   try{return say(await handle(inputSchema.parse(args),ports.agent));}
   catch(error){
    if(error instanceof Refusal)return refuse(error.message);
    if(error instanceof z.ZodError)return refuse('Invalid input: '+error.issues.map(issue=>issue.path.join('.')+' '+issue.message).join('; '));
    return refuse('Tool unavailable; outcome may be uncertain');
   }
  });

 tool('remember','Save a memory in your own store.',
  z.object({category,title:z.string().max(200),content:z.string().max(65536),project:z.string().min(1).max(200).optional(),ttl:z.string().max(50).optional(),metadata:z.record(z.string(),z.unknown()).optional()}).strict(),
  async input=>{const value=await run('memory.remember',input) as {ids:string[]};return 'Remembered "'+input.title+'" ('+value.ids.join(', ')+')';});

 tool('recall','Search your memories by meaning. Returns titles and content.',
  z.object({query:z.string().min(1).max(4000),category:category.optional(),project:z.string().min(1).max(200).optional(),limit:z.number().int().min(1).max(50).optional()}).strict(),
  async input=>{
   const found=await run('memory.recall',input) as {ids:string[];matches?:{id:string;score:number}[]};
   if(!found.ids.length)return 'No memories matched.';
   // One read for every match: aliased fields, ids passed as variables.
   const names=found.ids.map((_id,index)=>'m'+index);
   const data=await read<Record<string,Memory|null>>(
    'query('+names.map(name=>'$'+name+':String!').join(',')+'){'+names.map(name=>name+':memoryProjectMemory(id:$'+name+'){id title content category updated}').join(' ')+'}',
    Object.fromEntries(found.ids.map((id,index)=>['m'+index,id])));
   const score=new Map((found.matches??[]).map(match=>[match.id,match.score]));
   return names.map(name=>data[name]).filter((memory):memory is Memory=>!!memory)
    .map(memory=>'## '+memory.title+'\n_'+memory.category+' · '+memory.id+' · updated '+memory.updated+(score.has(memory.id)?' · score '+score.get(memory.id)!.toFixed(3):'')+'_\n\n'+memory.content).join('\n\n---\n\n');
  });

 tool('update','Edit one of your memories by its id. A changed body keeps the old one as a revision.',
  z.object({id:memoryId,content:z.string().max(65536).optional(),metadata:z.record(z.string(),z.unknown()).optional(),observation:z.enum(['confirm','contradict']).optional()}).strict(),
  async input=>{await run('memory.update',input);return 'Updated '+input.id;});

 tool('forget','Delete one of your memories by its id. This is final.',
  z.object({id:memoryId}).strict(),
  async input=>{await run('memory.forget',input);return 'Forgot '+input.id;});

 tool('episodes','Recent activity across your bodies, newest first. Pass `to` (YYYY-MM-DD) for an earlier window.',
  z.object({to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).strict(),
  async input=>{
   const data=await read<{memoryActivity:{to:string;days:string[];earlier:string|null;truncated:boolean;entries:Entry[]}|null}>(
    'query($to:String){memoryActivity(to:$to){to days earlier truncated entries{id at title line where what}}}',{to:input.to??null});
   const window=data.memoryActivity;if(!window)return 'No activity is readable.';
   return 'Days '+window.days.join(', ')+(window.earlier?' (earlier: to='+window.earlier+')':'')+(window.truncated?' (truncated)':'')+'\n\n'
    +window.entries.map(entry=>'- **'+entry.at+'** ['+entry.where+'] '+entry.title+(entry.line?' — '+entry.line:'')).join('\n');
  });

 tool('knowledge_recall','Search shared knowledge pages. Every word must appear in the title, body or domain.',
  z.object({query:z.string().min(1).max(400),domain:z.string().min(1).max(200).optional(),limit:z.number().int().min(1).max(50).optional()}).strict(),
  async input=>{
   const data=await read<{memoryKnowledgeSearch:Page[]|null}>(
    'query($query:String!,$domain:String,$first:Int){memoryKnowledgeSearch(query:$query,domain:$domain,first:$first){slug title domain updated verified_at body}}',
    {query:input.query,domain:input.domain??null,first:input.limit??5});
   if(!data.memoryKnowledgeSearch)throw new Refusal('Knowledge is not readable with this credential');
   if(!data.memoryKnowledgeSearch.length)return 'No knowledge pages matched.';
   return data.memoryKnowledgeSearch.map(page=>'## '+page.title+'\n_'+page.domain+' · '+page.slug+' · updated '+page.updated+(page.verified_at?' · verified '+page.verified_at:' · never verified')+'_\n\n'+page.body).join('\n\n---\n\n');
  });

 tool('knowledge_write','Add a shared knowledge page.',
  z.object({title:z.string().min(1).max(200),domain:z.string().min(1).max(200),body:z.string().min(1).max(65536),source:z.string().max(4000).optional()}).strict(),
  async input=>{const value=await run('mind.knowledgeAdd',input) as {slug:string};return 'Wrote knowledge page '+value.slug;});

 tool('note_read','Read one of your notes by path.',
  z.object({path:notePath}).strict(),
  async(input,agent)=>{
   const data=await read<{memoryNote:Note|null}>('query($agent:String!,$path:String!){memoryNote(agent:$agent,path:$path){path body lifespan created updated by}}',{agent,path:input.path});
   const note=data.memoryNote;if(!note)return 'No note at '+input.path;
   return '# '+note.path+'\n_'+note.lifespan+' · updated '+note.updated+' by '+note.by+'_\n\n'+note.body;
  });

 tool('note_write','Write a note, whole. A new note needs a lifespan (keep, while or short).',
  z.object({path:notePath,body:z.string(),lifespan:z.enum(['keep','while','short']).optional()}).strict(),
  async input=>{await run('memory.noteWrite',input);return 'Saved note '+input.path;});

 tool('note_list','List your notes under a prefix, newest first. No text.',
  z.object({prefix:z.string().max(300).optional(),limit:z.number().int().min(1).max(500).optional()}).strict(),
  async(input,agent)=>{
   const data=await read<{memoryNotes:NoteSummary[]|null}>('query($agent:String!,$prefix:String,$first:Int){memoryNotes(agent:$agent,prefix:$prefix,first:$first){path lifespan updated by bytes files expires}}',{agent,prefix:input.prefix??null,first:input.limit??100});
   if(!data.memoryNotes)throw new Refusal('Notes are not readable with this credential');
   if(!data.memoryNotes.length)return 'No notes'+(input.prefix?' under '+input.prefix:'')+'.';
   return data.memoryNotes.map(note=>'- '+note.path+' ('+note.lifespan+', '+note.bytes+' bytes'+(note.files?', '+note.files+' files':'')+', updated '+note.updated+(note.expires?', expires '+note.expires:'')+')').join('\n');
  });
}
/** A refusal whose words are safe to show the caller. */
class Refusal extends Error{}
