import { parseArgs } from 'node:util';
import { z } from 'zod';
import { doorConnection } from './connection.js';
import { parseRedactedJSON } from '../pieces/changes/redact.js';
import type { IOStreams } from './io.js';

const pageSize = 100;
const pending = z.object({
  id: z.string(), nextDueAt: z.string().datetime().nullable(), sourceKind: z.string(),
  note: z.string(), state: z.string(), watches: z.string().nullable(),
});
const reply = z.object({ data: z.object({ tempoTimezone: z.string(), triggers: z.array(pending) }) });
// Select through the daemon's visibility rules first. The agent argument selects a clock.
function triggersQuery(pendingOnly: boolean) {
  const enabled = pendingOnly ? 'enabled:{eq:true},' : '';
  const fields = pendingOnly ? 'id nextDueAt sourceKind note state watches' : 'id';
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
type Read = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

function logOptions(args: string[]) {
  const { values } = parseArgs({ args, options: {
    since: { type: 'string', default: '24h' }, grep: { type: 'string', default: '' },
  } });
  const duration = values.since!;
  if (!/^(?:\d+[smhd])+$/.test(duration)) throw Error();
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  let ms = 0;
  for (const [, count, unit] of duration.matchAll(/(\d+)([smhd])/g)) ms += Number(count) * units[unit];
  if (!Number.isSafeInteger(ms)) throw Error();
  return { since: new Date(Date.now() - ms).toISOString(), grep: values.grep! };
}

function printable(line: string) { return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }
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
      for (const row of triggerLog) {
        if (before !== undefined && row.seq >= before) throw Error();
        before = row.seq;
        // An owner may reassign a trigger between the ID query and this page.
        const t = row.triggerRow;
        if (!t) continue;
        const recipient = t.toKind ? t.toKind === 'agent' && t.to : t.ownerKind === 'agent' && t.owner;
        if (recipient !== agent) continue;
        const line = printable(`${format.format(new Date(row.at))} | ${row.event} | ${row.trigger} ${row.note}`.trimEnd());
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
  let agent = io.env.WAKE_AGENT;
  if (argv[0] === '--agent') { agent = argv[1]; argv = argv.slice(2); }
  else if (argv[0]?.startsWith('--agent=')) { agent = argv[0].slice('--agent='.length); argv = argv.slice(1); }
  const verb = argv[0];
  let options: ReturnType<typeof logOptions> | undefined;
  try {
    if (!agent) throw Error();
    if (verb === 'log') options = logOptions(argv.slice(1));
    else if (verb !== 'list' || argv.length !== 1) throw Error();
  } catch {
    io.stderr('usage: wake --agent AGENT list | log [--since DURATION] [--grep TEXT] (or set WAKE_AGENT)\n');
    return 2;
  }
  try {
    const { base, token } = await doorConnection(io.env);
    const read: Read = async (query, variables) => {
      const response = await request(new URL('/graphql', base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) { await response.body?.cancel(); throw Error(); }
      return parseRedactedJSON(await response.text(), token);
    };
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
      const line = `${row.id}  ${when}  [${row.state}]  ${row.note}`;
      io.stdout(printable(line) + '\n');
    }
    if (!rows.length) io.stdout('No pending wakes.\n');
    return 0;
  } catch {
    io.stderr('Could not read ' + (verb === 'log' ? 'wake history' : 'pending wakes') + ' from Loom.\n');
    return 1;
  }
}

function remaining(at: string, now: number): string {
  const minutes = Math.floor((Date.parse(at) - now) / 60_000);
  if (minutes >= 1440) return Math.floor(minutes / 1440) + 'd' + Math.floor(minutes % 1440 / 60) + 'h';
  if (minutes >= 60) return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
  return minutes + 'm';
}
