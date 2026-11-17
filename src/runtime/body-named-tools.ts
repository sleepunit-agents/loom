/** A body's named tools: remember, task_claim, note_read and the rest, as a terminal session has them.
 *
 * They come from the one definition (shared-mcp-named.ts) and from nowhere else. In a body, what that
 * definition sends to loom goes through the body's own two generic tools, loom_command and loom_query, as
 * bodyProgramTools made them. So a named tool here is one of those two under a plain name: it has the body's
 * credential and no other, is refused wherever they are refused, and reaches nothing they do not. A body
 * that lacks either generic tool is offered no named tool. */
import {registerNamedTools,type NamedToolPorts,type NamedToolRegistry} from '../shared-mcp-named.js';
import {BODY_SECRET_TOOLS,type BodyModelTool} from './body-model-tools.js';
import {programToolDefinitions} from './body-program-tools.js';
import {harnessToolPrefix} from './body-harness.js';

type Handler=Parameters<NamedToolRegistry['registerTool']>[2];
type Collected={name:string;description:string;inputSchema:BodyModelTool['inputSchema'];handler:Handler};
/** The two generic tools a named tool is made of, by the names they are defined with. */
const [,[COMMAND],[QUERY]]=programToolDefinitions;
/** The tools server as a denial names it, and as one named it before the server was renamed. A stored
 * denial may still be written the old way. */
const server=harnessToolPrefix.slice(0,-2),formerServer='mcp__loom_secrets';

function collect(ports:NamedToolPorts):Collected[]{
 const tools:Collected[]=[];
 registerNamedTools({registerTool:(name,config,handler)=>{tools.push({name,description:config.description,inputSchema:config.inputSchema,handler});}},ports);
 return tools;
}
const nobody:NamedToolPorts={valid:()=>false,query:async()=>({errors:[{}]}),command:async()=>({ok:false})};
let names:readonly string[]|undefined;
/** The names of the named tools, in the definition's order. */
export function bodyNamedToolNames():readonly string[]{return names??=Object.freeze(collect(nobody).map(tool=>tool.name));}

/** What a generic tool answered, as the value it carried. One that could not say what happened carried no
 * value, and the named tool then cannot say either. */
function carried(result:Awaited<ReturnType<BodyModelTool['execute']>>):unknown{
 if(result.content.length!==1)throw new Error('Body tool unavailable');
 return JSON.parse(result.content[0].text);
}
/** `identityHanded` says the body was given its identity in its first words (body-program.ts): `identity`
 * then does not repeat it. Left out, nothing is taken as handed. */
export function bodyNamedTools(input:{agent:string;generic:readonly BodyModelTool[];identityHanded?:boolean}):BodyModelTool[]{
 const command=input.generic.find(tool=>tool.name===COMMAND)?.execute,query=input.generic.find(tool=>tool.name===QUERY)?.execute;
 if(!input.agent||!command||!query)return [];
 // Each call gets handlers on ports bound to its own signal, so cancelling the call cancels its requests.
 const ports=(signal:AbortSignal):NamedToolPorts=>({agent:input.agent,identityHanded:input.identityHanded===true,valid:()=>!signal.aborted,
  command:async(operation,payload,id)=>carried(await command({operation,input:payload,id},signal)),
  query:async request=>{const result=await query({query:request.query,...(request.variables?{variables:request.variables}:{})},signal);if(result.isError)throw new Error('Body tool unavailable');return carried(result) as Awaited<ReturnType<NamedToolPorts['query']>>;}});
 return collect(nobody).map(({name,description,inputSchema})=>({name,description,inputSchema,
  execute:(args:Record<string,unknown>,signal:AbortSignal)=>collect(ports(signal)).find(tool=>tool.name===name)!.handler(args)}));
}

/** Whether one denial entry (harness-traits.ts, denialEntries) takes away the tool with this full name. The
 * name itself does; so does its server's name alone (`mcp__loom`: every tool of it); and `*` stands for any
 * run of characters. This errs towards yes: an entry that narrows a tool to some inputs (`tool(...)`) counts
 * as the whole tool. Saying yes too often only denies a tool that might have been allowed. */
function covers(entry:string,tool:string):boolean{
 const pattern=entry.replace(/\([^]*$/,'').trim();
 if(pattern===tool||tool.startsWith(pattern+'__')&&(pattern===server||pattern===formerServer))return true;
 if(!pattern.includes('*'))return false;
 return new RegExp('^'+pattern.split('*').map(part=>part.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(tool);
}
/** What a harness is told a body is not given, from the entries the job's room carries (deniedTools). Every
 * tool of loom's that an entry takes away is added by the name it is called today, so what the harness
 * does with a `*`, or with a name it no longer knows, does not matter:
 *  - An entry written under the tools server's former name takes away the tool it took away then. So a
 *    rule an owner stored before the rename still applies, whole server and `*` forms included.
 *  - A room denied loom_command or loom_query is denied every named tool: each is one of those two under
 *    another name, and would otherwise do what the room was denied.
 * The entries themselves are handed on as they are. */
export function bodyDeniedTools(entries:readonly string[]):string[]{
 const denied=(tool:string)=>entries.some(entry=>covers(entry,server+'__'+tool)||covers(entry,formerServer+'__'+tool));
 const named=bodyNamedToolNames(),all=denied(COMMAND)||denied(QUERY);
 const taken=[...BODY_SECRET_TOOLS,...programToolDefinitions.map(([name])=>name),...named].filter(tool=>denied(tool)||all&&named.includes(tool));
 return [...new Set([...entries,...taken.map(tool=>harnessToolPrefix+tool)])];
}
