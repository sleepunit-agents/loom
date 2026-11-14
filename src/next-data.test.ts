import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { nextData } from './next-data.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const token = 's'.repeat(64), cookie = 'c'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const query = '{ tasks { id title } }';
const selection = { type: 'subscribe', id: 'tasks', payload: {
  query: 'subscription($query: String!) { observe(query: $query) { revision patches { path removed value } } }', variables: { query },
} };
async function setup() {
  const client = new Database(':memory:'); clean.push(() => { client.close(); });
  const clock = new FakeClock();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  const at = new Date(clock.now()).toISOString();
  client.exec(`INSERT INTO members (id,role,joined_at) VALUES ('sam','member','${at}'),('owner','owner','${at}');
    INSERT INTO projects (id,name) VALUES ('pond','Pond');
    INSERT INTO project_members (project,member) VALUES ('pond','sam');
    INSERT INTO tasks (id,title,project,owner_kind,owner,created_by_kind,created_by,created_at,changed_at)
    VALUES ('pump','Pump','pond','member','owner','member','owner','${at}','${at}');`);
  client.prepare('INSERT INTO tokens (fingerprint,label,kind,member,created_at) VALUES (?,?,?,?,?)').run(hash(token),'Sam','owner','sam',at);
  client.prepare('INSERT INTO sessions (id,token,device,via,is_agent,issued_at,seen_at,proved_at) VALUES (?,?,?,?,?,?,?,?)').run(hash(cookie),hash(token),'Browser','token',0,at,at,at);
  const data = nextData(db, clock, req => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`);
  clean.push(() => data.close());
  async function bind() {
    const http = createServer(); const detach = data.attach(http);
    await new Promise<void>(ok => http.listen(0,'127.0.0.1',ok));
    clean.push(async () => { detach(); await data.close(); await new Promise<void>(ok => http.close(() => ok())); });
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
    return `ws://127.0.0.1:${address.port}/graphql`;
  }
  const url = await bind();
  async function open(address = url, headers: Record<string,string> = { authorization: `Bearer ${token}` }) {
    const ws = new WebSocket(address,'graphql-transport-ws',{headers}); clean.push(() => { ws.terminate(); });
    await once(ws,'open');
    const ack = once(ws,'message'); ws.send(JSON.stringify({type:'connection_init',payload:{viewer:{kind:'member',id:'owner'}}})); await ack;
    return ws;
  }
  const post = (headers: Record<string,string>) => data.http.request('/graphql', {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({query})});
  return {client,clock,data,url,bind,open,post};
}
async function read(ws: WebSocket, action: () => void) {
  const received = once(ws,'message'); action(); return JSON.parse(String((await received)[0]));
}
it('uses shared credentials and the same visible selection for HTTP and socket callers', async () => {
  const f = await setup();
  expect(await (await f.post({authorization:`Bearer ${token}`})).json()).toEqual({data:{tasks:[{id:'pump',title:'Pump'}]}});
  expect((await f.post({authorization:hash(token)})).status).toBe(401);
  const ws = await f.open();
  const first = await read(ws, () => ws.send(JSON.stringify(selection)));
  expect(first.payload.data.observe.patches[0].value).toEqual({tasks:[{id:'pump',title:'Pump'}]});
  const changed = await read(ws, () => {
    const result = f.data.writes.run(() => f.client.exec("UPDATE tasks SET title='Fits'"));
    expect(result.notificationErrors).toEqual([]);
  });
  expect(changed.payload.data.observe).toMatchObject({revision:2,patches:[{path:['tasks',0,'title'],value:'Fits'}]});
});
it('refreshes sharing and then closes revoked callers across both bind addresses', async () => {
  const f = await setup(), second = await f.bind();
  const sockets = [await f.open(),await f.open(second)];
  for (const ws of sockets) await read(ws, () => ws.send(JSON.stringify(selection)));
  const messages = sockets.map(ws => once(ws,'message'));
  f.data.writes.run(() => f.client.exec("DELETE FROM project_members WHERE member='sam'"));
  for (const received of messages) expect(JSON.parse(String((await received)[0])).payload.data.observe.patches).toEqual([{path:['tasks',0],removed:true,value:null}]);
  const closed = sockets.map(ws => once(ws,'close'));
  f.data.writes.run(() => f.client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(new Date(f.clock.now()).toISOString(),hash(token)));
  for (const result of closed) expect((await result)[0]).toBe(4403);
  expect((await f.post({authorization:`Bearer ${token}`})).status).toBe(401);
});
it('requires Origin for shared browser sessions and refuses foreign origins or fingerprints', async () => {
  const f = await setup();
  for (const headers of [{cookie:`loom_ui=${cookie}`},{authorization:`Bearer ${token}`,origin:'https://foreign.invalid'},{authorization:`Bearer ${hash(token)}`}]) {
    const ws = new WebSocket(f.url,'graphql-transport-ws',{headers}); ws.on('error',()=>{});
    expect(await new Promise<number>(ok => ws.once('unexpected-response',(_req,res)=>{res.resume();ws.terminate();ok(res.statusCode!);}))).toBe(401);
  }
  const ws = await f.open(f.url,{cookie:`loom_ui=${cookie}`,origin:f.url.replace('ws:','http:').replace('/graphql','')});
  expect((await read(ws,()=>ws.send(JSON.stringify(selection)))).payload.data.observe.revision).toBe(1);
});
it('does not publish rolled-back writes and closes sockets on shutdown', async () => {
  const f = await setup(), ws = await f.open();
  await read(ws,()=>ws.send(JSON.stringify(selection)));
  expect(()=>f.data.writes.run(()=>{f.client.exec("UPDATE tasks SET title='Rolled back'");throw new Error('Rollback');})).toThrow('Rollback');
  expect(await (await f.post({authorization:`Bearer ${token}`})).json()).toEqual({data:{tasks:[{id:'pump',title:'Pump'}]}});
  const update = await read(ws,()=>{f.data.writes.run(()=>f.client.exec("UPDATE tasks SET title='Committed'"));});
  expect(update.payload.data.observe).toMatchObject({revision:2,patches:[{value:'Committed'}]});
  const closed = once(ws,'close'); await f.data.close(); await closed;
  expect(f.data.close()).toBe(f.data.close());
});
