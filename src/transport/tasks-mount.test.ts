import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/index.js';
import { loadHousehold, createToken } from '../household.js';
import { startHttpServer } from './http-server.js';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('mounts registered task operations for authenticated daemon sessions, binds viewers and excludes peers/anonymous', async () => {
  const home = mkdtempSync(join(tmpdir(),'loom-tasks-mount-')); cleanup.push(() => rmSync(home,{recursive:true,force:true}));
  mkdirSync(join(home,'agents/art'),{recursive:true});
  writeFileSync(join(home,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',members:[{person:'jonathan',role:'owner',agents:'*'}]}));
  const household = loadHousehold(home)!;
  const agent = createToken(household,{role:{kind:'agent',agent:'art'},label:'agent'}).token;
  const peer = createToken(household,{role:{kind:'peer',name:'guest'},label:'peer'}).token;
  const app = await startLoom({ home, clock: new FakeClock(), listen: async foundation => {
    const server = await startHttpServer({ foundation, household, contextDir: join(home,'agents/art'), host:'127.0.0.1',port:0,token:'owner-token' });
    server.setBackgroundActive(false);
    return { url: `http://127.0.0.1:${server.port}`, close: server.close };
  } }); cleanup.push(app.close);
  const connect = async (token?:string) => {
    const client = new Client({name:'fixture-client',version:'1'});
    try { await client.connect(new StreamableHTTPClientTransport(new URL(app.url),{requestInit:{headers:token?{authorization:`Bearer ${token}`}:{}}})); }
    catch(e) { await client.close(); throw e; }
    cleanup.push(() => client.close()); return client;
  };
  await expect(connect()).rejects.toThrow();
  const owner = await connect('owner-token');
  expect((await owner.listTools()).tools.map(t=>t.name)).toContain('tasks.create');
  const input = { title:'Household task',actor:'art',at:'2026-11-12T00:00:00.000Z' };
  const made = await owner.callTool({name:'tasks.create',arguments:{input,id:'create'}});
  expect(JSON.parse((made.content as {text:string}[])[0].text)).toMatchObject({ok:true,value:{result:{ok:true,id:'t-1'}}});
  const body = await fetch(app.url+'/api/tasks/list',{method:'POST',headers:{authorization:'Bearer owner-token','content-type':'application/json'},body:JSON.stringify({input:{}})}).then(r=>r.json());
  expect(body).toMatchObject({ok:true,value:{result:{entries:[{id:'t-1'}]}}});
  const art = await connect(agent), listed = await art.callTool({name:'tasks.list',arguments:{input:{}}});
  expect(JSON.parse((listed.content as {text:string}[])[0].text)).toMatchObject({ok:true,value:{result:{entries:[]}}});
  const outsider = await connect(peer);
  expect((await outsider.listTools()).tools.map(t=>t.name)).not.toContain('tasks.list');
});
