import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {chromium} from 'playwright-core';
import {exampleHome} from '../example-home.js';
import {startSharedHome} from '../shared-startup.js';
import {FakeClock} from '../core/clock.js';
import {dataDatabase} from '../core/data/database.js';
import {CommsMessages} from '../core/conversations/messages.js';
import {loadKey} from '../pieces/comms/crypto.js';
import {importArchivedQuestions} from '../core/conversations/archived-question-store.js';

it.runIf(process.env.LOOM_TEST_CHROME)('an archived question expires in the open private thread and retains its recorded outcome after restart',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'loom-archived-questions-')),home=join(temp,'home');
  const now=Date.now(),clock=new FakeClock(now),iso=(ms:number)=>new Date(ms).toISOString();
  const day=86400000,keepMs=90_000;
  let server:Awaited<ReturnType<typeof startSharedHome>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const boot=()=>startSharedHome({home,port:0,clock,webRoot:resolve('dist/web'),stdout:()=>{}});
  try {
    await exampleHome(home);
    const key=await loadKey(home), text='Which fictional plum tree?',why='The west bed needs water.';
    const client=new Database(join(home,'app.db')),db=dataDatabase(client,()=>iso(clock.now()));
    const oldPath=join(temp,'old.db'),metaPath=join(temp,'old-household.db');
    const old=new Database(oldPath),meta=new Database(metaPath);
    let thread:string;
    try{
      const svc=new CommsMessages(db,key,()=>iso(clock.now()));
      const t=svc.threads.open({id:'th:archived-questions',member:'alex',agent:'fern',title:'Old garden questions'});
      thread=t.id;
      meta.exec('create table comms_threads(id,agent,member,conversation)');
      meta.prepare('insert into comms_threads(id,agent,member,conversation) values(?,?,?,?)').run(t.id,'fern','alex',t.conversation);
      old.exec('create table comms_asks(thread,ref,approval,raised,seen,words,answer_json)');
      old.prepare('insert into comms_asks(thread,ref,approval,raised,seen,words,answer_json) values(?,?,?,?,?,?,?)').run(t.id,'approval:a-41','a-41',iso(now+day*9),iso(now-day*2+keepMs),
        await key.seal(JSON.stringify({text,why,kind:'question',if_yes:'Water the plums'})),JSON.stringify({verdict:'allowed',by:'alex',at:iso(now-1500)}));
    }finally{old.close();meta.close();}

    const archive=new Database(oldPath,{readonly:true}),household=new Database(metaPath,{readonly:true});
    try{
      const options={archive,household,destination:db,key,sourceDays:2,now:()=>iso(clock.now())};
      const counts=()=>['messages','turns','inbox','jobs','approvals'].map(t=>client.prepare('select count(*) n from '+t).get());
      const before=counts();
      expect(await importArchivedQuestions(options)).toEqual({total:1,inserted:1});
      expect(await importArchivedQuestions(options)).toEqual({total:1,inserted:0});
      const changed=new Database(oldPath);
      try {
        // The new question sorts before the conflicting previously imported one.
        changed.exec("insert into comms_asks(thread,ref,approval,raised,seen,words,answer_json) select thread,'a-first',null,raised,seen,words,null from comms_asks");
        changed.exec("update comms_asks set approval='different' where ref='approval:a-41'");
      } finally { changed.close(); }
      await expect(importArchivedQuestions(options)).rejects.toThrow('Conflicting archived question');
      expect(client.prepare('select ref from archived_questions').all()).toEqual([{ref:'approval:a-41'}]);
      // Cross the stored deadline after the insert pass but before publication.
      const fix=new Database(oldPath);
      try {fix.exec("delete from comms_asks where ref='a-first'; update comms_asks set approval='a-41'");} finally {fix.close();}
      client.exec('savepoint expiry_probe; delete from archived_questions');
      let reads=0;
      await importArchivedQuestions({...options,now:()=>iso(++reads<3?now:now+keepMs)});
      expect(client.prepare('select words from archived_questions').get()).toEqual({words:null});
      client.exec('rollback to expiry_probe; release expiry_probe');
      expect(counts()).toEqual(before);
    }finally{client.close();archive.close();household.close();}

    server=await boot();
    browser=await chromium.launch({executablePath:process.env.LOOM_TEST_CHROME});
    const ctx=await browser.newContext({serviceWorkers:'block'});
    const page=await ctx.newPage();
    await page.clock.install({time:now});
    await page.goto(server.signinLink('alex'));
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.locator('.next-shell').waitFor();
    await page.goto(server.url+'/p/comms-preview/thread/archived-questions');
    const history=page.getByRole('region',{name:'Archived questions'});
    await history.getByText(text,{exact:true}).waitFor();
    expect(await history.getByText(why,{exact:true}).count()).toBe(1);
    await history.getByText('If yes · Water the plums').waitFor();
    expect(await history.getByRole('button').count()).toBe(0);
    await history.getByText(/Recorded outcome · allowed/).waitFor();
    const query='query($thread:String!){commsArchivedQuestions(thread:$thread){ref body{text} verdict answeredBy}}';
    const read=async(member:string)=>{
      const app=server!,origin=new URL(app.url).origin;
      const login=await fetch(app.signinLink(member),{method:'POST',headers:{origin},redirect:'manual'});
      expect(login.status).toBe(303);
      const response=await fetch(origin+'/graphql',{method:'POST',headers:{origin,cookie:login.headers.get('set-cookie')!.split(';')[0],'content-type':'application/json'},
        body:JSON.stringify({query,variables:{thread}})});
      const result=await response.json();
      expect(result.errors).toBeUndefined();return result.data.commsArchivedQuestions;
    };
    expect(await read('robin')).toEqual([]);
    const document=await page.evaluate(()=>performance.timeOrigin);
    await page.clock.fastForward(keepMs+1);
    await history.getByText('Question text unavailable').waitFor();
    expect(await history.getByText(why).count()).toBe(0);
    expect(await page.evaluate(()=>performance.timeOrigin)).toBe(document);
    clock.advance(keepMs);
    await server.close();server=undefined;
    const after=new Database(join(home,'app.db'),{readonly:true});
    try{expect(after.prepare('select words, verdict from archived_questions').get()).toEqual({words:null,verdict:'allowed'});}finally{after.close();}
    server=await boot();
    expect(await read('alex')).toEqual([{ref:'approval:a-41',body:null,verdict:'allowed',answeredBy:'alex'}]);
    expect(await read('robin')).toEqual([]);
  }finally{await browser?.close();await server?.close();await rm(temp,{recursive:true,force:true});}
},60_000);
