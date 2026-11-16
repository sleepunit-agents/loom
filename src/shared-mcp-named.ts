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
const pageName=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
type Section='creed'|'preferences'|'top-of-mind'|'self-model'|'last-24h'|'harness'|'model'|'all';

interface Memory{id:string;title:string;content:string;category:string;updated:string}
interface NoteSummary{path:string;lifespan:string;updated:string;by:string;bytes:number;files:number;expires:string|null}
interface Note{path:string;body:string;lifespan:string;created:string;updated:string;by:string}
interface Page{slug:string;title:string;domain:string;updated:string;verified_at:string|null;body:string}
interface Entry{id:string;at:string;title:string;line:string|null;where:string;what:string}

export function registerNamedTools(server:McpServer,ports:NamedToolPorts){
 /** A command's value, or a thrown refusal carrying the door's own words. */
 const run=async(name:string,input:unknown)=>{
  // A failure is flat: {ok:false, code, message}. Say both, so a refusal can be acted on.
  const reply=await ports.command(name,input,randomUUID()) as {ok?:boolean;value?:unknown;code?:string;message?:string};
  if(reply?.ok!==true)throw new Refusal(reply?.message?reply.message+(reply.code?' ('+reply.code+')':''):reply?.code??'The command was refused');
  return reply.value;
 };
 const read=async<T>(query:string,variables:Variables={})=>{
  const reply=await ports.query({query,variables});
  // GraphQL's own message names the field or argument at fault; it carries no stored words.
  if(reply.errors?.length||!reply.data){const first=(reply.errors?.[0] as {message?:unknown}|undefined)?.message;throw new Refusal('The read was refused'+(typeof first==='string'?': '+first:''));}
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

 const section=z.enum(['creed','preferences','top-of-mind','self-model','last-24h','harness','model','all']);
 server.registerTool('identity',{description:'Load your own Identity. Returns the creed, preferences, Top of Mind and an index of further pieces; pass piece or pieces for self-model, last-24h, harness (with client), model (with model) or all. Hints never select another caller or grant authority.',
  inputSchema:z.object({agent:z.string().optional(),client:z.string().max(100).optional(),model:z.string().max(100).optional(),piece:section.optional(),pieces:z.array(section).max(8).optional(),role:z.string().max(100).optional(),project:z.string().max(100).optional()}).strict()},
  async(args:{agent?:string;client?:string;model?:string;piece?:Section;pieces?:Section[];role?:string;project?:string}):Promise<Result>=>{
   try{
    const agent=ports.agent;if(!ports.valid()||!agent||args.agent&&args.agent!==agent)throw Error();
    const asked=[...(args.piece?[args.piece]:[]),...(args.pieces??[])],core=!asked.length,all=asked.includes('all');
    const wants=(name:Section)=>all||asked.includes(name)||core&&(name==='creed'||name==='preferences'||name==='top-of-mind');
    // A model page may be filed under a shorter family name: claude-fable-5-2, claude-fable-5, claude-fable.
    const family=(name:string)=>name.split('-').map((_part,index,parts)=>parts.slice(0,parts.length-index).join('-'));
    const pages:{alias:string;kind:string;name:string;heading:string}[]=[];
    const page=(kind:string,name:string|undefined,heading:string,names:(name:string)=>string[]=name=>[name])=>{if(name&&pageName.test(name))for(const candidate of names(name))pages.push({alias:'p'+pages.length,kind,name:candidate,heading});};
    if(core||all){page('role',args.role,'Mode: '+args.role);page('project',args.project,'Project: '+args.project);}
    if(wants('harness')){page('harness',args.client,'Harness: '+args.client);page('client',args.client,'Client: '+args.client);}
    if(wants('model'))page('model',args.model,'Model: '+args.model,family);
    const fields=['agent',wants('creed')&&'creed',wants('preferences')&&'preferences',wants('top-of-mind')&&'topOfMind',wants('self-model')&&'selfModel',wants('last-24h')&&'recent',
     ...pages.map(entry=>entry.alias+':page(kind:'+JSON.stringify(entry.kind)+',name:'+JSON.stringify(entry.name)+')')].filter(Boolean).join(' ');
    const data=await read<{memoryIdentity:Record<string,string|null>|null}>('query($agent:String!){memoryIdentity(agent:$agent){'+fields+'}}',{agent});
    const identity=data.memoryIdentity;if(!identity||identity.agent!==agent)throw Error();
    const parts:string[]=[],add=(heading:string,words:string|null|undefined)=>{if(words)parts.push('# '+heading+'\n\n'+words);};
    add('Identity',identity.creed);add('Preferences',identity.preferences);add('Top of Mind',identity.topOfMind);add('Self-Model',identity.selfModel);add('Last 24 hours',identity.recent);
    const shown=new Set<string>();for(const entry of pages)if(identity[entry.alias]&&!shown.has(entry.heading)){shown.add(entry.heading);add(entry.heading,identity[entry.alias]);}
    if(core)parts.push('# Pieces\n\nLoad with identity({piece: "name"}); pass client or model for their pages. Use piece: "all" for everything.\n\n- last-24h: what other bodies did recently\n- self-model: before reflection, retro or identity work\n- harness: before scheduling, delegation or harness-specific work (pass client)\n- model: when choosing or describing models (pass model)');
    return say('Agent: '+agent+'\n\n'+(parts.join('\n\n---\n\n')||'No Identity has been written.'));
   }catch{return refuse('Identity unavailable');}
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

 tool('knowledge_write','Add a shared knowledge page. source, if given, is an http or https link; without one the page stays provisional.',
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

 // Cards: what you know about a person, and a project's card. Each lives in your own store, addressed by slug.
 // Lengths match the commands: a person's slug is at most 64 characters, a project's 32.
 const slugOf=(max:number)=>z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(max),slug=slugOf(64),projectSlug=slugOf(32),facts=z.record(z.string(),z.unknown());
 const shown=(value:CardValue|string|null|undefined)=>value==null?'':typeof value==='string'?value:value.text??(value.strings?value.strings.join(', '):value.number!=null?String(value.number):value.boolean!=null?String(value.boolean):'');
 tool('person','Read your card on one person by slug, or list the people you have cards on.',
  z.object({slug:slug.optional()}).strict(),
  async(input,agent)=>{
   if(!input.slug){
    const data=await read<{memoryPeople:{slug:string;name:string;agent:string}[]|null}>('{memoryPeople{slug name agent}}',{});
    const mine=(data.memoryPeople??[]).filter(row=>row.agent===agent);
    return mine.length?mine.map(row=>'- '+row.slug+' ('+row.name+')').join('\n'):'No person cards.';
   }
   const data=await read<{memoryPerson:PersonCard|null}>('query($id:String!){memoryPerson(id:$id){slug name updated card{summary where{key label source verified_at value{text number boolean strings}} how{key value{text number boolean strings}} may{text source}}}}',{id:agent+':'+input.slug});
   const person=data.memoryPerson;if(!person)return 'No person card for '+input.slug;
   const card=person.card,lines=['# '+person.name,'_'+person.slug+' · updated '+person.updated+'_'];
   if(card?.summary)lines.push('',card.summary);
   if(card?.where?.length)lines.push('','## Where',...card.where.map(row=>'- '+(row.label||row.key)+': '+shown(row.value)+(row.verified_at?' (verified '+row.verified_at+')':'')));
   if(card?.how?.length)lines.push('','## How',...card.how.map(row=>'- '+row.key+': '+shown(row.value)));
   if(card?.may?.length)lines.push('','## May',...card.may.map(row=>'- '+row.text+' ('+row.source+')'));
   return lines.join('\n');
  });

 tool('person_write','Write your card on a person. Pass merge: true to change only the fields you name. Each entry under where is {value, source?, verified_at?}.',
  z.object({slug,name:z.string().max(200).optional(),summary:z.string().max(4000).optional(),where:facts.optional(),how:facts.optional(),may:z.array(z.object({text:z.string(),source:z.string()}).strict()).optional(),merge:z.boolean().optional()}).strict(),
  async input=>{await run('memory.personWrite',input);return 'Saved person card '+input.slug;});

 tool('project','Read one of your project cards by slug, or list them.',
  z.object({slug:projectSlug.optional()}).strict(),
  async(input,agent)=>{
   if(!input.slug){
    const data=await read<{memoryProjects:{slug:string;name:string;agent:string}[]|null}>('{memoryProjects{slug name agent}}',{});
    const mine=(data.memoryProjects??[]).filter(row=>row.agent===agent);
    return mine.length?mine.map(row=>'- '+row.slug+' ('+row.name+')').join('\n'):'No project cards.';
   }
   const data=await read<{memoryProject:ProjectCard|null}>('query($id:String!){memoryProject(id:$id){slug name updated card{status summary goal where{key value verified_at} links{aliases notes epic repos venues}}}}',{id:agent+':'+input.slug});
   const project=data.memoryProject;if(!project)return 'No project card for '+input.slug;
   const card=project.card,lines=['# '+project.name,'_'+project.slug+(card?.status?' · '+card.status:'')+' · updated '+project.updated+'_'];
   if(card?.summary)lines.push('',card.summary);
   if(card?.goal)lines.push('','## Goal','',card.goal);
   if(card?.where?.length)lines.push('','## Where',...card.where.map(row=>'- '+row.key+': '+shown(row.value)+(row.verified_at?' (verified '+row.verified_at+')':'')));
   const links=Object.entries(card?.links??{}).filter(([,value])=>Array.isArray(value)?value.length:value);
   if(links.length)lines.push('','## Links',...links.map(([key,value])=>'- '+key+': '+(Array.isArray(value)?value.join(', '):value)));
   return lines.join('\n');
  });

 tool('project_write','Write one of your project cards. Pass merge: true to change only the fields you name. Each entry under where is {value, source?, verified_at?}.',
  z.object({slug:projectSlug,name:z.string().max(200).optional(),status:z.enum(['active','paused','done']).optional(),summary:z.string().max(4000).optional(),goal:z.string().max(4000).optional(),where:facts.optional(),
   links:z.object({aliases:z.array(z.string()).nullable().optional(),notes:z.array(z.string()).nullable().optional(),epic:z.string().nullable().optional(),repos:z.array(z.string()).nullable().optional(),venues:z.array(z.string()).nullable().optional()}).strict().optional(),merge:z.boolean().optional()}).strict(),
  async input=>{await run('memory.projectWrite',input);return 'Saved project card '+input.slug;});

 // Memory: drafts, the archive and earlier versions.
 tool('memory_propose','Draft a memory. Recall cannot see a draft until it is ratified.',
  z.object({category,title:z.string().max(200),content:z.string().max(65536),project:z.string().min(1).max(200).optional(),ttl:z.string().max(50).optional(),metadata:z.record(z.string(),z.unknown()).optional(),source:z.string().max(200).optional()}).strict(),
  async input=>{const value=await run('memory.propose',input) as {id?:string;ids?:string[]};return 'Drafted "'+input.title+'" ('+(value.id??(value.ids??[]).join(', '))+')';});
 tool('memory_drafts','List your drafted memories that await ratification.',
  z.object({limit:z.number().int().min(1).max(50).optional()}).strict(),
  async(input,agent)=>{
   const data=await read<{memoryProposals:{entries:{id:string;title:string;category:string;created:string;content:string}[]}|null}>('query($agent:String!,$first:Int){memoryProposals(agent:$agent,first:$first){entries{id title category created content}}}',{agent,first:input.limit??20});
   const rows=data.memoryProposals?.entries??[];
   return rows.length?rows.map(row=>'## '+row.title+'\n_'+row.category+' · '+row.id+' · drafted '+row.created+'_\n\n'+row.content).join('\n\n---\n\n'):'No drafts.';
  });
 tool('memory_ratify','Make one of your drafts a real memory.',
  z.object({id:z.string().min(1).max(200)}).strict(),
  async input=>{await run('memory.ratify',input);return 'Ratified '+input.id;});
 tool('memory_archive','Set one of your memories aside. It leaves recall and can be restored.',
  z.object({id:memoryId,note:z.string().max(500).optional()}).strict(),
  async input=>{await run('memory.archive',input);return 'Archived '+input.id;});
 tool('memory_restore','Bring back an archived memory, or with revision, an earlier version of a memory.',
  z.object({id:memoryId,revision:z.number().int().positive().optional()}).strict(),
  async input=>{if(input.revision===undefined){await run('memory.restore',{id:input.id});return 'Restored '+input.id;}await run('memory.restoreRevision',{id:input.id,revision_id:input.revision});return 'Restored version '+input.revision+' of '+input.id;});
 tool('memory_history','List the earlier versions kept for one of your memories.',
  z.object({id:memoryId}).strict(),
  async input=>{
   const data=await read<{memoryHistory:{id:number;op:string;replacedAt:string;content:string}[]|null}>('query($id:String!){memoryHistory(id:$id){id op replacedAt content}}',{id:input.id});
   const rows=data.memoryHistory??[];
   return rows.length?rows.map(row=>'## Version '+row.id+'\n_'+row.op+' · replaced '+row.replacedAt+'_\n\n'+row.content).join('\n\n---\n\n'):'No earlier versions are kept.';
  });

 // Knowledge: one page, its checks and its versions.
 tool('knowledge_read','Read one shared knowledge page by slug, with its sources and kept versions.',
  z.object({slug:z.string().min(1).max(200)}).strict(),
  async input=>{
   const data=await read<{memoryKnowledgePage:{slug:string;title:string;domain:string;updated:string;verified_at:string|null;sourcing:string|null;body:string;sources:{claim:string;locator:string}[]|null;history:{id:number;op:string;replacedAt:string;actor:string|null}[]|null}|null}>(
    'query($slug:String!){memoryKnowledgePage(slug:$slug){slug title domain updated verified_at sourcing body sources{claim locator} history{id op replacedAt actor}}}',{slug:input.slug});
   const page=data.memoryKnowledgePage;if(!page)return 'No knowledge page '+input.slug;
   const lines=['# '+page.title,'_'+page.domain+' · '+page.slug+' · '+(page.sourcing??'unsourced')+' · updated '+page.updated+(page.verified_at?' · verified '+page.verified_at:' · never verified')+'_','',page.body];
   if(page.sources?.length)lines.push('','## Sources',...page.sources.map(row=>'- '+row.locator));
   if(page.history?.length)lines.push('','## Earlier versions',...page.history.map(row=>'- '+row.id+' ('+row.op+', replaced '+row.replacedAt+(row.actor?' by '+row.actor:'')+')'));
   return lines.join('\n');
  });
 tool('knowledge_edit','Replace the body of a shared knowledge page. The old body is kept as a version.',
  z.object({slug:z.string().min(1).max(200),body:z.string().min(1).max(65536)}).strict(),
  async input=>{await run('mind.knowledgeEdit',input);return 'Edited knowledge page '+input.slug;});
 tool('knowledge_check','Record a check of a shared knowledge page: still true, or due a check.',
  z.object({slug:z.string().min(1).max(200),outcome:z.enum(['still-true','due-a-check'])}).strict(),
  async input=>{await run(input.outcome==='still-true'?'mind.knowledgeVerify':'mind.knowledgeRecheck',{slug:input.slug});return 'Marked '+input.slug+' '+(input.outcome==='still-true'?'still true':'due a check');});
 tool('knowledge_restore','Put back an earlier version of a shared knowledge page.',
  z.object({slug:z.string().min(1).max(200),revision:z.number().int().positive()}).strict(),
  async input=>{await run('mind.knowledgeRestore',input);return 'Restored version '+input.revision+' of '+input.slug;});

 // Tasks: the household's work queue, as far as you may see it.
 const taskId=z.string().regex(/^t-[1-9][0-9]*$/);
 type TaskRow={id:string;title:string;type:string;status:string;priority:number;project:string|null;ownerKind:string;owner:string|null;assigneeKind:string|null;assignee:string|null;goal:string;why:string;doneWhen:string;description:string;ask:string|null;closeReason:string|null;
  taskCommentsByTask?:{seq:number;actor:string;at:string;text:string}[];taskLinksByTask?:{dependsOn:string;type:string}[]};
 const taskLine=(task:TaskRow)=>'- '+task.id+' P'+task.priority+' '+task.title+(task.project?' ['+task.project+']':'')+(task.status==='open'?'':' ('+task.status+(task.assignee?', '+task.assignee:'')+')');
 tool('task_ready','List the tasks ready to pick up, most urgent first. Pass project to narrow it.',
  z.object({project:z.string().min(1).max(100).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),
  async input=>{
   const data=await read<{readyTasks:TaskRow[]}>('query($limit:Int){readyTasks(limit:$limit){id title type status priority project ownerKind owner assigneeKind assignee goal why doneWhen description ask closeReason}}',{limit:input.project?500:input.limit??20});
   const rows=data.readyTasks.filter(task=>!input.project||task.project===input.project).slice(0,input.limit??20);
   return rows.length?rows.map(taskLine).join('\n'):'Nothing is ready.';
  });
 tool('task','Read one task with its comments and what it depends on.',
  z.object({id:taskId}).strict(),
  async input=>{
   const data=await read<{tasks:TaskRow[]}>('query($id:String!){tasks(where:{id:{eq:$id}}){id title type status priority project ownerKind owner assigneeKind assignee goal why doneWhen description ask closeReason taskCommentsByTask{seq actor at text} taskLinksByTask{dependsOn type}}}',{id:input.id});
   const task=data.tasks[0];if(!task)return 'No task '+input.id+' that you may see.';
   const lines=['# '+task.title,'_'+task.id+' · '+task.type+' · '+task.status+' · P'+task.priority+(task.project?' · '+task.project:'')+' · owner '+(task.owner??task.ownerKind)+(task.assignee?' · held by '+task.assignee:'')+'_','','**Goal:** '+task.goal,'**Why:** '+task.why];
   if(task.doneWhen)lines.push('**Done when:** '+task.doneWhen);
   if(task.description)lines.push('',task.description);
   if(task.ask)lines.push('','**Question waiting:** '+task.ask);
   if(task.closeReason)lines.push('','**Closed:** '+task.closeReason);
   if(task.taskLinksByTask?.length)lines.push('','## Depends on',...task.taskLinksByTask.map(link=>'- '+link.dependsOn+' ('+(link.type==='blocks'?'blocked by':'parent')+')'));
   if(task.taskCommentsByTask?.length)lines.push('','## Comments',...[...task.taskCommentsByTask].sort((a,b)=>a.seq-b.seq).map(row=>'- **'+row.actor+'** '+row.at+': '+row.text));
   return lines.join('\n');
  });
 tool('task_create','File a task. It needs a plain title, a goal and a reason. You own it unless you name the household or a project owner.',
  z.object({title:z.string().min(1).max(300),goal:z.string().min(1).max(2000),why:z.string().min(1).max(2000),doneWhen:z.string().max(2000).optional(),description:z.string().max(20000).optional(),priority:z.number().int().min(0).max(4).optional(),
   project:z.string().min(1).max(100).optional(),type:z.enum(['task','bug','feature','epic']).optional(),parent:taskId.optional(),owner:z.enum(['me','household']).optional()}).strict(),
  async(input,agent)=>{const {owner,...fields}=input;const value=await run('tasks.command',{action:'create',input:{...fields,owner:owner==='household'?{kind:'household'}:{kind:'agent',id:agent}}}) as {id?:string};return 'Filed '+value.id+': '+input.title;});
 tool('task_edit','Change a task\'s title, goal, reason, done-when, description, priority or project.',
  z.object({id:taskId,title:z.string().min(1).max(300).optional(),goal:z.string().min(1).max(2000).optional(),why:z.string().min(1).max(2000).optional(),doneWhen:z.string().max(2000).optional(),description:z.string().max(20000).optional(),priority:z.number().int().min(0).max(4).optional(),project:z.string().min(1).max(100).nullable().optional()}).strict(),
  async input=>{const {id,...fields}=input;await run('tasks.command',{action:'edit',id,input:fields});return 'Edited '+id;});
 tool('task_claim','Claim an open task: it moves to in progress and you hold it. Pass release: true to hand it back.',
  z.object({id:taskId,release:z.boolean().optional()}).strict(),
  async input=>{await run('tasks.command',{action:input.release?'unclaim':'claim',id:input.id});return (input.release?'Released ':'Claimed ')+input.id;});
 tool('task_close','Close a task with a reason. The reason "cancelled" marks it cancelled. Pass reopen: true to open a closed task again.',
  z.object({id:taskId,reason:z.string().min(1).max(2000).optional(),reopen:z.boolean().optional()}).strict().refine(value=>value.reopen||!!value.reason,'A reason is needed to close a task'),
  async input=>{if(input.reopen){await run('tasks.command',{action:'reopen',id:input.id});return 'Reopened '+input.id;}await run('tasks.command',{action:'close',id:input.id,reason:input.reason});return 'Closed '+input.id;});
 tool('task_comment','Leave a comment on a task.',
  z.object({id:taskId,text:z.string().min(1).max(20000)}).strict(),
  async input=>{await run('tasks.command',{action:'comment',id:input.id,text:input.text});return 'Commented on '+input.id;});

 // Asking a person: proposals, the approvals that result, and what waits in your inbox.
 tool('propose','Ask a household owner to allow a change you cannot make yourself. change is one of: project, member, agent, settings, rule, bodyPolicy, tokenRevoke, boxRevoke, browserSignOut. input is that change\'s own fields; loom_commands({name:"household.propose"}) lists them. Nothing changes until an owner allows it.',
  z.object({change:z.enum(['project','member','agent','settings','rule','bodyPolicy','tokenRevoke','boxRevoke','browserSignOut']),input:z.record(z.string(),z.unknown()),why:z.string().min(1).max(500)}).strict(),
  async input=>{const value=await run('household.propose',input) as {id:string};return 'Filed approval '+value.id+'. It waits for a household owner.';});
 tool('approvals','List approvals you may see, newest first. state narrows it: pending, allowed, denied, used, withdrawn or expired.',
  z.object({state:z.enum(['pending','allowed','denied','used','withdrawn','expired']).optional(),limit:z.number().int().min(1).max(50).optional()}).strict(),
  async input=>{
   // The state is one of six fixed words, so it is safe to write into the query as an enum value.
   const data=await read<{approvals:{id:string;kind:string;state:string;agent:string;ask:string;why:string;changeSummary:string|null;target:string;askedAt:string;decidedBy:string|null}[]}>(
    'query($limit:Int){approvals('+(input.state?'where:{state:{eq:'+input.state+'}},':'')+'limit:$limit,orderBy:{askedAt:{direction:desc,priority:1}}){id kind state agent ask why changeSummary target askedAt decidedBy}}',{limit:input.limit??20});
   return data.approvals.length?data.approvals.map(row=>'## '+row.ask+'\n_'+row.id+' · '+row.kind+' · '+row.state+' · asked by '+row.agent+' '+row.askedAt+(row.decidedBy?' · answered by '+row.decidedBy:'')+'_\n\n'+(row.changeSummary??row.target)+'\n\nWhy: '+row.why).join('\n\n---\n\n'):'No approvals'+(input.state?' are '+input.state:'')+'.';
  });
 tool('inbox','List what is in your inbox, newest first. state narrows it: waiting, taken, done, answered or resolved.',
  z.object({state:z.enum(['waiting','taken','done','answered','resolved']).optional(),limit:z.number().int().min(1).max(50).optional()}).strict(),
  async input=>{
   const data=await read<{inboxItems:{id:string;source:string;state:string;fromKind:string;fromId:string|null;at:string;body:{words:string|null;why:string|null}|null}[]}>(
    'query($state:String,$limit:Int){inboxItems(state:$state,limit:$limit){id source state fromKind fromId at body{words why}}}',{state:input.state??null,limit:input.limit??20});
   return data.inboxItems.length?data.inboxItems.map(row=>'## '+row.source+' from '+(row.fromId??row.fromKind)+'\n_'+row.id+' · '+row.state+' · '+row.at+'_\n\n'+(row.body?.words??'(no words kept)')+(row.body?.why?'\n\nWhy: '+row.body.why:'')).join('\n\n---\n\n'):'Your inbox is empty'+(input.state?' of '+input.state+' items':'')+'.';
  });
}
interface CardValue{text?:string|null;number?:number|null;boolean?:boolean|null;strings?:string[]|null}
interface PersonCard{slug:string;name:string;updated:string;card:{summary:string|null;where:{key:string;label:string|null;source:string|null;verified_at:string|null;value:CardValue|null}[]|null;how:{key:string;value:CardValue|null}[]|null;may:{text:string;source:string}[]|null}|null}
interface ProjectCard{slug:string;name:string;updated:string;card:{status:string|null;summary:string|null;goal:string|null;where:{key:string;value:string|null;verified_at:string|null}[]|null;links:Record<string,string|string[]|null>|null}|null}
/** A refusal whose words are safe to show the caller. */
class Refusal extends Error{}
