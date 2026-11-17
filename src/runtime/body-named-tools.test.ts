/** A body's named tools: the terminal's one definition, on the body's own generic tools. No loom here;
 * body-named-tools.integration.test.ts runs the same tools against a started loom. */
import {createRequire} from 'node:module';
import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/server';
import {registerNamedTools} from '../shared-mcp-named.js';
import {bodyDeniedTools,bodyNamedToolNames,bodyNamedTools} from './body-named-tools.js';
import {deniedTools,denialEntries} from './harness-traits.js';
import type {WorkerRunPolicy} from './worker.js';
import {bodyModelTools,BODY_EXTENSION_TOOLS_MAX,type BodyModelTool} from './body-model-tools.js';
import {harnessToolNames,harnessToolPrefix} from './body-harness.js';
import {programToolDefinitions} from './body-program-tools.js';

type Reply={content:{type:'text';text:string}[];isError?:boolean};
const text=(value:unknown,isError=false):Reply=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}],...(isError?{isError:true}:{})});
/** The body's two generic tools, answering from the test. */
function generic(answer:{command?:(input:{operation:string;input:unknown;id:string})=>Reply;query?:(input:{query:string;variables?:unknown})=>Reply}={}){
 const command=vi.fn(async(input:Record<string,unknown>,_signal:AbortSignal)=>answer.command?.(input as never)??text({ok:true,value:{}}));
 const query=vi.fn(async(input:Record<string,unknown>,_signal:AbortSignal)=>answer.query?.(input as never)??text({data:{}}));
 const tools:BodyModelTool[]=[
  {name:'loom_command',description:'Generic command',inputSchema:z.object({}).loose(),execute:command},
  {name:'loom_query',description:'Generic query',inputSchema:z.object({}).loose(),execute:query}];
 return {tools,command,query};
}
const call=(tools:readonly BodyModelTool[],name:string,args:Record<string,unknown>,signal=new AbortController().signal)=>tools.find(tool=>tool.name===name)!.execute(args,signal);

it('loads no native code into the body: the definition\'s server-side imports stay unopened',()=>{
 // A body runs on whatever node its house image has; a native addon built for loom's node may not load there.
 const loaded=Object.keys(createRequire(import.meta.url).cache).filter(file=>file.endsWith('.node'));
 expect(loaded).toEqual([]);
 const dlopen=vi.spyOn(process,'dlopen');
 try{expect(bodyNamedTools({agent:'art',generic:generic().tools}).length).toBeGreaterThan(30);expect(dlopen).not.toHaveBeenCalled();}finally{dlopen.mockRestore();}
});

it('offers exactly the tools the terminal\'s one definition registers, with its descriptions and inputs',()=>{
 const registered:{name:string;description:string;inputSchema:z.ZodObject}[]=[];
 const server=new McpServer({name:'fictional',version:'1'}),register=server.registerTool.bind(server);
 vi.spyOn(server,'registerTool').mockImplementation(((name:string,config:{description:string;inputSchema:z.ZodObject},handler:never)=>{registered.push({name,description:config.description,inputSchema:config.inputSchema});return register(name,config,handler);}) as never);
 registerNamedTools(server,{agent:'art',valid:()=>true,query:async()=>({data:{}}),command:async()=>({ok:true,value:{}})});
 const tools=bodyNamedTools({agent:'art',generic:generic().tools});
 expect(tools.map(tool=>tool.name)).toEqual(registered.map(tool=>tool.name));
 expect(tools.map(tool=>tool.description)).toEqual(registered.map(tool=>tool.description));
 expect(tools.map(tool=>z.toJSONSchema(tool.inputSchema))).toEqual(registered.map(tool=>z.toJSONSchema(tool.inputSchema)));
 expect(bodyNamedToolNames()).toEqual(registered.map(tool=>tool.name));
 expect(tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['identity','remember','recall','note_read','note_write','task','task_create','task_claim','task_close','task_comment','task_edit','task_ready','task_move_to_project','knowledge_recall','person','project','propose','approvals','inbox','episodes']));
});

it('fits the body\'s tools server beside the secret tools and the three generic ones',()=>{
 const named=bodyNamedTools({agent:'art',generic:generic().tools}),all=[...programToolDefinitions.map(([name])=>name),...named.map(tool=>tool.name)];
 expect(()=>bodyModelTools([...generic().tools,{...generic().tools[0],name:'loom_commands'},...named])).not.toThrow();
 expect(all.length).toBeLessThanOrEqual(BODY_EXTENSION_TOOLS_MAX);
 expect(harnessToolNames(['request_secret','use_secret',...all].map(name=>harnessToolPrefix+name))).toHaveLength(all.length+2);
 // The whole allowance is accepted, and one more is not, at both places that count.
 const filler=(count:number)=>Array.from({length:count},(_,index)=>({...generic().tools[0],name:'tool'+index}));
 expect(()=>bodyModelTools(filler(BODY_EXTENSION_TOOLS_MAX))).not.toThrow();expect(()=>bodyModelTools(filler(BODY_EXTENSION_TOOLS_MAX+1))).toThrow();
 const names=(count:number)=>['request_secret','use_secret',...filler(count).map(tool=>tool.name)].map(name=>harnessToolPrefix+name);
 expect(()=>harnessToolNames(names(BODY_EXTENSION_TOOLS_MAX))).not.toThrow();expect(()=>harnessToolNames(names(BODY_EXTENSION_TOOLS_MAX+1))).toThrow();
});

it('sends a named write through the body\'s own loom_command tool, and a read through its loom_query tool',async()=>{
 const g=generic({command:()=>text({ok:true,value:{ids:['art:1']}}),query:()=>text({data:{memoryNote:{path:'work/pump',body:'FICTIONAL NOTE',lifespan:'keep',created:'c',updated:'u',by:'art'}}})});
 const tools=bodyNamedTools({agent:'art',generic:g.tools}),signal=new AbortController().signal;
 expect(await call(tools,'remember',{category:'reference',title:'Fictional pump',content:'words'},signal)).toEqual(text('Remembered "Fictional pump" (art:1)'));
 expect(g.command).toHaveBeenCalledExactlyOnceWith({operation:'memory.remember',input:{category:'reference',title:'Fictional pump',content:'words'},id:expect.stringMatching(/^[0-9a-f-]{36}$/)},signal);
 expect((await call(tools,'note_read',{path:'work/pump'},signal)).content[0].text).toContain('FICTIONAL NOTE');
 expect(g.query).toHaveBeenCalledExactlyOnceWith({query:expect.stringContaining('memoryNote(agent:$agent,path:$path)'),variables:{agent:'art',path:'work/pump'}},signal);
});

it('refuses with the door\'s own words where the generic tool is refused, and says nothing it cannot vouch for',async()=>{
 const refused=generic({command:()=>text({ok:false,code:'denied',message:'Permission denied'},true),query:()=>text({errors:[{message:'Cannot query field "secret"'}]})});
 const tools=bodyNamedTools({agent:'art',generic:refused.tools});
 expect(await call(tools,'task_comment',{id:'t-1',text:'words'})).toEqual(text('Permission denied (denied)',true));
 expect(await call(tools,'note_read',{path:'work/pump'})).toEqual(text('The read was refused: Cannot query field "secret"',true));
 // The generic tool could not say what happened (a local refusal, a lost connection): neither can the named one.
 const lost=generic({command:()=>text('Body tool unavailable; outcome may be uncertain',true),query:()=>text('Body tool unavailable; outcome may be uncertain',true)});
 const uncertain=bodyNamedTools({agent:'art',generic:lost.tools});
 expect(await call(uncertain,'task_close',{id:'t-1',reason:'done'})).toEqual(text('Tool unavailable; outcome may be uncertain',true));
 expect(await call(uncertain,'note_read',{path:'work/pump'})).toEqual(text('Tool unavailable; outcome may be uncertain',true));
 // Input the definition refuses never reaches a door.
 expect((await call(tools,'task_comment',{id:'not-a-task',text:'words'})).isError).toBe(true);expect(refused.command).toHaveBeenCalledOnce();
});

it('stops answering when its call is cancelled',async()=>{
 const g=generic(),tools=bodyNamedTools({agent:'art',generic:g.tools}),abort=new AbortController();abort.abort();
 expect(await call(tools,'task_claim',{id:'t-1'},abort.signal)).toEqual(text('Authentication ended',true));expect(g.command).not.toHaveBeenCalled();
});

it('offers no named tool to a body that lacks either generic tool',()=>{
 const g=generic();
 expect(bodyNamedTools({agent:'art',generic:[]})).toEqual([]);
 expect(bodyNamedTools({agent:'art',generic:[g.tools[0]]})).toEqual([]);
 expect(bodyNamedTools({agent:'art',generic:[g.tools[1]]})).toEqual([]);
});

it('does not repeat in a body what the body was handed when it started',async()=>{
 const asked:string[]=[];
 const all:Record<string,string>={agent:'art',creed:'FICTIONAL CREED',preferences:'FICTIONAL PREFERENCES',topOfMind:'FICTIONAL TOP',selfModel:'FICTIONAL SELF',p0:'FICTIONAL PROJECT PAGE'};
 // As loom does, answer with the fields the query names and no others.
 const g=generic({query:input=>{asked.push(input.query);return text({data:{memoryIdentity:Object.fromEntries(Object.entries(all).filter(([field])=>new RegExp('\\b'+field+'\\b').test(input.query.slice(input.query.indexOf('{memoryIdentity'))))) }});}});
 const tools=bodyNamedTools({agent:'art',generic:g.tools,identityHanded:true});
 const core=(await call(tools,'identity',{project:'pond'})).content[0].text;
 expect(core).toContain('Agent: art');expect(core).toContain('FICTIONAL PROJECT PAGE');expect(core).toContain('# Pieces');expect(core).toContain('handed to this body when it started');
 // The index says how to read again what was not repeated.
 expect(core).toContain('- creed, preferences, top-of-mind:');
 expect(core).not.toContain('FICTIONAL CREED');expect(core).not.toContain('FICTIONAL PREFERENCES');expect(core).not.toContain('FICTIONAL TOP');
 expect(asked[0]).not.toMatch(/\b(creed|preferences|topOfMind)\b/);
 // A piece asked for by name is returned as asked.
 const creed=(await call(tools,'identity',{piece:'creed'})).content[0].text;expect(creed).toContain('FICTIONAL CREED');
 expect((await call(tools,'identity',{piece:'self-model'})).content[0].text).toContain('FICTIONAL SELF');
 expect((await call(tools,'identity',{agent:'mark'})).isError).toBe(true);
 // A body that was handed nothing (its agent has no identity, or the read came back empty) is not told it was.
 const bare=bodyNamedTools({agent:'art',generic:g.tools,identityHanded:false}),whole=(await call(bare,'identity',{})).content[0].text;
 expect(whole).toContain('FICTIONAL CREED');expect(whole).toContain('FICTIONAL TOP');expect(whole).not.toContain('handed to this body');expect(whole).not.toContain('- creed, preferences, top-of-mind:');
 // The description is one for a terminal and a body, and is true of both.
 expect(tools.find(tool=>tool.name==='identity')!.description).toContain('not repeated');
});

it('reads a stored denial as the entries a harness would take it for, in one place',()=>{
 // One stored string may hold several entries, apart by commas or spaces; brackets keep their own.
 expect(denialEntries('Read')).toEqual(['Read']);
 expect(denialEntries(' Read ')).toEqual(['Read']);
 expect(denialEntries('Bash,mcp__loom__loom_command')).toEqual(['Bash','mcp__loom__loom_command']);
 expect(denialEntries('Bash mcp__loom__loom_command')).toEqual(['Bash','mcp__loom__loom_command']);
 expect(denialEntries('Bash, Read\tWrite ,, Edit')).toEqual(['Bash','Read','Write','Edit']);
 expect(denialEntries('Bash(git commit:*), Read(a, b) Write')).toEqual(['Bash(git commit:*)','Read(a, b)','Write']);
 // Forms no harness would honour are still read without loss: an unclosed bracket runs to the end.
 expect(denialEntries('Bash(git commit Read')).toEqual(['Bash(git commit Read']);
 expect(denialEntries('a)b c')).toEqual(['a)b','c']);
 expect(denialEntries(' , ')).toEqual([]);
 // What a job's body is not given is those entries, each once: what a harness is handed needs no further splitting.
 const policy=(people:WorkerRunPolicy['people'])=>({people,deniedTools:[{pattern:'Bash, Read',guestsOnly:false},{pattern:'Read mcp__loom__forget',guestsOnly:true}]});
 expect(deniedTools(policy([]))).toEqual(['Bash','Read']);
 expect(deniedTools(policy([{kind:'unknown',person:null,tier:null}]))).toEqual(['Bash','Read','mcp__loom__forget']);
 expect(deniedTools(undefined)).toEqual([]);
});

it('denies every named tool in a room that is denied a generic tool, however the denial was written',()=>{
 const named=bodyNamedToolNames().map(name=>harnessToolPrefix+name);
 const denied=(...stored:string[])=>bodyDeniedTools(deniedTools({people:[],deniedTools:stored.map(pattern=>({pattern,guestsOnly:false}))}));
 expect(harnessToolPrefix).toBe('mcp__loom__');
 expect(denied('Bash','Write')).toEqual(['Bash','Write']);
 expect(denied('mcp__loom__remember')).toEqual(['mcp__loom__remember']);
 for(const pattern of ['mcp__loom__loom_command','mcp__loom__loom_query','mcp__loom__loom_*','mcp__loom__*','mcp__loom','mcp__*','mcp__loom__loom_command(*)',' mcp__loom__loom_query '])
  expect(denied('Bash',pattern),pattern).toEqual(expect.arrayContaining(['Bash',pattern.trim(),...named]));
 // Several entries in one stored string: with commas, with spaces, mixed, and beside a bracketed one.
 for(const stored of ['Bash,mcp__loom__loom_command','Bash mcp__loom__loom_command','Read, Bash(git commit:*) mcp__loom__loom_query,Write','Read,mcp__loom__loom_query(a, b)'])
  expect(denied(stored),stored).toEqual(expect.arrayContaining(named));
 expect(denied('Bash,mcp__loom__loom_command')).toEqual(['Bash','mcp__loom__loom_command',...named]);
 // A denial of loom_query alone takes the named tools; so does one of loom_command alone. Neither takes the other generic tool.
 expect(denied('mcp__loom__loom_query')).toEqual(['mcp__loom__loom_query',...named]);
 expect(denied('mcp__loom__loom_query')).not.toContain('mcp__loom__loom_command');
 expect(denied('mcp__loom__loom_command')).not.toContain('mcp__loom__loom_query');
 // loom_commands only lists; denying it, or one named tool, denies nothing else.
 expect(denied('mcp__loom__loom_commands')).toEqual(['mcp__loom__loom_commands']);
 expect(denied('Read,mcp__loom__forget')).toEqual(['Read','mcp__loom__forget']);
 expect(denied('mcp__loom__loom_command','mcp__loom__remember')).toEqual(['mcp__loom__loom_command','mcp__loom__remember',...named.filter(name=>name!=='mcp__loom__remember')]);
});

it('keeps a denial stored under the tools server\'s old name in force, in every form the store accepts',()=>{
 const named=bodyNamedToolNames().map(name=>harnessToolPrefix+name);
 const denied=(...stored:string[])=>bodyDeniedTools(deniedTools({people:[],deniedTools:stored.map(pattern=>({pattern,guestsOnly:false}))}));
 const every=['request_secret','use_secret','loom_commands','loom_command','loom_query',...bodyNamedToolNames()].map(name=>harnessToolPrefix+name);
 // The old entry stays as written (it names nothing now) and the tool it took away is named as it is called today.
 expect(denied('mcp__loom_secrets__use_secret')).toEqual(['mcp__loom_secrets__use_secret','mcp__loom__use_secret']);
 expect(denied('mcp__loom_secrets__request_secret(*)')).toEqual(['mcp__loom_secrets__request_secret(*)','mcp__loom__request_secret']);
 expect(denied('mcp__loom_secrets__loom_commands')).toEqual(['mcp__loom_secrets__loom_commands','mcp__loom__loom_commands']);
 // Past the first entry of a stored string, with commas and with spaces, beside the new name.
 expect(denied('Read,mcp__loom_secrets__use_secret')).toEqual(['Read','mcp__loom_secrets__use_secret','mcp__loom__use_secret']);
 expect(denied('Bash mcp__loom_secrets__loom_command')).toEqual(['Bash','mcp__loom_secrets__loom_command','mcp__loom__loom_command',...named]);
 expect(denied('Bash, mcp__loom__remember mcp__loom_secrets__loom_query')).toEqual(expect.arrayContaining(['mcp__loom__loom_query',...named]));
 expect(denied(' mcp__loom_secrets__loom_query ')).toEqual(['mcp__loom_secrets__loom_query','mcp__loom__loom_query',...named]);
 // The whole server, and every glob that reached it, whether or not it spells the old name out.
 for(const pattern of ['mcp__loom_secrets','mcp__loom_secrets__*','mcp__loom_secrets*','mcp__loom_sec*','mcp__loom_*','Read,mcp__loom_secrets'])
  expect(denied(pattern),pattern).toEqual(expect.arrayContaining(every));
 expect(denied('mcp__loom_secrets__use_*')).toEqual(['mcp__loom_secrets__use_*','mcp__loom__use_secret']);
 expect(denied('mcp__loom_secrets__loom_c*')).toEqual(expect.arrayContaining(['mcp__loom__loom_commands','mcp__loom__loom_command',...named]));
 // Another server whose name only begins the same way is not loom's.
 expect(denied('mcp__loom_secretsx__tool')).toEqual(['mcp__loom_secretsx__tool']);
 expect(denied('mcp__loom_secretsx')).toEqual(['mcp__loom_secretsx']);
});

it('takes the two generic tools\' names from where they are defined',()=>{
 // A named tool is made of these two. Were one renamed there and not found here, a body would get no named tools.
 expect(programToolDefinitions.map(([name])=>name)).toEqual(['loom_commands','loom_command','loom_query']);
 const g=generic();expect(bodyNamedTools({agent:'art',generic:g.tools}).length).toBe(bodyNamedToolNames().length);
});
