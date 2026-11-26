import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bodyCredentials,bodyFixture} from '../test/fixtures/conversation-body.js';
import {messageFiles,messages} from './core/data/schema.js';
import {bodyCommandClient} from './runtime/body-command-client.js';
import {receiveChatFiles} from './runtime/body-attachments.js';

const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it('delivers exact private bytes once to the body holding the message and erases them with the text',async()=>{
  const f=await bodyFixture(clean);
  // Cross the ordinary JSON door limit with a real binary upload.
  const binary=Buffer.alloc(1024*1024+5,0xff);
  const files=[{name:'picture.png',contents:binary.toString('base64')},{name:'readme.txt',contents:Buffer.from('hello Art').toString('base64')}];
  const send=()=>f.root.http.request('/api/comms/send',{method:'POST',headers:{cookie:'loom_ui='+bodyCredentials.memberCookie,'content-type':'application/json'},
    body:JSON.stringify({input:{thread:f.thread.id,clientId:'picker-1',words:'',files},id:'send-files'})});
  const response=await send();
  expect(response.status).toBe(200);
  const {value:{item}}=await response.json();
  expect((await send()).status).toBe(200);
  const rows=f.db.select().from(messageFiles).all();
  expect(rows).toHaveLength(1);
  expect(rows[0].sealed.includes('picture.png')).toBe(false);
  expect((await f.call('messageFiles',{item},'before')).status).toBe(403);
  const take=await f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+bodyCredentials.body,'content-type':'application/json'},body:JSON.stringify({input:{}})});
  expect(take.status).toBe(200);
  expect((await take.json()).value.items[0].words).toBe('Attached files: ["picture.png","readme.txt"]');
  expect((await f.call('messageFiles',{item},'wrong',bodyCredentials.agent)).status).toBe(403);
  const client=bodyCommandClient({url:'http://127.0.0.1',token:bodyCredentials.body,signal:new AbortController().signal,fetch:(url,init)=>f.root.http.request(String(url),init)});
  clean.push(()=>client.close());
  const scratch=mkdtempSync(join(tmpdir(),'pair-files-test-'));
  clean.push(()=>rmSync(scratch,{recursive:true,force:true}));
  expect(await receiveChatFiles(client,[item],scratch)).toContain('Attached file "picture.png" is saved');
  expect(readFileSync(join(scratch,readdirSync(scratch)[0],'1-picture.png'))).toEqual(binary);
  expect(await receiveChatFiles(client,[item])).toContain('hello Art');
  f.root.writes.run(()=>f.db.update(messages).set({words:null}).run());
  expect(f.db.select().from(messageFiles).all()).toHaveLength(0);
  expect((await f.call('messageFiles',{item},'after')).status).toBe(404);
});
