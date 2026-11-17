/** A body's named tools: the terminal's one definition, on the body's own generic tools. No loom here;
 * body-named-tools.integration.test.ts runs the same tools against a started loom. */
import {createRequire} from 'node:module';
import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/server';
import {registerNamedTools} from '../shared-mcp-named.js';
import {bodyDeniedTools,bodyNamedToolNames,bodyNamedTools} from './body-named-tools.js';
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
 const tools=bodyNamedTools({agent:'art',generic:g.tools});
 const core=(await call(tools,'identity',{project:'pond'})).content[0].text;
 expect(core).toContain('Agent: art');expect(core).toContain('FICTIONAL PROJECT PAGE');expect(core).toContain('# Pieces');expect(core).toContain('handed to this body when it started');
 expect(core).not.toContain('FICTIONAL CREED');expect(core).not.toContain('FICTIONAL PREFERENCES');expect(core).not.toContain('FICTIONAL TOP');
 expect(asked[0]).not.toMatch(/\b(creed|preferences|topOfMind)\b/);
 // A piece asked for by name is returned as asked.
 const creed=(await call(tools,'identity',{piece:'creed'})).content[0].text;expect(creed).toContain('FICTIONAL CREED');
 expect((await call(tools,'identity',{piece:'self-model'})).content[0].text).toContain('FICTIONAL SELF');
 expect((await call(tools,'identity',{agent:'mark'})).isError).toBe(true);
});

it('denies every named tool in a room that is denied a generic tool, and reads a rule written under the old server name',()=>{
 const named=bodyNamedToolNames().map(name=>harnessToolPrefix+name);
 expect(harnessToolPrefix).toBe('mcp__loom__');
 expect(bodyDeniedTools(['Bash','Write'])).toEqual(['Bash','Write']);
 expect(bodyDeniedTools(['mcp__loom__remember'])).toEqual(['mcp__loom__remember']);
 for(const pattern of ['mcp__loom__loom_command','mcp__loom__loom_query','mcp__loom__loom_*','mcp__loom__*','mcp__loom','mcp__*'])
  expect(bodyDeniedTools(['Bash',pattern]),pattern).toEqual(['Bash',pattern,...named]);
 // Written loosely, it still counts.
 expect(bodyDeniedTools([' mcp__loom__loom_command(*)'])).toEqual([' mcp__loom__loom_command(*)',...named]);
 // loom_commands only lists; denying it denies nothing else.
 expect(bodyDeniedTools(['mcp__loom__loom_commands'])).toEqual(['mcp__loom__loom_commands']);
 // Rules stored before the server was renamed.
 expect(bodyDeniedTools(['mcp__loom_secrets__use_secret'])).toEqual(['mcp__loom__use_secret']);
 expect(bodyDeniedTools(['mcp__loom_secrets'])).toEqual(['mcp__loom',...named]);
 expect(bodyDeniedTools(['mcp__loom_secrets__*','mcp__loom__*'])).toEqual(['mcp__loom__*',...named]);
 expect(bodyDeniedTools(['mcp__loom_secrets__loom_command'])).toEqual(['mcp__loom__loom_command',...named]);
 expect(bodyDeniedTools(['mcp__loom_secretsx__tool'])).toEqual(['mcp__loom_secretsx__tool']);
 expect(bodyDeniedTools([' mcp__loom_secrets__loom_query '])).toEqual([' mcp__loom__loom_query ',...named]);
 expect(bodyDeniedTools(['mcp__loom__loom_command','mcp__loom__remember'])).toEqual(['mcp__loom__loom_command','mcp__loom__remember',...named.filter(name=>name!=='mcp__loom__remember')]);
});
