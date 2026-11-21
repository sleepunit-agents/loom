import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { datedWake, HH_MM } from '../core/tempo/calendar.js';
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
function triggersQuery(pendingOnly: boolean) {
  const enabled = pendingOnly ? 'enabled:{eq:true},' : '';
  const fields = pendingOnly ? 'id nextDueAt sourceKind lifespan note state watches' : 'id';
  return `query WakeTriggers($agent:String!, $after:String!, $limit:Int!) {
    tempoTimezone
    triggers(where:{OR:[
      {${enabled}id:{gt:$after},toKind:{eq:agent},to:{eq:$agent}},
      {${enabled}id:{gt:$after},toKind:{isNull:true},ownerKind:{eq:agent},owner:{eq:$agent}}
    ]},orderBy:{id:{direction:asc,priority:0}},limit:$limit) { ${fields} }
  }`;
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

function wakeOptions(verb: 'at' | 'in', args: string[], agent: string) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    prompt: { type: 'string', short: 'p' }, 'prompt-file': { type: 'string', short: 'f' },
    note: { type: 'string' }, model: { type: 'string' },
  } });
  const instructions = values.prompt, file = values['prompt-file'];
  if (!!instructions === !!file || (file && !laneFile(file))) throw Error();
  if (instructions && (!instructions.trim() || !values.note?.trim() ||
    (!/\s/.test(instructions.trim()) && /\/|\.md$/.test(instructions.trim())))) throw Error();
  const input = { ownerKind: 'agent', owner: agent, sourceKind: 'time', lifespan: 'once', targetKind: 'inbox',
    toKind: 'agent', to: agent, instructions, file, note: values.note || file,
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
    const { data } = idsReply.parse(await read(triggersQuery(false), { agent, after, limit: pageSize }));
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
  let cancel: { id: string; occurrence: { agent: string; at?: string } } | undefined;
  let wake: ReturnType<typeof wakeOptions> | undefined;
  let options: ReturnType<typeof logOptions> | undefined;
  try {
    if (!agent) throw Error();
    if (verb === 'cancel') {
      if (argv.length !== 2) throw Error();
      const [encoded, at, extra] = argv[1].split('@');
      if (!encoded || extra !== undefined || (at !== undefined && !z.string().datetime().safeParse(at).success)) throw Error();
      cancel = { id: decodeURIComponent(encoded), occurrence: { agent, at } };
    } else if (verb === 'in' || verb === 'at') wake = wakeOptions(verb, argv.slice(1), agent);
    else if (verb === 'log') options = logOptions(argv.slice(1));
    else if ((verb !== 'list' && !changesClock) || argv.length !== 1) throw Error();
  } catch {
    io.stderr('usage: wake --agent AGENT list | cancel WAKE | pause | resume | log [--since DURATION] [--grep TEXT] | at TIME | in DURATION\nFor at/in supply -p WORDS --note PURPOSE or -f REPO_FILE, optionally --model MODEL.\n');
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
        if (response.status === 403) throw new DoorRefusal('Loom denied this clock request.');
        if (response.status !== 503 || attempt >= 3) throw Error();
        await delay(100 * attempt);
      }
    };
    if (cancel) {
      const answer = await post('/api/tempo/stop', { id: randomUUID(), input: cancel });
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
    const read: Read = (query, variables) => post('/graphql', { query, variables });
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
      const result = await post('/api/tempo/set', { id: randomUUID(), input: { ...wake.input, times } });
      const { value } = z.object({ ok: z.literal(true), value: z.object({ id: z.string(), waits: z.string().optional() }) }).parse(result);
      io.stdout(onOneLine(value.waits ? 'Awaiting approval: ' + value.waits : encodeURIComponent(value.id) + ' will wake at ' + times) + '\n');
      return 0;
    }
    if (options) { io.stdout(await readLog(read, agent, options)); return 0; }
    const rows: z.infer<typeof pending>[] = [];
    let after = '', timezone: string;
    do {
      const result = reply.strict().parse(await read(triggersQuery(true), { agent, after, limit: pageSize })).data;
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
