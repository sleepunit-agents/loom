/** The legacy command grammar and human text are a daemon binding to scoped operations. */
import { randomUUID } from 'node:crypto';
import type { Operations, Viewer } from '../../core/index.js';
import { clockCommands, clockOperationCommands, clockHelp, commandHead, clockOption } from './commands.js';
import { parseIn, timeZone } from './time.js';
import { active, type Wake, type Schedule } from './store.js';
export interface ClockCommandInput { argv: string[]; agent?: string; laneFile?: { path: string; text: string } }
export interface CommandAnswer { exit: number; stdout: string; stderr: string }
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
export function clockTime(epoch: number) { const p = Object.fromEntries(formatter.formatToParts(epoch).map(p => [p.type,p.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; }
const scheduleName = (id: string, agent: string) => id.startsWith(`${agent}/`) ? id.slice(agent.length+1) : id.startsWith('lane/') ? id.slice(5) : id;
const when = (s: Schedule) => {
  const at = s.at.map(t => { const [h,m] = t.split(':').map(Number); return `${h%12 || 12}:${String(m).padStart(2,'0')} ${h>=12 ? 'PM' : 'AM'}`; }).join(', ');
  const named: Record<string,string> = {'mon-fri':'Weekdays','sat,sun':'Weekends','sat-sun':'Weekends'};
  return !s.days ? `${at} daily` : `${named[s.days] ?? s.days.split(',').map(d=>d[0].toUpperCase()+d.slice(1)).join(', ')} ${at}`;
};
const moved = 'wake: relays moved to loom\'s runtime: use the relay tool (to, say, why?, reply_to?, from?, approval?), or from a house: loom runtime relay --to <agent> --say "…" [--reply-to r-…] [--approval a-…]; loom runtime relays lists them\n';
export function command(ops: Operations, viewer: Viewer, request: ClockCommandInput): CommandAnswer {
  const fail = (message: string, exit = 1): CommandAnswer => ({ exit, stdout:'', stderr: message.startsWith('wake:') ? message+'\n' : `wake: ${message}\n` });
  const success = (text: string): CommandAnswer => ({ exit:0, stdout:text.endsWith('\n') ? text : text+'\n', stderr:'' });
  const parsed=parseCommand(viewer,request);
  if('reply' in parsed)return parsed.reply;
  const {agent,name,operation,flags,positional,timed}=parsed;
  const input: Record<string,unknown> = {};
  if (name === 'vouch' || name === 'ask-vouch') input.target = `${agent}:${[...new Set(positional)].sort().join(',')}`;
  for (const key of ['note','model','slot','continuation','approval','place','on','days','at']) if (flags[key] !== undefined) input[key] = flags[key];
  if (timed) input.when = positional.join(name === 'in' ? '' : ' ');
  if (['at','in','park','schedule set'].includes(name!)) {
    if (!(timed && flags.approval && !flags.prompt && !flags['prompt-file']) && !!flags.prompt === !!flags['prompt-file']) return fail('give exactly one of --prompt/-p or --prompt-file/-f');
    input.agent = agent; if (!timed || !flags.approval) input.note ??= '';
    if (flags.prompt) input.prompt = flags.prompt; else if (flags['prompt-file']) input.file = flags['prompt-file'];
  }
  if (name === 'schedule run') input.note ??= '';
  if (name === 'park' && !flags.on) return fail('park needs --on',2);
  if (['pause','resume','now'].includes(name!)) input.agent = agent;
  if (name === 'list') input.agent = agent;
  if (name === 'cancel') {
    const list=ops.call('direct',viewer,'clock.list',{agent});
    if (!list.ok) return fail(list.message);
    if (!(list.value as Wake[]).some(w => w.id===positional[0] && w.agent===agent && active(w))) return fail(`no spool entry ${positional[0]}`);
    input.id = positional[0];
  }
  if (name?.startsWith('schedule ') && name !== 'schedule list') {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(positional[0])) return fail("a schedule's name is lowercase letters, digits and dashes, like nightly");
    const found = ops.call('direct',viewer,'clock.schedules',{});
    if (!found.ok) return fail(found.message);
    const rows = found.value as Schedule[];
    const candidates=rows.filter(s => s.agent===agent && scheduleName(s.id,agent!)===positional[0]);
    if (candidates.length>1) return fail('schedule name is ambiguous; use its exact id in the Clock app');
    input.id = candidates[0]?.id ?? `${agent}/${positional[0]}`;
  }
  if (name?.startsWith('lane ') && positional.length) input.name = positional[0];
  if (name === 'lane set' || name === 'lane assign') {
    if (flags.agent !== undefined) input.agent = flags.agent;
    if (name === 'lane set') {
      if (flags.prompt && flags['prompt-file']) return fail("a lane's text is --prompt/-p or --prompt-file/-f, not both");
      if (flags.prompt !== undefined) input.text = flags.prompt;
      if (flags['prompt-file']) {
        if (!request.laneFile || request.laneFile.path !== flags['prompt-file']) return fail('lane file contents must be supplied by the client');
        input.text = request.laneFile.text; input.source = request.laneFile.path;
      }
      if (flags.local && flags['no-local']) return fail('choose --local or --no-local',2);
      if (flags.local || flags['no-local']) input.local = !!flags.local;
    }
  } else if (request.laneFile) return fail('unexpected lane file contents');
  if (name === 'log') {
    try { input.since = 2*ops.clock.now()-parseIn(String(flags.since ?? '24h'),ops.clock.now()); }
    catch (e) { return fail((e as Error).message); }
  }
  const read = (verb: string, data: object = {}) => ops.call('direct',viewer,`clock.${verb}`,data);
  const previous = ['pause','resume'].includes(name!) ? read('status',{agent}) : undefined;
  if (previous && !previous.ok) return fail(previous.message);
  if (flags.standing && !flags.approval) return fail('--standing needs its saved --approval');
  if (timed && (flags.approval || String(flags.prompt ?? '').includes('<!-- house: local -->'))) {
    if (['model','slot','continuation','place','prompt-file'].some(key=>flags[key]!==undefined)) return fail('Local work uses only its exact saved prompt and note, without file, model, slot, continuation or place');
    const recovered=!!flags.approval;
    const result=ops.call('direct',viewer,recovered?'clock.recoverLocal':'clock.requestLocal',
      recovered?{...input,mode:name,...(flags.standing?{standing:true}:{})}:{agent,prompt:input.prompt,note:input.note},randomUUID());
    if(!result.ok)return fail(result.message);
    const ack=result.value as {id:string;state?:string;due?:number};
    return success(recovered?`${ack.id} will wake at ${clockTime(ack.due!)}`:`${ack.id}: asked in the owner's signed-in window (${ack.state}); nothing armed`);
  }
  // Nested calls share the command's outer registry transaction and retry receipt.
  const result = ops.call('direct',viewer,`clock.${operation}`,input,randomUUID());
  if (!result.ok) return fail(result.message);
  const value = result.value;
  if (timed) {
    const w = value as Wake & { alreadyScheduled?: boolean; schedule: string };
    return success(w.alreadyScheduled ? `already scheduled: ${scheduleName(w.schedule,agent!)}, next at ${clockTime(w.due)} (nothing armed)` : `${w.id} will wake at ${clockTime(w.due)}`);
  }
  if (name === 'ask-vouch') {
    const card = result.value as {id:string; state:string};
    return success(`${card.id}: asked the owner on loom's page; his Allow counts eligible jobs as his work (${card.state})`);
  }
  if (name === 'vouch') {
    const {done,gone} = value as {done:string[];gone:string[]};
    return success(`vouched for ${done.join(' ')}: ${done.length === 1 ? 'it fires' : 'they fire'} as the owner's${gone.length ? `\nunchanged: ${gone.join(' ')}` : ''}`);
  }
  if (name === 'park') { const w = value as Wake; return success(`${w.id} parked on ${w.wait!.id}: it wakes when the owner answers (checked every 5 minutes; 24h at most). End this session now.`); }
  if (name === 'cancel') { const w = value as Wake; return success(w.state === 'cancelled' ? `cancelled ${w.id}` : `${w.id}: ${w.outcome ?? w.state}`); }
  if (name === 'now') return success(`${(value as Wake).id}: ${agent} wakes within a minute`);
  if (name === 'pause') return success((previous!.ok && (previous!.value as {paused:boolean}).paused) ? `${agent}'s clock is already paused` : `paused ${agent}'s clock: wakes that come due are held until resume`);
  if (name === 'resume') { const n = (value as {released:number}).released; return success(previous!.ok && !(previous!.value as {paused:boolean}).paused ? `${agent}'s clock isn't paused` : `resumed ${agent}'s clock${n ? `: ${n} held wake${n === 1 ? '' : 's'} fire from a minute from now` : ''}`); }
  if (name === 'list') {
    const rows = (value as Wake[]).filter(active).sort((a,b) => a.due-b.due || a.id.localeCompare(b.id));
    if (!rows.length) return success('no pending wakes');
    return success(rows.map(w => { const m = Math.floor((w.due-ops.clock.now())/60000); const rel = m>=1440 ? `${Math.floor(m/1440)}d${Math.floor(m%1440/60)}h` : m>=60 ? `${Math.floor(m/60)}h${String(m%60).padStart(2,'0')}m` : `${m}m`; return `${w.id}  ${clockTime(w.due)}  (in ${rel})  [${w.state === 'pending' ? w.schedule ? 'schedule' : 'wake' : w.state}]  ${w.schedule ? `schedule ${scheduleName(w.schedule,w.agent)}${w.schedule.startsWith('lane/') ? ': loom lane' : ''}${w.note ? `: ${w.note}` : ''}` : w.note || w.file || w.prompt?.slice(0,50) || ''}`; }).join('\n'));
  }
  if (name === 'log') return success((value as Array<{at:number;kind:string;note:string;outcome?:string;agent:string}>).filter(r => r.agent === agent).map(r => `${clockTime(r.at)} ${r.kind} ${r.outcome ?? r.note}`).filter(line => !flags.grep || line.includes(String(flags.grep))).slice(-2000).join('\n'));
  if (name === 'schedule rm') return success(`removed schedule ${positional[0]}`);
  if (name === 'schedule run') return success(`${(value as Wake).id}: ${positional[0]} runs within a minute`);
  if (name === 'lane rm') return success(`removed schedule ${positional[0]}\nremoved loom lane ${positional[0]}`);
  if (name === 'lane text') return success((value as {text:string}).text);
  if (name === 'lane list') { const rows = value as Schedule[]; return success(rows.length ? rows.sort((a,b)=>a.id.localeCompare(b.id)).map(s => `${s.lane!.padEnd(22)} ${s.agent.padEnd(8)} ${when(s).padEnd(18)} ${[...s.laneDetails!.text].length} chars${s.laneDetails!.local ? ' local' : ''}${s.note ? `  — ${s.note}` : ''}`).join('\n') : 'no loom lanes'); }
  if (name === 'schedule list') {
    const rows = (value as Schedule[]).filter(s => s.agent === agent);
    const pending = read('list',{agent}); if (!pending.ok) return fail(pending.message);
    return success(rows.length ? rows.sort((a,b)=>a.id.localeCompare(b.id)).map(s => { const next = (pending.value as Wake[]).filter(w=>w.schedule===s.id && w.state==='pending').sort((a,b)=>a.due-b.due)[0]; return `${scheduleName(s.id,agent!).padEnd(22)} ${when(s).padEnd(18)} next ${next ? clockTime(next.due) : '(none armed)'}  ${s.file || s.prompt?.slice(0,50) || ''}${s.note ? `  — ${s.note}` : ''}`; }).join('\n') : `${agent} has no schedules`);
  }
  const confirmation = (s: Schedule, label: string) => {
    const pending = read('list',{agent:s.agent});
    if (!pending.ok) throw Error(pending.message);
    const next = (pending.value as Wake[]).find(w=>w.schedule===s.id && w.state==='pending')!;
    return `schedule ${label}: next at ${clockTime(next.due)} (${next.id})`;
  };
  if (name === 'schedule set') return success(confirmation(value as Schedule,positional[0]));
  if (name === 'lane set' || name === 'lane assign') {
    const s = value as Schedule;
    return success(`${confirmation(s,s.lane!)}\nloom lane ${s.lane}: ${s.agent[0].toUpperCase()+s.agent.slice(1)}'s, ${when(s)}${s.laneDetails!.local ? " (on loom's machine)" : ''}`);
  }
  return success('clock deadlines rearmed');
}

/** The same pure parse governs execution and acknowledgement replay policy. */
function parseCommand(viewer:Viewer,request:ClockCommandInput) {
  const fail=(message:string,exit=1)=>({reply:{exit,stdout:'',stderr:message.startsWith('wake:')?message+'\n':`wake: ${message}\n`}});
  const success=(text:string)=>({reply:{exit:0,stdout:text,stderr:''}});
  const argv = [...request.argv];
  let agent = request.agent ?? (viewer.kind === 'agent' ? viewer.id : undefined);
  // The old global --agent precedes the verb; lane's --agent is its assignee.
  if (argv[0] === '--agent') { agent = argv[1]; argv.splice(0,2); }
  else if (argv[0]?.startsWith('--agent=')) agent = argv.shift()!.slice(8);
  if (argv[0] === '--help' || argv[0] === '-h') return success(clockHelp);
  const head = commandHead(argv), name = head.name; argv.splice(0,argv.length,...head.args);
  if (name === 'relay' || name === 'relays') return {reply:{ exit:1, stdout:'', stderr:moved }};
  const spec = clockCommands.find(c => c.name === name);
  if (!spec) return fail(clockHelp.trimEnd(), 2);
  const operation = Object.keys(clockOperationCommands).find(key => clockOperationCommands[key] === name);
  if (!operation) return fail(`${name} is not available on the new clock; ${['vouch','ask-vouch'].includes(name!) ? 'provenance adoption is not implemented yet' : 'use the daemon, runtime, registered Clock app or core migration instead'}`);
  const flags: Record<string,string | boolean> = Object.create(null), positional: string[] = [];
  for (let n=0; n<argv.length; n++) {
    const arg = argv[n];
    if (arg === '--') { positional.push(...argv.slice(n+1)); break; }
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const option=clockOption(arg), flag=option?.flag;
    if (!flag || !Object.hasOwn(spec.flags ?? {}, flag)) return fail(`unrecognized arguments: ${arg}`,2);
    if (flag === 'local' || flag === 'no-local' || flag === 'standing') { if (option!.attached !== undefined) return fail(`${arg}: does not take a value`,2); flags[flag] = true; continue; }
    const value = option!.attached ?? argv[++n];
    if (value === undefined || option!.attached === undefined && value.startsWith('-')) return fail(`argument ${arg}: expected one argument`,2);
    flags[flag] = value;
  }
  const count = spec.positional?.length ?? 0, timed = name === 'at' || name === 'in', variadic = timed || name === 'vouch' || name === 'ask-vouch';
  if (positional.length < count || !variadic && positional.length > count) return fail(`expected ${timed ? 'a time or duration' : count ? spec.positional!.join(', ') : 'no positional arguments'}`,2);
  if (!agent && !name?.startsWith('lane ' ) && name !== 'rearm') return fail('select a clock with --agent or WAKE_AGENT');
  return {agent,name:spec.name,operation,flags,positional,timed};
}
export function localCommandInput(viewer:Viewer,request:ClockCommandInput):{agent:string;approval?:string;standing?:boolean}|undefined {
 const parsed=parseCommand(viewer,request);if('reply' in parsed)return;
 const {agent,name,flags}=parsed;if(!['at','in'].includes(name))return;
 if(!flags.approval&&!String(flags.prompt??'').includes('<!-- house: local -->'))return;
 return {agent:agent??'',...(typeof flags.approval==='string'?{approval:flags.approval}:{}),...(flags.standing?{standing:true}:{})};
}
/** Replay of an ordinary creation command must recheck the same filing policy. */
export function oneOffCommandInput(viewer:Viewer,request:ClockCommandInput):{agent:string;note:string;on?:string}|undefined {
 const parsed=parseCommand(viewer,request);if('reply' in parsed)return;
 const {agent,name,flags}=parsed;if(!['at','in','park'].includes(name))return;
 return {agent:agent??'',note:'',...(name==='park'&&typeof flags.on==='string'?{on:flags.on}:{})};
}
