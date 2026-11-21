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
const listQuery = `query PendingWakes($agent:String!, $after:String!, $limit:Int!) {
  tempoTimezone
  triggers(where:{OR:[
    {enabled:{eq:true},id:{gt:$after},toKind:{eq:agent},to:{eq:$agent}},
    {enabled:{eq:true},id:{gt:$after},toKind:{isNull:true},ownerKind:{eq:agent},owner:{eq:$agent}}
  ]},orderBy:{id:{direction:asc,priority:0}},limit:$limit) {
    id nextDueAt sourceKind note state watches
  }
}`;

export async function runTempoClient(argv: string[], io: IOStreams, request = fetch): Promise<number> {
  let agent = io.env.WAKE_AGENT;
  if (argv[0] === '--agent') { agent = argv[1]; argv = argv.slice(2); }
  else if (argv[0]?.startsWith('--agent=')) { agent = argv[0].slice('--agent='.length); argv = argv.slice(1); }
  if (!agent || argv.length !== 1 || argv[0] !== 'list') {
    io.stderr('usage: wake --agent AGENT list (or set WAKE_AGENT)\n');
    return 2;
  }
  try {
    const { base, token } = await doorConnection(io.env);
    const rows: z.infer<typeof pending>[] = [];
    let after = '', timezone: string;
    do {
      const response = await request(new URL('/graphql', base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ query: listQuery, variables: { agent, after, limit: pageSize } }),
      });
      if (!response.ok) { await response.body?.cancel(); throw Error(); }
      const result = reply.strict().parse(parseRedactedJSON(await response.text(), token)).data;
      timezone = result.tempoTimezone;
      for (const row of result.triggers) {
        if (row.id <= after) throw Error();
        after = row.id;
        rows.push(row);
      }
      if (result.triggers.length < pageSize) break;
    } while (true);
    const format = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' });
    rows.sort((a, b) => (a.nextDueAt ?? '~').localeCompare(b.nextDueAt ?? '~') || a.id.localeCompare(b.id));
    const now = Date.now();
    for (const row of rows) {
      const when = row.nextDueAt ? format.format(new Date(row.nextDueAt)) + '  (in ' + remaining(row.nextDueAt, now) + ')'
        : row.watches ? 'waiting for ' + row.watches : 'no due time';
      const line = `${row.id}  ${when}  [${row.state}]  ${row.note}`;
      io.stdout(line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') + '\n');
    }
    if (!rows.length) io.stdout('No pending wakes.\n');
    return 0;
  } catch {
    io.stderr('Could not read pending wakes from Loom.\n');
    return 1;
  }
}

function remaining(at: string, now: number): string {
  const minutes = Math.floor((Date.parse(at) - now) / 60_000);
  if (minutes >= 1440) return Math.floor(minutes / 1440) + 'd' + Math.floor(minutes % 1440 / 60) + 'h';
  if (minutes >= 60) return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
  return minutes + 'm';
}
