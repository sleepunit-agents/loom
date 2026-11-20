/** Read only counts and tool names from a completed harness stream. Diagnostics, tool
 * arguments, results and model text have no place in a usage report. */
import type { UsageReport } from './usage-report.js';

type Row = Record<string,unknown>;
const object=(value:unknown):Row=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
function malformedUsage(raw:unknown, keys:string[]):boolean {
 if(raw==null)return false;
 if(typeof raw!=='object'||Array.isArray(raw))return true;
 // Bound optional measurement separately even when the whole event stream fits in
 // the harness's ordinary output limit. Deeply nested unknown fields may not serialize.
 try { if(Buffer.byteLength(JSON.stringify(raw))>64*1024)return true; } catch { return true; }
 const usage=object(raw);
 return keys.some(key=>usage[key]!=null&&count(usage[key])===null);
}

function sum(values:(number|null)[]):number|null{
 if(!values.length||values.some(value=>value===null))return null;
 return count(values.reduce<number>((total,value)=>total+value!,0));
}
const inputSize=(usage:Row)=>sum([count(usage.input_tokens),count(usage.cache_read_input_tokens),count(usage.cache_creation_input_tokens)]);
function toolCounts(names:unknown[]){
 const tools:Record<string,number>=Object.create(null);
 for(const name of names){
  if(typeof name!=='string'||!/^[a-zA-Z0-9_.-]{1,200}$/.test(name))return {toolCalls:names.length,tools:null};
  tools[name]=(tools[name]??0)+1;
 }
 return {tools,toolCalls:names.length};
}

export function claudeUsage(rows:unknown[]):UsageReport{
 const messages=new Map<string,Row>(), tools=new Map<string,unknown>();
 let firstParentId: string | null | undefined;
 let firstContext:number|null=null;
 let sawAssistant=false, allMessages=true, allTools=true;
 for(const row of rows.map(object)){
  if(row.type!=='assistant')continue;
  sawAssistant=true;
  const message=object(row.message);
  // Stream order identifies the first parent call. A result's iterations may cover only its last response.
  if(row.parent_tool_use_id==null && !row.agent_id){
   const measured=!row.error && !row.aborted && message.model!=='<synthetic>' && typeof message.id==='string';
   if(firstParentId===undefined)firstParentId=measured ? message.id as string : null;
   if(measured && message.id===firstParentId)firstContext=inputSize(object(message.usage));
  }
  if(typeof message.id==='string')messages.set(message.id,object(message.usage));
  else allMessages=false;
  if(!Array.isArray(message.content)){allTools=false;continue;}
  for(const part of message.content.map(object)){
   if(part.type!=='tool_use'&&part.type!=='server_tool_use')continue;
   if(typeof part.id==='string')tools.set(part.id,part.name);
   else allTools=false;
  }
 }
 const rawUsage=rows.map(object).find(row=>row.type==='result')?.usage;
 const fields=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];
 if(malformedUsage(rawUsage,fields))return {source:'none'};
 const usage=object(rawUsage);
 const transcript=allMessages?[...messages.values()]:[];
 const reported=fields.some(key=>count(usage[key])!==null);
 const iterations=Array.isArray(usage.iterations)&&usage.iterations.every(iteration=>
  inputSize(object(iteration))!==null)?usage.iterations.map(object):[];
 // Some releases attach the last response's iterations to the aggregate. A stream
 // with more distinct messages is better evidence of the calls that actually ran.
 const turns=iterations.length>=transcript.length?iterations:transcript;
 if(!reported&&!turns.length&&!tools.size)return {source:'none'};
 const contexts=turns.map(inputSize);
 const measure=(key:string)=>count(usage[key])??sum(transcript.map(message=>count(message[key])));
 return {source:reported?'report':'transcript',
  tokensIn:inputSize(usage)??sum(transcript.map(inputSize)),tokensOut:measure('output_tokens'),
  cacheRead:measure('cache_read_input_tokens'),cacheWritten:measure('cache_creation_input_tokens'),
  ...(firstContext!==null && {firstContext}),
  modelCalls:turns.length||null,largestContext:contexts.length&&contexts.every(n=>n!==null)?contexts.reduce((maximum,size)=>Math.max(maximum,size),0):null,
  ...(sawAssistant&&allTools?toolCounts([...tools.values()]):{tools:null,toolCalls:null})};
}

// Codex exec's collab_tool_call.tool enum (0.162.1). Never persist prompts,
// receiver IDs, agent state or unfamiliar values from the event.
const collaborationTools = new Set(['spawn_agent', 'send_input', 'wait', 'close_agent']);
const collaborationLabels = new Set(['collab_tool_call', ...Array.from(collaborationTools, tool => 'collab_tool_call.' + tool),
 'collab_tool_call.spawn_agent.completed', 'collab_tool_call.spawn_agent.failed']);
function codexToolName(item: Row, event: unknown): unknown {
 if (item.type === 'mcp_tool_call') {
  const name = item.tool;
  return typeof name === 'string' && collaborationLabels.has(name)
   ? 'mcp_tool_call.' + name : name;
 }
 if (item.type !== 'collab_tool_call' || typeof item.tool !== 'string' || !collaborationTools.has(item.tool))
  return item.type;
 const name = 'collab_tool_call.' + item.tool;
 if (item.tool === 'spawn_agent' && event === 'item.completed' && (item.status === 'completed' || item.status === 'failed'))
  return name + '.' + item.status;
 return name;
}

export function codexUsage(rows:unknown[]):UsageReport{
 const events=rows.map(object);
 const rawUsage=events.find(row=>row.type==='turn.completed'||row.type==='turn.failed')?.usage;
 const fields=['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens'];
 if(malformedUsage(rawUsage,fields))return {source:'none'};
 const usage=object(rawUsage);
 const toolsById=new Map<string,unknown>();
 let complete=true, seenItem=false;
 for(const row of events){
  if(row.type!=='item.started'&&row.type!=='item.completed')continue;
  seenItem=true;
  const item=object(row.item);
  switch(item.type){
   case 'agent_message':case 'reasoning':case 'todo_list':case 'plan':break;
   case 'mcp_tool_call':
   case 'command_execution':case 'file_change':case 'web_search':case 'collab_tool_call':
    if(typeof item.id!=='string'||!item.id){complete=false;break;}
    toolsById.set(item.id,codexToolName(item,row.type));
    break;
   default:complete=false;
  }
 }
 const reported=fields.some(key=>count(usage[key])!==null);
 if(!reported&&!seenItem)return {source:'none'};
 return {source:reported?'report':'transcript',tokensIn:count(usage.input_tokens),
  tokensOut:count(usage.output_tokens),cacheRead:count(usage.cached_input_tokens),cacheWritten:count(usage.cache_write_input_tokens),
  modelCalls:null,largestContext:null,...(complete&&seenItem?toolCounts([...toolsById.values()]):{tools:null,toolCalls:null})};
}

export function agyUsage(rows:unknown[]):UsageReport{
 const events=rows.map(object);
 const result=object(events.find(row=>row.event==='result')?.result);
 const fields=['input_tokens','output_tokens','cache_read_tokens'];
 if(malformedUsage(result.usage,fields))return {source:'none'};
 const usage=object(result.usage);
 const reported=fields.some(key=>count(usage[key])!==null);
 const steps=events.filter(row=>row.event==='step_update').map(row=>object(row.step_update));
 const tools=steps.filter(step=>step.state==='DONE'&&step.step_type==='tool').map(step=>step.tool_name);
 if(!reported&&!steps.length)return {source:'none'};
 return {source:reported?'report':'transcript',tokensIn:count(usage.input_tokens),tokensOut:count(usage.output_tokens),
  cacheRead:count(usage.cache_read_tokens),cacheWritten:null,modelCalls:null,largestContext:null,
  ...(steps.length?toolCounts(tools):{toolCalls:null,tools:null})};
}

/** Even a nonzero exit may carry its measured end report. Read only the ordinary
 * bounded stream; no reply, diagnostic or unchecked object can escape here. */
export function failedReport(read:(rows:unknown[])=>UsageReport,sink?: (usage:UsageReport)=>void){
 if(!sink)return undefined;
 return (output:Buffer)=>{
  try{
   const decoder=new TextDecoder('utf-8',{fatal:true});
   const lastNewline=output.lastIndexOf(10);
   const rows=decoder.decode(output.subarray(0,lastNewline+1)).split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
   // A signal can interrupt the final record, including in the middle of a UTF-8 character.
   if(lastNewline+1<output.length){
    try{rows.push(JSON.parse(decoder.decode(output.subarray(lastNewline+1))));}catch{/* incomplete final record */}
   }
   const {source,...measures}=read(rows);
   // A partial stream can establish a tool ran, but silence does not establish
   // that none ran. Keep explicit token zeros from the harness untouched.
   if(measures.toolCalls===0){measures.toolCalls=null;measures.tools=null;}
   if(source!=='none'&&Object.values(measures).some(value=>value!=null))sink({source,...measures});
  }catch{/* An unreadable failure leaves unknown usage. */}
 };
}
