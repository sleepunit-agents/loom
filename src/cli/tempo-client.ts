import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { DOOR_REQUEST_BYTES } from '../core/data/door-limit.js';
import { MESSAGE_WORDS_MAX } from '../core/conversations/words.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { datedWake, HH_MM, nextTime } from '../core/tempo/calendar.js';
import { laneFile } from '../core/tempo/lane-file.js';
import { DAY, DAY_MS } from '../core/day.js';
import { onOneLine } from '../core/line-name.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { doorConnection } from './connection.js';
import { parseRedactedJSON } from '../pieces/changes/redact.js';
import type { IOStreams } from './io.js';

const pageSize = 100;
class DoorRefusal extends Error {}
const pending = z.object({
  id: z.string(), nextDueAt: z.string().datetime().nullable(), sourceKind: z.string(), lifespan: z.string(),
  note: z.string(), state: z.string(), watches: z.string().nullable(),
});
const reply = z.object({ data: z.object({ tempoTimezone: z.string(), triggers: z.array(pending) }) });
// Select through the daemon's visibility rules first. The agent argument selects a clock.
function triggersQuery(view: 'pending' | 'history' | 'schedules') {
  const pendingOnly = view === 'pending';
  const filter = view === 'schedules' ? 'scheduleRemovedAt:{isNull:true},sourceKind:{eq:"time"},lifespan:{eq:"until-stopped"},targetKind:{eq:inbox},'
    : pendingOnly ? 'enabled:{eq:true},' : '';
  const fields = pendingOnly ? 'id nextDueAt sourceKind lifespan note state watches' : view === 'schedules' ? 'id scheduleName times days nextDueAt note state' : 'id';
  return `query WakeTriggers($agent:String!, $after:String!, $limit:Int!) {
    tempoTimezone
    triggers(where:{OR:[
      {${filter}id:{gt:$after},toKind:{eq:agent},to:{eq:$agent}},
      {${filter}id:{gt:$after},toKind:{isNull:true},ownerKind:{eq:agent},owner:{eq:$agent}}
    ]},orderBy:{id:{direction:asc,priority:0}},limit:$limit) { ${fields} }
  }`;
}

const schedulePage = z.object({ data: z.object({ tempoTimezone: z.string(), triggers: z.array(z.object({
  id: z.string(), scheduleName: z.string().nullable(), times: z.string(), days: z.string().nullable(), nextDueAt: z.string().datetime().nullable(),
  note: z.string(), state: z.string(),
})) }) }).strict();

async function listSchedules(read: Read, agent: string) {
  const lines: string[] = [];
  let after = '';
  for (;;) {
    const { data } = schedulePage.parse(await read(triggersQuery('schedules'), { agent, after, limit: pageSize }));
    const format = householdTime(data.tempoTimezone);
    for (const row of data.triggers) {
      if (row.id <= after) throw Error();
      after = row.id;
      const when = (row.days || 'daily') + ' ' + row.times;
      const next = row.nextDueAt ? format.format(new Date(row.nextDueAt)) : '(none armed)';
      lines.push(onOneLine(encodeURIComponent(row.scheduleName ?? row.id) + '  ' + when + '  next ' + next + '  [' + row.state + ']  ' + row.note));
    }
    if (data.triggers.length < pageSize) break;
  }
  return (lines.sort().join('\n') || onOneLine(agent) + ' has no schedules') + '\n';
}

const idsReply = z.object({
  data: z.object({ tempoTimezone: z.string(), triggers: z.array(z.object({ id: z.string() })) }),
}).strict();
const eventReply = z.object({
  data: z.object({ triggerLog: z.array(z.object({
    seq: z.number().int(), at: z.string().datetime(), trigger: z.string(), event: z.string(), note: z.string(),
    triggerRow: z.object({
      toKind: z.string().nullable(), to: z.string().nullable(), ownerKind: z.string(), owner: z.string().nullable(),
    }).nullable(),
  })) }),
}).strict();
const deliveryQuery = `query WakeDeliveries($agent:String!, $events:[Int!]!){tempoDeliveries(agent:$agent,events:$events)}`;
const deliveryReply = z.object({ data: z.object({ tempoDeliveries: z.array(z.object({
  event: z.number().int(), kind: z.enum(['program','mail']), conversation: z.string().nullable(), job: z.string().nullable(),
})) }) }).strict();
type Read = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

const lanePage = z.object({ data: z.object({ tempoLanes: z.array(z.object({
  id: z.string(), agent: z.string(), times: z.string(), days: z.string().nullable(), note: z.string(),
  file: z.string().nullable(), characters: z.number().int(),
})) }) }).strict();
const laneText = z.object({ data: z.object({ tempoLaneText: z.union([
  z.object({ text: z.string(), digest: z.string(), revision: z.string().nullable() }), z.object({ file: z.string() }),
]).nullable() }) }).strict();

async function laneFileText(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({bigint:true});
    if (!before.isFile() || before.size > DOOR_REQUEST_BYTES) throw new DoorRefusal('Choose a regular lane file within the request size limit.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const {bytesRead} = await handle.read(bytes, used, bytes.length - used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat({bigint:true});
    if (used !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new DoorRefusal('The lane file changed while being read.');
    return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes.subarray(0,used));
  } finally { await handle.close(); }
}

async function storedLane(read: Read, name: string) {
  const answer = await read('query($id:String!){tempoLaneText(id:$id)}', { id: name });
  const row = laneText.parse(answer).data.tempoLaneText;
  if (!row) throw new DoorRefusal('No readable stored lane with that name.');
  if ('file' in row) throw new DoorRefusal('This lane reads its instructions at firing from ' + onOneLine(row.file) + '.');
  if (createHash('sha256').update(row.text).digest('hex') !== row.digest) throw new DoorRefusal('Could not return the exact lane text.');
  return row;
}

async function listLanes(read: Read): Promise<string> {
  const lines: string[] = [];
  let after = '';
  for (;;) {
    const answer = await read('query($after:String!){tempoLanes(after:$after)}', { after });
    const rows = lanePage.parse(answer).data.tempoLanes;
    for (const row of rows) {
      if (row.id <= after) throw Error();
      after = row.id;
      const size = row.file ? 'file ' + row.file : row.characters + ' chars';
      lines.push(onOneLine(`${encodeURIComponent(row.id).padEnd(22)} ${row.agent.padEnd(8)} ${row.times} ${row.days || 'daily'}  ${size}  — ${row.note}`));
    }
    if (rows.length < pageSize) break;
  }
  return (lines.join('\n') || 'no loom lanes') + '\n';
}

function logOptions(args: string[]) {
  const { values } = parseArgs({ args, options: {
    since: { type: 'string', default: '24h' }, grep: { type: 'string', default: '' },
  } });
  return { since: new Date(Date.now() - durationMs(values.since!)).toISOString(), grep: values.grep! };
}

function durationMs(duration: string) {
  if (!/^(?:\d+[smhd])+$/.test(duration)) throw Error();
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: DAY_MS };
  let ms = 0;
  for (const [, count, unit] of duration.matchAll(/(\d+)([smhd])/g)) ms += Number(count) * units[unit];
  if (!Number.isSafeInteger(ms)) throw Error();
  return ms;
}

function scheduleOptions(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    at: {type:'string'}, days: {type:'string'}, prompt: {type:'string', short:'p'},
    'prompt-file': {type:'string', short:'f'}, note: {type:'string'}, model: {type:'string'},
  } });
  const [name] = positionals;
  if (positionals.length !== 1 || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw Error();
  const times = values.at?.split(',').map(t => t.trim());
  if (!times || times.some(t => !HH_MM.test(t))) throw Error();
  const days = values.days?.toLowerCase() || null;
  const at = times.join(',');
  nextTime(at, days, Date.now(), 'UTC');
  const file = values['prompt-file'] || null, instructions = values.prompt || null;
  if (!!file === !!instructions || (file && !laneFile(file)) || (instructions && !instructions.trim())) throw Error();
  return { name, change: { times:at, days, instructions, file, note:values.note || file || name,
    wantsModel:values.model || null, execution:instructions?.includes('<!-- house: local -->') ? 'host' : 'container' } };
}

function wakeOptions(verb: 'at' | 'in', args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    prompt: { type: 'string', short: 'p' }, 'prompt-file': { type: 'string', short: 'f' },
    note: { type: 'string' }, model: { type: 'string' },
  } });
  const instructions = values.prompt, file = values['prompt-file'];
  if (!!instructions === !!file || (file && !laneFile(file))) throw Error();
  if (instructions && (!instructions.trim() || !values.note?.trim() ||
    (!/\s/.test(instructions.trim()) && /\/|\.md$/.test(instructions.trim())))) throw Error();
  const input = { ownerKind: 'agent', sourceKind: 'time', lifespan: 'once', targetKind: 'inbox',
    toKind: 'agent', instructions, file, note: values.note || file,
    wantsModel: values.model, execution: instructions?.includes('<!-- house: local -->') ? 'host' : 'container' };
  if (verb === 'in') {
    const ms = durationMs(positionals.join(''));
    return { input, times: new Date(Date.now() + ms).toISOString() };
  }
  const parts = positionals.join(' ').trim().split(/\s+/);
  const time = parts.pop()!.replace(/^(\d):/, '0$1:');
  if (!parts.length && HH_MM.test(time)) return { input, times: time };
  if (parts.length !== 1 || !(parts[0] === 'tomorrow' || DAY.test(parts[0]))
    || !HH_MM.test(time.slice(0,5)) || !/^(?:\d{2}:\d{2})(?::[0-5]\d)?$/.test(time)) throw Error();
  return { input, day: parts[0], time };
}

function householdTime(zone: string) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'medium' });
}

async function readLog(read: Read, agent: string, options: ReturnType<typeof logOptions>) {
  const matches: { seq: number; line: string }[] = [];
  let after = '';
  for (;;) {
    const { data } = idsReply.parse(await read(triggersQuery('history'), { agent, after, limit: pageSize }));
    const ids = data.triggers.map(row => row.id);
    if (!ids.length) break;
    const format = householdTime(data.tempoTimezone);
    let before: number | undefined;
    let found = 0;
    while (found < 2000) {
      const cursor = before === undefined ? '' : ',seq:{lt:$before}';
      const query = `query WakeLog($ids:[String!]!, $since:String!, $limit:Int! ${cursor ? ',$before:Int!' : ''}){
        triggerLog(where:{trigger:{inArray:$ids},at:{gte:$since}${cursor}},orderBy:{seq:{direction:desc,priority:0}},limit:$limit){
          seq at trigger event note triggerRow { toKind to ownerKind owner }
        }
      }`;
      const { data: { triggerLog } } = eventReply.parse(await read(query, { ids, since: options.since, limit: pageSize, before }));
      const fired = triggerLog.filter(row => row.event === 'fired').map(row => row.seq);
      const deliveries = fired.length
        ? deliveryReply.parse(await read(deliveryQuery, { agent, events: fired })).data.tempoDeliveries : [];
      const byEvent = new Map<number, string[]>();
      for (const delivery of deliveries) {
        const parts = [delivery.kind === 'program' ? 'program' : 'delivered'];
        if (delivery.conversation) parts.push(delivery.conversation);
        if (delivery.job) parts.push('job', delivery.job);
        const destinations = byEvent.get(delivery.event) ?? [];
        destinations.push(parts.join(' '));
        byEvent.set(delivery.event, destinations);
      }
      for (const row of triggerLog) {
        if (before !== undefined && row.seq >= before) throw Error();
        before = row.seq;
        // An owner may reassign a trigger between the ID query and this page.
        const t = row.triggerRow;
        if (!t) continue;
        const recipient = t.toKind ? t.toKind === 'agent' && t.to : t.ownerKind === 'agent' && t.owner;
        if (recipient !== agent) continue;
        const destination = byEvent.get(row.seq)?.join(' → ');
        const suffix = destination ? '  → ' + destination : '';
        const line = onOneLine(`${format.format(new Date(row.at))} | ${row.event} | ${row.trigger} ${row.note}`.trimEnd() + suffix);
        if (!line.includes(options.grep)) continue;
        matches.push({ seq: row.seq, line });
        if (++found === 2000) break;
      }
      if (triggerLog.length < pageSize) break;
    }
    matches.sort((a, b) => b.seq - a.seq);
    matches.splice(2000);
    const last = ids[ids.length - 1];
    if (last <= after) throw Error();
    after = last;
    if (ids.length < pageSize) break;
  }
  return matches.reverse().map(match => match.line).join('\n') + '\n';
}

export async function runTempoClient(argv: string[], io: IOStreams, request = fetch): Promise<number> {
  let agent = io.env.WAKE_AGENT || io.env.WAKE_LOCAL_AGENT;
  if (argv[0] === '--agent') { agent = argv[1]; argv = argv.slice(2); }
  else if (argv[0]?.startsWith('--agent=')) { agent = argv[0].slice('--agent='.length); argv = argv.slice(1); }
  const verb = argv[0];
  const changesClock = verb === 'pause' || verb === 'resume';
  let laneUpdate: { name: string; file?: string; words?: string } | undefined;
  let scheduleSet: ReturnType<typeof scheduleOptions> | undefined;
  let scheduleAction: 'run' | 'rm' | 'set' | undefined;
  let scheduleName: string | undefined;
  let cancel: { id: string; at?: string } | undefined;
  let wake: ReturnType<typeof wakeOptions> | undefined;
  let options: ReturnType<typeof logOptions> | undefined;
  try {
    if (agent === '') throw Error();
    if (verb === 'lane') {
      if (argv[1] === 'set') {
        const {values, positionals} = parseArgs({args:argv.slice(2), allowPositionals:true, options:{
          'prompt-file':{type:'string',short:'f'}, prompt:{type:'string',short:'p'},
        }});
        if (positionals.length !== 1 || !positionals[0] || !!values['prompt-file'] === !!values.prompt) throw Error();
        laneUpdate = { name: decodeURIComponent(positionals[0]), file: values['prompt-file'], words: values.prompt };
      } else if (!(argv[1] === 'list' && argv.length === 2 || argv[1] === 'text' && argv.length === 3 && argv[2])) throw Error();
    } else if (verb === 'schedule') {
      if (argv[1] === 'set') {
        scheduleSet = scheduleOptions(argv.slice(2));
        scheduleAction = 'set'; scheduleName = scheduleSet.name;
      } else if ((argv[1] === 'run' || argv[1] === 'rm') && argv.length === 3 && argv[2]) {
        scheduleAction = argv[1]; scheduleName = decodeURIComponent(argv[2]);
      }
      else if (argv[1] !== 'list' || argv.length !== 2) throw Error();
    } else if (verb === 'cancel') {
      if (argv.length !== 2) throw Error();
      const [encoded, at, extra] = argv[1].split('@');
      if (!encoded || extra !== undefined || (at !== undefined && !z.string().datetime().safeParse(at).success)) throw Error();
      cancel = { id: decodeURIComponent(encoded), at };
    } else if (verb === 'in' || verb === 'at') wake = wakeOptions(verb, argv.slice(1));
    else if (verb === 'log') options = logOptions(argv.slice(1));
    else if ((verb !== 'list' && !changesClock) || argv.length !== 1) throw Error();
  } catch {
    io.stderr('usage: wake [--agent AGENT] lane list | lane text NAME | lane set NAME (-f FILE | -p WORDS) | schedule list | schedule set NAME --at HH:MM (-p WORDS | -f REPO_FILE) [--days DAYS] [--note NOTE] [--model MODEL] | schedule run NAME | schedule rm NAME | list | cancel WAKE | pause | resume | log [--since DURATION] [--grep TEXT] | at TIME | in DURATION\nFor at/in supply -p WORDS --note PURPOSE or -f REPO_FILE, optionally --model MODEL.\n');
    return 2;
  }
  try {
    const { base, token } = await doorConnection(io.env);
    const post = async (path: string, payload: unknown) => {
      const url = new URL(path, base);
      const body = JSON.stringify(payload);
      for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
          response = await request(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body,
          });
          if (response.ok) return parseRedactedJSON(await response.text(), token);
        } catch (error) {
          if (attempt >= 3) throw error;
          await delay(100 * attempt);
          continue;
        }
        await response.body?.cancel();
        if (response.status === 401) throw new DoorRefusal('Loom rejected the credential.');
        if (scheduleAction && response.status === 409) throw new DoorRefusal('The schedule changed. Check schedule list and wake log.');
        if (laneUpdate && response.status === 409) throw new DoorRefusal('The lane changed during the update. Read its current text before retrying.');
        if (response.status === 403) throw new DoorRefusal('Loom denied this clock request.');
        if (response.status !== 503 || attempt >= 3) throw Error();
        await delay(100 * attempt);
      }
    };
    const read: Read = (query, variables) => post('/graphql', { query, variables });
    if (verb === 'lane') {
      if (argv[1] === 'list') io.stdout(await listLanes(read));
      else {
        const name = laneUpdate?.name ?? decodeURIComponent(argv[2]);
        const row = await storedLane(read, name);
        if (!laneUpdate) io.stdout(row.text.endsWith('\n') ? row.text : row.text + '\n');
        else {
          if (!row.revision) throw new DoorRefusal('A household owner updates stored lanes.');
          const words = laneUpdate.file
            ? await laneFileText(laneUpdate.file) : laneUpdate.words!;
          if (!words.trim() || words.includes('\0') || words.length > MESSAGE_WORDS_MAX)
            throw new DoorRefusal('The lane needs nonempty UTF-8 instructions within the message limit.');
          if (parseRedactedJSON(JSON.stringify(words), token) !== words) throw new DoorRefusal('The lane text contains a credential.');
          const answer = await post('/api/tempo/edit', { id:randomUUID(), input:{id:name, instructions:words, laneRevision:row.revision} });
          const { value } = z.object({ok:z.literal(true),value:z.object({saved:z.boolean(),waits:z.string().optional()})}).parse(answer);
          if (!value.saved) throw new DoorRefusal(onOneLine(value.waits || 'The lane edit is awaiting approval.'));
          io.stdout('Updated ' + onOneLine(name) + '.\n');
        }
      }
      return 0;
    }
    if (!agent) {
      const result = await post('/graphql', { query: '{tempoDefaultAgent}' });
      const choice = z.object({ data: z.object({ tempoDefaultAgent: z.string().min(1).nullable() }) }).strict().parse(result);
      if (!choice.data.tempoDefaultAgent) {
        io.stderr('Choose a clock with --agent AGENT.\n');
        return 2;
      }
      agent = choice.data.tempoDefaultAgent;
    }
    if (scheduleAction) {
      const scope = 'toKind:{eq:agent},to:{eq:$agent},targetKind:{eq:inbox},sourceKind:{eq:"time"},lifespan:{eq:"until-stopped"},scheduleRemovedAt:{isNull:true}';
      const query = `query ClockSchedule($agent:String!,$name:String!){triggers(where:{OR:[
        {${scope},scheduleName:{eq:$name}},{${scope},scheduleName:{isNull:true},id:{eq:$name}}
      ]},limit:2){id}}`;
      const result = await read(query, {agent, name:scheduleName});
      const rows = z.object({data:z.object({triggers:z.array(z.object({id:z.string()}))})}).parse(result).data.triggers;
      if (scheduleSet && rows.length <= 1) {
        const key = randomUUID(), change = scheduleSet.change;
        let waits: string | undefined;
        if (rows.length) {
          const result = await post('/api/tempo/edit', {id:key, input:{id:rows[0].id, scheduleAgent:agent, ...change}});
          const {value} = z.object({ok:z.literal(true), value:z.object({saved:z.boolean(),waits:z.string().optional()})}).parse(result);
          if (!value.saved && !value.waits) throw Error();
          waits = value.waits;
        } else {
          const result = await post('/api/tempo/set', {id:key, input:{scheduleName, ownerKind:'agent', owner:agent,
            toKind:'agent', to:agent, sourceKind:'time', targetKind:'inbox', lifespan:'until-stopped', ...change}});
          waits = z.object({ok:z.literal(true), value:z.object({id:z.string(),waits:z.string().optional()})}).parse(result).value.waits;
        }
        io.stdout(onOneLine(waits ? 'Awaiting approval: ' + waits : 'Saved schedule ' + scheduleName + '.') + '\n');
        return 0;
      }
      if (rows.length !== 1) throw new DoorRefusal('No matching recurring wake on this clock.');
      const path = scheduleAction === 'run' ? '/api/tempo/runNow' : '/api/tempo/stop';
      const answer = await post(path, { id: randomUUID(), input: { id: rows[0].id, scheduleAgent: agent } });
      z.object({ ok: z.literal(true), value: z.object({ saved: z.literal(true) }) }).parse(answer);
      io.stdout((scheduleAction === 'run' ? 'Requested a run of ' : 'Removed schedule ') + onOneLine(scheduleName!) + '.\n');
      return 0;
    }
    if (verb === 'schedule') { io.stdout(await listSchedules(read, agent)); return 0; }
    if (cancel) {
      const answer = await post('/api/tempo/stop', { id: randomUUID(), input: { id: cancel.id, occurrence: { agent, at: cancel.at } } });
      z.object({ ok: z.literal(true), value: z.object({ saved: z.literal(true) }) }).parse(answer);
      io.stdout('Cancelled ' + onOneLine(argv[1]) + '.\n');
      return 0;
    }
    if (changesClock) {
      const answer = await post('/api/tempo/' + verb, { id: randomUUID(), input: { agent } });
      z.object({ ok: z.literal(true), value: z.object({ saved: z.literal(true) }) }).parse(answer);
      io.stdout((verb === 'pause' ? 'Paused ' : 'Resumed ') + onOneLine(agent) + "'s clock.\n");
      return 0;
    }
    if (wake) {
      let times = wake.times;
      if (times === undefined) {
        const { data } = z.object({ data: z.object({ tempoTimezone: z.string() }) }).strict()
          .parse(await read('{tempoTimezone}', {}));
        try {
          times = new Date(datedWake(wake.day!, wake.time!, Date.now(), data.tempoTimezone)).toISOString();
        } catch {
          io.stderr('Choose a future date and time that exists in the household time zone.\n');
          return 2;
        }
      }
      const result = await post('/api/tempo/set', { id: randomUUID(), input: { ...wake.input, owner: agent, to: agent, times } });
      const { value } = z.object({ ok: z.literal(true), value: z.object({ id: z.string(), waits: z.string().optional() }) }).parse(result);
      io.stdout(onOneLine(value.waits ? 'Awaiting approval: ' + value.waits : encodeURIComponent(value.id) + ' will wake at ' + times) + '\n');
      return 0;
    }
    if (options) { io.stdout(await readLog(read, agent, options)); return 0; }
    const rows: z.infer<typeof pending>[] = [];
    let after = '', timezone: string;
    do {
      const result = reply.strict().parse(await read(triggersQuery('pending'), { agent, after, limit: pageSize })).data;
      timezone = result.tempoTimezone;
      for (const row of result.triggers) {
        if (row.id <= after) throw Error();
        after = row.id;
        rows.push(row);
      }
      if (result.triggers.length < pageSize) break;
    } while (true);
    const format = householdTime(timezone);
    rows.sort((a, b) => (a.nextDueAt ?? '~').localeCompare(b.nextDueAt ?? '~') || a.id.localeCompare(b.id));
    const now = Date.now();
    for (const row of rows) {
      const when = row.nextDueAt ? format.format(new Date(row.nextDueAt)) + '  (in ' + remaining(row.nextDueAt, now) + ')'
        : row.watches ? 'waiting for ' + row.watches : 'no due time';
      const key = encodeURIComponent(row.id) + (row.lifespan !== 'once' && row.nextDueAt ? '@' + row.nextDueAt : '');
      const line = `${key}  ${when}  [${row.state}]  ${row.note}`;
      io.stdout(onOneLine(line) + '\n');
    }
    if (!rows.length) io.stdout('No pending wakes.\n');
    return 0;
  } catch (error) {
    if (error instanceof DoorRefusal) io.stderr(error.message + '\n');
    else if (laneUpdate) io.stderr('Could not confirm the stored lane update.\n');
    else if (verb === 'lane') io.stderr('Could not read the household lane.\n');
    else if (scheduleAction) io.stderr('Could not confirm the schedule request. Check wake log before retrying.\n');
    else if (verb === 'schedule') io.stderr('Could not read recurring schedules from Loom.\n');
    else if (cancel) io.stderr('Could not confirm cancellation. Run wake list for the current occurrence.\n');
    else if (wake) io.stderr('Could not confirm the scheduled wake.\n');
    else if (changesClock) io.stderr('Could not confirm the request to ' + verb + ' the clock.\n');
    else io.stderr('Could not read ' + (verb === 'log' ? 'wake history' : 'pending wakes') + ' from Loom.\n');
    return 1;
  }
}

function remaining(at: string, now: number): string {
  const minutes = Math.floor((Date.parse(at) - now) / 60_000);
  if (minutes >= 1440) return Math.floor(minutes / 1440) + 'd' + Math.floor(minutes % 1440 / 60) + 'h';
  if (minutes >= 60) return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
  return minutes + 'm';
}
