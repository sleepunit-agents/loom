/** One declaration drives CLI grammar and registry metadata. No client-side clock state. */
import type { CliCommand } from '../../core/index.js';
const fields = (...names: string[]) => Object.fromEntries(names.map(name => [name, name]));
const work = fields('prompt', 'prompt-file', 'note', 'model', 'slot');
export const clockCommands: CliCommand[] = [
  ...['at','in'].map(name => ({ name, write: true, positional: ['time'], flags: { ...work, ...fields('continuation','approval','place') } })),
  { name: 'park', write: true, flags: { ...fields('on','prompt','note','model','slot') } },
  { name: 'list' }, { name: 'log', flags: fields('since','grep') },
  { name: 'cancel', write: true, positional: ['id'] },
  ...['pause','resume','now','rearm'].map(name => ({ name, write: true, flags: name === 'now' ? fields('note') : {} })),
  ...['set','rm','list','run'].map(action => ({ name: `schedule ${action}`, write: action !== 'list', positional: action === 'list' ? [] : ['name'], flags: action === 'set' ? { ...work, ...fields('at','days') } : action === 'run' ? fields('note') : {} })),
  ...['set','assign','rm','list','text'].map(action => ({ name: `lane ${action}`, write: !['list','text'].includes(action), positional: action === 'list' ? [] : ['name'], flags: action === 'set' ? { ...work, ...fields('agent','at','days','local','no-local') } : action === 'assign' ? fields('agent') : {} })),
  ...['vouch','ask-vouch','relay','relays','run','reap','fire','bundle','api','ui'].map(name => ({ name })),
];
export const clockOperationCommands: Record<string,string> = {
  at:'at', in:'in', park:'park', list:'list', log:'log', cancel:'cancel', pause:'pause', resume:'resume', now:'now', rearm:'rearm',
  scheduleSet:'schedule set', scheduleRemove:'schedule rm', schedules:'schedule list', scheduleRun:'schedule run',
  laneSet:'lane set', laneAssign:'lane assign', laneRemove:'lane rm', lanes:'lane list', laneText:'lane text',
};
export const clockHelp = `usage: wake [--agent AGENT] <${[...new Set(clockCommands.map(c => c.name.split(' ')[0]))].join('|')}> ...\n`;
/** argparse accepts nested options before or after the action. Preserve their order. */
export function commandHead(argv: readonly string[]): { name: string | undefined; args: string[] } {
  const args = [...argv], group = args.shift();
  if (group !== 'schedule' && group !== 'lane') return { name:group, args };
  for (let n=0;n<args.length;n++) {
    const arg=args[n];
    if (!arg.startsWith('-')) { const action=args.splice(n,1)[0]; return {name:`${group} ${action}`,args}; }
    if (arg === '--') break;
    if (!arg.includes('=') && !['--local','--no-local'].includes(arg)) n++;
  }
  return {name:group,args};
}
