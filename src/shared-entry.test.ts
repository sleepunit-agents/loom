/** Both shipped documents must work through normal startup, not only a fixture listener. */
import Database from 'better-sqlite3';
import {generateX25519Identity} from 'age-encryption';
import {existsSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {it,expect,vi} from 'vitest';
import {createDataSchema} from './core/data/database.js';
import {agents,members,memberAgents} from './core/data/schema.js';
import {run} from './cli/serve.js';
const webRoot=resolve(import.meta.dirname,'../dist/web');
const entries=(html:string)=>[...html.matchAll(/<script\b[^>]*>/g)].map(match=>match[0]).filter(tag=>tag.includes('type="module"')).map(tag=>tag.match(/src="([^"]+)"/)?.[1]);
it.runIf(existsSync(join(webRoot,'index.html')))('normal serve --http serves both built documents with the same shared client and identity door',async()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-entry-fiction-')),database=join(home,'app.db'),client=new Database(database),db=createDataSchema(client),at='2026-11-15T12:00:00.000Z';
 db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();
 db.insert(agents).values({id:'fiction',about:'',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values({member:'owner',agent:'fiction'}).run();client.close();
 let pending:Promise<number>|undefined;
 vi.stubEnv('LOOM_WORKER_SOCKET',undefined);vi.stubEnv('LOOM_PUBLIC_URL',undefined);
 try{
  const commsKey=join(home,'comms.key');writeFileSync(commsKey,await generateX25519Identity(),{mode:0o600});
  const commons=join(home,'commons'),agent=join(home,'agents/fiction');
  writeFileSync(join(home,'program.json'),JSON.stringify({database,commsKey,signinMember:'owner',webRoot,memory:{checkingAgent:'fiction',sources:{commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:[{agent:'fiction',directory:agent,memories:join(agent,'memories.db')}]}}}),{mode:0o600});
  let ready!:(url:string)=>void;const started=new Promise<string>(resolve=>{ready=resolve;});
  pending=run(['--http','--home',home,'--host','127.0.0.1','--port','0'],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:()=>{},stderr:text=>{const match=/shared app on (\S+)/.exec(text);if(match)ready(match[1]);}});
  const url=await Promise.race([started,pending.then(code=>{throw Error('Normal startup stopped: '+code);})]);
  const expected=entries(readFileSync(join(webRoot,'index.html'),'utf8'));expect(expected.length).toBeGreaterThan(0);
  for(const path of ['/','/app/index.html','/app/next.html']){
   const response=await fetch(url+path);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/html');expect(entries(await response.text())).toEqual(expected);
  }
  for(const path of expected){expect(path).toMatch(/^\/app\/assets\/[^/]+\.js$/);const response=await fetch(url+path!);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toMatch(/javascript/);}
  expect(await (await fetch(url+'/auth/session')).json()).toEqual({viewer:null});
  expect((await fetch(url+'/live')).status).toBe(404);
 }finally{
  if(pending){process.emit('SIGTERM');expect(await pending).toBe(0);}
  vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true});
 }
});
