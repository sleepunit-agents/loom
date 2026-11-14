import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { parse, subscribe } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import { DataLive } from './live.js';
import { dataSubscriptions } from './subscriptions.js';
import { generatedDataClient, type QueryTransport } from '../../../web/src/data/graphql/client.js';

it('feeds a generated SQL selection into the normalized browser cache, including joined counts and lost project access', async () => {
  const database = new Database(':memory:'); createDataSchema(database);
  database.exec(`INSERT INTO members (id,role,joined_at) VALUES ('sam','member','2026-11-14T00:00:00Z');
    INSERT INTO projects (id,name) VALUES ('pond','Pond');
    INSERT INTO project_members (project,member) VALUES ('pond','sam');
    INSERT INTO tasks (id,title,owner_kind,owner,project,created_by_kind,created_by,created_at,changed_at)
    VALUES ('t-1','Pump','member','sam','pond','member','sam','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z');`);
  const live = new DataLive();
  const schema = dataSubscriptions(dataQueries(database, { tables: ['tasks','taskComments'], visibility: taskVisibility({kind:'member',id:'sam'}) }), live, () => true);
  const frames: unknown[] = [], stopped: Promise<unknown>[] = [];
  let reads = 0;
  const transport: QueryTransport = {
    subscribe(request, sink) {
      reads++;
      let cancelled = false, iterator: AsyncIterator<unknown> | undefined;
      const running = (async () => {
        const result = await subscribe({ schema, document: parse(request.query), variableValues: request.variables });
        if (!(Symbol.asyncIterator in result)) throw new Error(JSON.stringify(result));
        iterator = result;
        if (cancelled) { await iterator.return?.(); return; }
        for await (const frame of result) { frames.push(frame); sink.next(frame); }
      })();
      stopped.push(running);
      return () => { cancelled = true; void iterator?.return?.(); };
    },
    disconnected: () => () => {}, close() {},
  };
  const client = generatedDataClient(transport);
  const results: unknown[] = []; let resolve: ((data: unknown) => void) | undefined;
  const next = () => results.length ? Promise.resolve(results.shift()) : new Promise<unknown>(ok => { resolve = ok; });
  const reader = client.query('query Tasks($project: String!) { tasks(where:{project:{eq:$project}}) { id title commentCount } }', {project:'pond'}).subscribe(result => {
    const value = result.error ?? result.data;
    if (resolve) { const ok = resolve; resolve = undefined; ok(value); } else results.push(value);
  });
  try {
    expect(await next()).toMatchObject({tasks:[{id:'t-1',title:'Pump',commentCount:0}]});
    database.exec("INSERT INTO task_comments (task,seq,actor_kind,actor,at,text) VALUES ('t-1',1,'member','sam','2026-11-14T00:00:00Z','Fits')"); live.changed();
    expect(await next()).toMatchObject({tasks:[{id:'t-1',title:'Pump',commentCount:1}]});
    expect(frames.at(-1)).toMatchObject({ data: { observe: { revision: 2, patches: [{path:['tasks',0,'commentCount'],removed:false,value:1}] } } });
    database.exec('DELETE FROM project_members'); live.changed();
    expect(await next()).toEqual({tasks:[]});
    expect(reads).toBe(1);
  } finally { reader.unsubscribe(); live.close(); await Promise.all(stopped); database.close(); }
});
