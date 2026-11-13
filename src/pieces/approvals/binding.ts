/** Compatibility grammar and text live beside the daemon operations, never in the client. */
import { randomUUID } from 'node:crypto';
import type { Operations, Viewer } from '../../core/index.js';
import { approvalCommands } from './commands.js';
import type { Approval, Notice } from './model.js';
import { repoOf } from './targets.js';
/** Python json.dumps defaults are part of the existing CLI contract. */
function legacyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(legacyJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([key,v])=>`${legacyJson(key)}: ${legacyJson(v)}`).join(', ')}}`;
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
}
export interface CommandAnswer { exit:number;stdout:string;stderr:string }
export function command(operations:Operations,viewer:Viewer,argv:string[]):CommandAnswer {
  const fail=(message:string):CommandAnswer=>({exit:1,stdout:'',stderr:`approvals: ${message}\n`});
  const verb=argv[0],spec=approvalCommands.find(c=>c.name===verb);
  if(!spec)return fail('request | check | use | withdraw | standing | list | rule | tell | grant');
  const positional:string[]=[],input:Record<string,unknown>={},boolean=new Set(['json','deny']);
  for(let n=1;n<argv.length;n++){
    const arg=argv[n];
    if(!arg.startsWith('--')){positional.push(arg);continue;}
    const [flag,...equal]=arg.slice(2).split('=');
    if(flag!=='principal'&&!Object.hasOwn(spec.flags??{},flag))return fail(`usage: unrecognized arguments: --${flag}`);
    if(boolean.has(flag)){if(equal.length)return fail(`usage: --${flag} takes no value`);input[flag]=true;continue;}
    const value=equal.length?equal.join('='):argv[++n];if(value===undefined)return fail(`usage: --${flag} expected one argument`);
    input[flag.replaceAll('-','_')]=value;
  }
  if(input.as!==undefined)return fail('--as is for a piece acting for a body, not over the API');
  if(input.on_behalf!==undefined)return fail('--on-behalf is for a piece acting for a body (--as)');
  if(input.for!==undefined&&verb==='rule')return fail('--for is for the Changes piece, not over the API');
  if(verb==='grant'&&viewer.kind!=='member')return fail("grant is the owner's, on loom's machine; a body asks with request");
  if(verb==='list'&&viewer.kind!=='member')return fail("the list is the owner's, on loom's machine");
  if(verb==='standing')return fail("standing is for the clock on loom's machine, acting for a body (--as)");
  if(verb==='rule'){input.kind=positional[0];input.targets=positional.slice(1);}
  else if(spec.positional?.includes('id')){if(positional.length!==1)return fail('usage: an approval id is required');input.id=positional[0];}
  else if(positional.length)return fail('usage: unexpected positional argument');
  const result=operations.call('direct',viewer,`approvals.${verb}`,input,`approvals-cli:${randomUUID()}`);
  if(!result.ok)return fail(result.message);
  const value=result.value as any; // Each operation already validates its result; this is the compatibility formatter.
  let out='';let stderr='';
  if(verb==='request'){
    const a=value as Approval;
    out=a.state==='denied'?`${a.id}: the owner said not yet for this exact change and head; a new push asks again`
      :a.state==='allowed'&&['grant','vouch-wake','principal-reset','box-write-off'].includes(a.kind)?`${a.id}: the owner allowed it; the piece that filed it applies it (use it there: --kind ${a.kind})`
      :a.state==='allowed'?`${a.id}: already allowed (until ${a.expires}); use it: approvals use ${a.id} --kind ${a.kind} --target '${a.target}'`
      :`${a.id}: asked the owner (a card on loom's Home); check it: approvals check ${a.id}`;
  } else if(verb==='check')out=input.json?legacyJson(value):value.state;
  else if(verb==='use')out=`${input.id}: used`;
  else if(verb==='withdraw')out=`${input.id}: withdrawn`;
  else if(verb==='grant')out=`${value.id}: ${value.state}`;
  else if(verb==='list')out=(value.approvals as Approval[]).slice(0,30).map(a=>`${a.id} ${a.state.padEnd(8)} ${a.kind} ${a.target} — ${a.who.agent}: ${a.what}`).join('\n');
  else if(verb==='rule'){
    if(input.json)out=legacyJson(value);
    else {const targets=input.targets as string[];out=targets.map(t=>{const r=value[t];return r.tier+(r.tier==='ask'&&r.approval?` ${r.approval.state} ${r.approval.id}`:'')+(targets.length===1?'':`  ${t}`);}).join('\n');}
    stderr=[...new Set(Object.values(value).flatMap((r:any)=>r.note?[`approvals: ${r.note}\n`]:[]))].join('');
  } else if(verb==='tell'){
    const n=value as Notice,r=repoOf(n.target),agent=n.agent[0].toUpperCase()+n.agent.slice(1);
    const whose=n.for&&n.for!=='owner'?` for ${n.for.split('-').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')}`:'';
    out=`told the owner: ${agent} merged ${r?`${r.locator}#${r.number}`:n.target.split('@')[0]}${whose}`;
  }
  return {exit:0,stdout:out?out+'\n':'',stderr};
}
