/** Read only counts and tool names from a completed harness stream. Diagnostics, tool
 * arguments, results and model text have no place in a usage report. */
import type { UsageReport } from './usage-report.js';

type Row = Record<string,unknown>;
const object=(value:unknown):Row=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
function malformedUsage(raw:unknown, keys:string[]):boolean {
 if(raw==null)return false;
 if(typeof raw!=='object'||Array.isArray(raw))return true;
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
 let allMessages=true, allTools=true;
 for(const row of rows.map(object)){
  if(row.type!=='assistant')continue;
  const message=object(row.message);
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
 const iterations=Array.isArray(usage.iterations)?usage.iterations.map(object):[];
 // Some releases attach the last response's iterations to the aggregate. A stream
 // with more distinct messages is better evidence of the calls that actually ran.
 const turns=iterations.length>=transcript.length?iterations:transcript;
 if(!reported&&!turns.length&&!tools.size)return {source:'none'};
 const contexts=turns.map(inputSize);
 const measure=(key:string)=>count(usage[key])??sum(transcript.map(message=>count(message[key])));
 return {source:reported?'report':'transcript',
  tokensIn:inputSize(usage)??sum(transcript.map(inputSize)),tokensOut:measure('output_tokens'),
  cacheRead:measure('cache_read_input_tokens'),cacheWritten:measure('cache_creation_input_tokens'),
  modelCalls:turns.length||null,largestContext:contexts.length&&contexts.every(n=>n!==null)?Math.max(...contexts):null,
  ...(allTools?toolCounts([...tools.values()]):{tools:null,toolCalls:null})};
}

export function codexUsage(rows:unknown[]):UsageReport{
 const events=rows.map(object);
 const rawUsage=events.find(row=>row.type==='turn.completed')?.usage;
 const fields=['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens'];
 if(malformedUsage(rawUsage,fields))return {source:'none'};
 const usage=object(rawUsage);
 const names:unknown[]=[];
 let complete=true, seenItem=false;
 for(const row of events){
  if(row.type!=='item.completed')continue;
  seenItem=true;
  const item=object(row.item);
  switch(item.type){
   case 'agent_message':case 'reasoning':case 'todo_list':case 'plan':break;
   case 'mcp_tool_call':names.push(item.tool);break;
   case 'command_execution':case 'file_change':case 'web_search':case 'collab_tool_call':names.push(item.type);break;
   default:complete=false;
  }
 }
 const reported=fields.some(key=>count(usage[key])!==null);
 if(!reported&&!seenItem)return {source:'none'};
 return {source:reported?'report':'transcript',tokensIn:count(usage.input_tokens),
  tokensOut:count(usage.output_tokens),cacheRead:count(usage.cached_input_tokens),cacheWritten:count(usage.cache_write_input_tokens),
  modelCalls:null,largestContext:null,...(complete&&seenItem?toolCounts(names):{tools:null,toolCalls:null})};
}
