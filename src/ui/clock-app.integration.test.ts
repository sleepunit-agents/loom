/** One browser proof: real operations/live feed, two windows, six looks/widths. */
import { it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { signin, hash } from '../core/signin/index.js';
import { runtimeStore } from '../pieces/runtime/store.js';
import type { Result } from '../core/index.js';
import { wakes } from '../pieces/clock/store.js';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture } from '../fixture.js';
import { importClock } from '../pieces/clock/importer.js';
import { wake } from '../pieces/clock/store.js';
import { load } from '../pieces/approvals/store.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'index.html')))('Clock shares changes across two windows, holds dispatch, and covers phone and desktop looks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-clock-browser-')); fixture(home);
  const source = join(home,'old'); mkdirSync(join(source,'art'),{recursive:true});
  writeFileSync(join(source,'art','spool.jsonl'), JSON.stringify({id:'w-aaaaaa',kind:'wake',for:'-',at:'2026-11-13 07:00:00',created:'2026-11-13 05:00:00',prompt:'Review these exact imported words',note:'Unknown imported review',origin:'agent:art'}));
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const loom = await startLoom({home,clock,next:true,stdout:()=>{},install(app) {
    importClock(app.db,source,clock.now());
  }});
  const auth = signin(loom);
  loom.db.transaction(()=>auth!.tokens.replace({v:1,tokens:[]},{}))();
  function session(member: string) {
    const bearer = randomBytes(32).toString('hex');
    auth!.tokens.change(tokens => tokens.push({role:'owner',member,label:`browser-${member}`,sha256:hash(bearer),created:new Date(clock.now()).toISOString()}));
    return auth!.createSession(hash(bearer));
  }
  const ownerSession = session('jonathan'), guestSession = session('pollock');
  const localCards:string[]=[];
  const privateThreads:string[]=[];
  const token=(role:string)=>{const bearer=randomBytes(32).toString('hex');auth.tokens.change(tokens=>tokens.push({role,label:'browser body fixture',sha256:hash(bearer),created:new Date(clock.now()).toISOString()}));return bearer;};
  const runner=token('runner:clock-fixture'),unbound=token('agent:art');
  expect(loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'clock-fixture',active:true},'fixture-enable-runner')).toMatchObject({ok:true});
  loom.db.transaction(()=>{const store=runtimeStore(loom.db);store.put('settings',{id:'art',agent:'art',boxes:['clock-fixture'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());store.put('box',{id:'clock-fixture',name:'Fixture',owner:'jonathan',local:true,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());})();
  let apiSeq=0;
  const post=async<T>(secret:string,name:string,input:object):Promise<T>=>{
    const [piece,op]=name.split('.');const response=await fetch(`${loom.url}/api/${piece}/${op}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id:`clock-browser-body:${++apiSeq}`})});
    const result=await response.json() as Result<T>;expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.message);return result.value;
  };
  let seq=0;
  const call = (op:string,input:object,who='jonathan') => { const r=loom.operations.call('direct',{kind:'member',id:who},`clock.${op}`,input,`fixture:clock:${++seq}`);expect(r).toMatchObject({ok:true});return r; };
  call('in',{agent:'art',prompt:'Review today’s work',note:'Morning review',when:'2h'});
  expect(await loom.operations.callAsync('socket',{kind:'member',id:'jonathan'},'clock.in',{agent:'art',member:'jonathan',prompt:'Private words',note:'Private clock work',when:'3h'},`fixture:private:${++seq}`,true)).toMatchObject({ok:true});
  call('in',{agent:'pond-bot',project:'pond',prompt:'Check pond',note:'Pond check',when:'1h'},'pollock');
  call('laneSet',{name:'morning',agent:'art',text:'Look at the queue and choose useful work.',note:'Daily planning',at:'08:31',days:'Mon-Fri'});
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    context.setDefaultTimeout(10_000);
    await context.grantPermissions(['local-network-access'],{origin:loom.url});
    const staticFiles=async(route:import('playwright-core').Route)=>{
      const url=new URL(route.request().url());if(url.pathname==='/live'||url.pathname.startsWith('/api/'))return route.continue();
      const path=url.pathname.startsWith('/app/')?resolve(root,url.pathname.slice(5)):join(root,'index.html');
      if(!path.startsWith(`${root}/`)||!existsSync(path))return route.fulfill({status:404,body:''});
      return route.fulfill({body:readFileSync(path),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'} as Record<string,string>)[extname(path)]??'application/octet-stream'});
    };
    await context.addCookies([{name:'loom_ui',value:ownerSession,url:loom.url}]);
    await context.route('**/*',staticFiles);
    const a=await context.newPage(),b=await context.newPage();
    let dropLocalAck=false, lostLocalId:string|undefined, releaseLocalReplay:(()=>void)|undefined;
    const localWires:string[]=[];
    await b.routeWebSocket('**/live',ws=>{
      const server=ws.connectToServer();
      ws.onMessage(message=>{
        const packet=JSON.parse(String(message));
        if(packet.kind==='call' && packet.name==='clock.scheduleLocalFromWindow') {
          if(dropLocalAck)lostLocalId=packet.id;
          if(packet.id===lostLocalId) {
            localWires.push(String(message));
            if(!dropLocalAck) { releaseLocalReplay=()=>server.send(message);return; }
          }
        }
        server.send(message);
      });
      server.onMessage(message=>{
        const packet=JSON.parse(String(message));
        if(dropLocalAck && packet.kind==='result' && packet.request===lostLocalId && packet.result.ok) {
          dropLocalAck=false;ws.close();server.close();return;
        }
        ws.send(message);
      });
    });
    // These are real private threads and runner-issued body credentials. The
    // harness stands in for the model tool call, not the authority resolver.
    for(const note of ['Allow once','Deny this job','Standing job']) {
      const prompt=`<!-- house: local -->\nReport host disk usage: ${note}.`;
      const message=`Please file these exact words for my local-work decision, without scheduling yet:\n${prompt}\nNote: ${note}`;
      await a.goto(`${loom.url}/p/clock-preview`);
      await a.getByRole('button',{name:/Local requests/}).click();
      await a.getByRole('link',{name:'Ask an agent for local work',exact:true}).click();
      await expect.poll(()=>new URL(a.url()).pathname).toBe('/p/comms-preview/new');
      await expect.poll(()=>a.getByRole('textbox',{name:'Message',exact:true}).count()).toBe(1);
      await a.getByRole('textbox',{name:'Message',exact:true}).fill(message);
      await a.getByRole('button',{name:'Send',exact:true}).click();
      await expect.poll(()=>new URL(a.url()).pathname.includes('/thread/')).toBe(true);
      const thread=`th:${new URL(a.url()).pathname.split('/thread/')[1]}`;privateThreads.push(thread);
      expect(load(loom.db).approvals.filter(card=>card.kind==='local-wake')).toHaveLength(localCards.length);
      let job='';
      await expect.poll(async()=>{const result=await post<{jobs:string[]}>(runner,'runtime.claimableJobs',{});job=result.jobs[0]??'';return !!job;}).toBe(true);
      await post(runner,'runtime.claimJob',{job});
      const input=await post<{credential:string}>(runner,'runtime.takeInput',{job});
      expect(JSON.stringify(input)).not.toContain(message);
      await post(runner,'runtime.reportJob',{job,state:'running'});
      const read=await post<{messages:{text:string}[]}>(input.credential,'runtime.readConversation',{});
      expect(read.messages.map(m=>m.text)).toContain(message);
      for(const secret of [runner,unbound]) {
        const denied=await fetch(`${loom.url}/api/clock/requestLocal`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input:{agent:'art',prompt,note},id:`not-body:${++apiSeq}`})});
        expect(await denied.json()).toMatchObject({ok:false});
      }
      const card=await post<{id:string;state:string}>(input.credential,'clock.requestLocal',{agent:'art',prompt,note});
      expect(Object.keys(card).sort()).toEqual(['id','state']);localCards.push(card.id);
      const saved=load(loom.db).approvals.find(c=>c.id===card.id)!;
      expect(saved).toMatchObject({member:'jonathan',people:['jonathan'],conversation:runtimeStore(loom.db).read('job',job)!.conversation,state:'pending'});
      expect(saved.details).toContain(prompt);expect(saved.details).toContain(note);
      expect(wakes(loom.db).filter(w=>w.approval===card.id)).toHaveLength(0);
      await post(input.credential,'runtime.reply',{id:`filing-reply:${card.id}`,text:`Filed for your decision; nothing scheduled. [Review local request](/p/clock-preview/item/${card.id})`});
      await a.getByRole('link',{name:'Review local request',exact:true}).click();
      await expect.poll(()=>a.getByRole('group',{name:'Answer approval'}).count()).toBe(1);
      await expect.poll(()=>a.getByText(prompt,{exact:false}).count()).toBeGreaterThan(0);
    }
    call('park',{agent:'art',prompt:'Continue after the answer',note:'Waiting for the owner',on:localCards[0]});
    await Promise.all([a.goto(`${loom.url}/p/clock-preview`),b.goto(`${loom.url}/p/clock-preview`)]);
    const row=(p:typeof a,text:string)=>p.locator('[data-split-row]').filter({hasText:text});
    console.info('Clock browser: initial windows');
    await expect.poll(()=>row(b,'Morning review').count()).toBe(1);
    await expect.poll(()=>row(b,'Private clock work').count()).toBe(1);
    await a.getByRole('button',{name:'Create wake',exact:true}).click();
    await a.getByRole('textbox',{name:'Note',exact:true}).fill('Shared follow-up');
    await a.getByRole('textbox',{name:'In',exact:true}).fill('4h');
    await a.getByRole('textbox',{name:'Words or file path',exact:true}).fill('Finish the useful work');
    await a.getByRole('button',{name:'Save wake',exact:true}).click();
    await expect.poll(()=>row(b,'Shared follow-up').count()).toBe(1);
    await a.getByRole('button',{name:'Back to clock',exact:true}).click();
    await a.getByRole('button',{name:'Pause art',exact:true}).click();
    await a.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Pause art',exact:true}).click();
    await expect.poll(()=>b.getByRole('button',{name:'Resume art',exact:true}).count()).toBe(1);
    await row(b,'Waiting for the owner').click();
    await expect.poll(()=>b.getByText('Parked · awaiting answer',{exact:false}).count()).toBeGreaterThan(0);
    expect(await b.getByText(`Waiting on ${localCards[0]} until`,{exact:false}).count()).toBe(1);
    await row(a,'Shared follow-up').click();
    await a.getByRole('button',{name:'Cancel wake',exact:true}).click();
    await a.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Cancel wake',exact:true}).click();
    await expect.poll(()=>row(b,'Shared follow-up').count()).toBe(0);
    await b.getByRole('button',{name:/Household lanes/}).click();
    await row(b,'morning').click();
    await b.getByRole('button',{name:'Edit lane',exact:true}).click();
    await b.getByRole('textbox',{name:'Lane text',exact:true}).fill('The edited lane text reaches every window.');
    await b.getByRole('button',{name:'Save lane',exact:true}).click();
    await a.getByRole('button',{name:/Household lanes/}).click();await row(a,'morning').click();
    await expect.poll(()=>a.getByText('The edited lane text reaches every window.',{exact:true}).count()).toBe(1);
    await b.getByRole('button',{name:'Back to clock',exact:true}).click();
    await row(b,'morning').click();
    await b.getByRole('textbox',{name:'Assign to',exact:true}).fill('mark');await b.getByRole('button',{name:'Reassign lane',exact:true}).click();
    await b.getByRole('button',{name:'Confirm reassignment',exact:true}).click();
    await expect.poll(()=>a.getByText('mark · Enabled',{exact:true}).count()).toBe(1);
    await b.reload();await expect.poll(()=>b.getByText('mark · Enabled',{exact:true}).count()).toBe(1);
    console.info('Clock browser: ordinary controls complete');
    // Only eligible owner adoption is offered; preserve saved words and time.
    await b.getByRole('button',{name:/^Wakes/}).click(); await row(b,'Unknown imported review').click();
    await expect.poll(()=>b.getByRole('button',{name:'Count as my work',exact:true}).count()).toBe(1);
    expect(await b.getByRole('button',{name:'Run now',exact:true}).count()).toBe(0);
    const original = wake(loom.db,'w-aaaaaa')!;
    await b.getByRole('button',{name:'Ask owner to count this work',exact:true}).click();
    await expect.poll(()=>b.getByText('Ask the household owner to count this imported wake as their work?',{exact:false}).count()).toBe(1);
    expect(await b.getByText('Review these exact imported words',{exact:true}).count()).toBe(1);
    /* Local request screenshots below include the exact words and live decisions. */
    const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/clock-app');mkdirSync(shots,{recursive:true});
    await b.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Ask owner to count this work',exact:true}).click();
    await expect.poll(()=>b.getByText(/Owner request a-[0-9a-f]+: pending. Work stays held until allowed./).count()).toBe(1);
    expect(wake(loom.db,'w-aaaaaa')).toEqual(original);
    const cards = load(loom.db).approvals.filter(card=>card.kind==='vouch-wake');
    expect(cards).toHaveLength(1); expect(cards[0]).toMatchObject({target:'art:w-aaaaaa',state:'pending'});
    expect(cards[0].details).toContain('w-aaaaaa fires '+new Date(original.due).toISOString());
    // Explicit filing changes no work; the existing direct owner action still works.
    await b.getByRole('button',{name:'Count as my work',exact:true}).click();
    await b.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Count as my work',exact:true}).click();
    await expect.poll(()=>b.getByText('Counted 1 as your work; 0 unchanged',{exact:true}).count()).toBe(1);
    await expect.poll(()=>b.getByRole('button',{name:'Count as my work',exact:true}).count()).toBe(0);
    expect(wake(loom.db,'w-aaaaaa')).toMatchObject({prompt:original.prompt,due:original.due,by:{kind:'member',id:'jonathan'},state:'pending'});
    await a.getByRole('button',{name:/^Wakes/}).click(); await row(a,'Unknown imported review').click();
    await expect.poll(()=>a.getByRole('button',{name:'Count as my work',exact:true}).count()).toBe(0);
    await b.getByRole('button',{name:'Keep unchanged',exact:true}).count().then(n=>expect(n).toBe(0));
    await b.getByRole('button',{name:/Household lanes/}).click(); await row(b,'morning').click();
    // Confirmations remain usable while the phone reader covers its list.
    await b.setViewportSize({width:390,height:900});await b.getByRole('button',{name:'Run once',exact:true}).click();
    await b.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Run once',exact:true}).click();
    await expect.poll(()=>b.getByText('Saved',{exact:true}).count()).toBe(1);
    clock.advance(0);
    await expect.poll(()=>{const r=loom.operations.call('direct',{kind:'member',id:'jonathan'},'clock.list',{});return r.ok&&(r.value as Array<{hold?:string}>).some(w=>w.hold==='staging');}).toBe(true);
    console.info('Clock browser: vouch and lane complete');
    // Keep the pending live record constant while varying only the owning open
    // response. This discriminates the reader's independent preflight checks.
    let openMode: 'pass' | 'hold' | 'denied' | 'closed' = 'hold';
    let releaseOpen: ((result: Awaited<ReturnType<typeof loom.operations.callAsync>>) => void) | undefined;
    const opened=(open:boolean,mayAnswer:boolean)=>({ok:true as const,value:{open,mayAnswer,mayEveryTime:true,mayAlways:false}});
    let holdClock=false;
    let releaseClock: ((result: Awaited<ReturnType<typeof loom.operations.callAsync>>) => void) | undefined;
    const actualCall=loom.operations.callAsync.bind(loom.operations);
    const calls=vi.spyOn(loom.operations,'callAsync').mockImplementation((...args)=>{
      if(args[2]==='approvals.open') {
        if(openMode==='hold')return new Promise(resolve=>{releaseOpen=resolve;});
        if(openMode==='denied')return Promise.resolve(opened(true,false));
        if(openMode==='closed')return Promise.resolve(opened(false,true));
      }
      if(holdClock && ['clock.pause','clock.resume'].includes(args[2]))return new Promise(resolve=>{releaseClock=resolve;});
      return actualCall(...args);
    });
    const decisions=()=>calls.mock.calls.filter(args=>['approvals.answer','approvals.every-time'].includes(args[2])).length;
    await b.setViewportSize({width:1280,height:900});
    await b.getByRole('button',{name:/Local requests/}).click();
    await expect.poll(()=>b.getByRole('group',{name:'Local requests'}).locator('[data-split-row]').count()).toBe(3);
    await b.getByRole('searchbox',{name:'Search clock',exact:true}).fill('no-such-local-request');
    await expect.poll(()=>b.getByText('Nothing matches “no-such-local-request”',{exact:true}).count()).toBe(1);
    await b.getByRole('searchbox',{name:'Search clock',exact:true}).fill('');
    const openLocal=async(p:typeof a,index:number)=>{await p.goto(`${loom.url}/p/clock-preview/item/${localCards[index]}`);await expect.poll(()=>p.getByRole('group',{name:'Answer approval'}).count()).toBe(1);};
    await row(b,'Allow once').click();
    await expect.poll(()=>!!releaseOpen).toBe(true);
    expect(await b.getByRole('group',{name:'Answer approval'}).count()).toBe(0);
    expect(decisions()).toBe(0);
    releaseOpen!(opened(true,false));
    await expect.poll(()=>b.getByText('You cannot answer this question.',{exact:true}).count()).toBe(1);
    expect(await b.getByRole('group',{name:'Answer approval'}).count()).toBe(0);
    openMode='closed';await b.getByRole('button',{name:'Check again',exact:true}).click();
    await expect.poll(()=>calls.mock.calls.filter(args=>args[2]==='approvals.open').length).toBe(2);
    expect(await b.getByRole('group',{name:'Answer approval'}).count()).toBe(0);
    openMode='pass';await b.getByRole('button',{name:'Check again',exact:true}).click();
    await expect.poll(()=>b.getByRole('group',{name:'Answer approval'}).count()).toBe(1);
    openMode='hold';releaseOpen=undefined;await b.getByRole('button',{name:'Allow',exact:true}).click();
    await expect.poll(()=>!!releaseOpen).toBe(true);
    expect(await b.getByRole('button',{name:'Allow',exact:true}).isEnabled()).toBe(false);
    expect(decisions()).toBe(0);
    releaseOpen!(opened(false,true));
    await expect.poll(()=>b.getByRole('group',{name:'Answer approval'}).count()).toBe(0);
    expect(decisions()).toBe(0);
    expect(load(loom.db).approvals.find(card=>card.id===localCards[0])?.state).toBe('pending');
    openMode='pass';await b.getByRole('button',{name:'Check again',exact:true}).click();
    await expect.poll(()=>b.getByRole('group',{name:'Answer approval'}).count()).toBe(1);
    openMode='denied';await b.getByRole('button',{name:'Allow',exact:true}).click();
    await expect.poll(()=>b.getByRole('group',{name:'Answer approval'}).count()).toBe(0);
    expect(decisions()).toBe(0);
    openMode='pass';await b.getByRole('button',{name:'Check again',exact:true}).click();
    await expect.poll(()=>b.getByRole('group',{name:'Answer approval'}).count()).toBe(1);
    const exactDetails=load(loom.db).approvals.find(card=>card.id===localCards[0])!.details;
    await expect.poll(()=>b.getByRole('heading',{name:'Details',exact:true}).locator('..').locator('p').textContent()).toBe(exactDetails);
    console.info('Clock browser: decision reader guards complete');
    // Delay one feed's snapshots without changing authentication, records or the
    // other feeds. Each page still connects to the real signed-in Live socket.
    let maskedFeed: 'approval' | 'clock' | undefined;
    await a.routeWebSocket('**/live',ws=>{
      const server=ws.connectToServer();
      server.onMessage(message=>{
        const packet=JSON.parse(String(message));
        if(['set','put','del'].includes(packet.kind) && (maskedFeed==='approval' ? packet.type==='approval' : maskedFeed==='clock' && ['wake','schedule','clock'].includes(packet.type)))return;
        ws.send(message);
      });
    });
    maskedFeed='approval';await a.goto(`${loom.url}/p/clock-preview`);
    await expect.poll(()=>a.getByRole('button',{name:'Create wake',exact:true}).isEnabled()).toBe(true);
    await a.getByRole('button',{name:/Local requests/}).click();
    await expect.poll(()=>a.getByText('Opening local requests…',{exact:true}).count()).toBe(1);
    expect(await a.getByRole('group',{name:'Answer approval'}).count()).toBe(0);
    maskedFeed='clock';await openLocal(a,0);
    expect(await a.getByRole('button',{name:'Allow',exact:true}).isEnabled()).toBe(true);
    maskedFeed=undefined;await a.goto(`${loom.url}/p/clock-preview`);
    await expect.poll(()=>a.getByRole('button',{name:'Resume art',exact:true}).isEnabled()).toBe(true);
    holdClock=true;await a.getByRole('button',{name:'Resume art',exact:true}).click();
    await a.getByRole('region',{name:'Confirm clock action'}).getByRole('button',{name:'Resume art',exact:true}).click();
    await expect.poll(()=>!!releaseClock).toBe(true);
    expect(await a.getByRole('button',{name:'Create wake',exact:true}).isEnabled()).toBe(false);
    await a.getByRole('button',{name:/Local requests/}).click();await row(a,'Allow once').click();
    await expect.poll(()=>a.getByRole('group',{name:'Answer approval'}).count()).toBe(1);
    expect(await a.getByRole('button',{name:'Allow',exact:true}).isEnabled()).toBe(true);
    holdClock=false;releaseClock!({ok:false,code:'unavailable',message:'Fixture released held ordinary write'});

    console.info('Clock browser: independent readiness complete');
    const beforeLocal=wakes(loom.db).length;
    await b.getByRole('group',{name:'Answer approval'}).getByRole('button',{name:'Allow',exact:true}).click();
    await expect.poll(()=>load(loom.db).approvals.find(card=>card.id===localCards[0])?.state).toBe('allowed');
    await expect.poll(()=>a.getByText('local-wake · allowed',{exact:true}).count()).toBe(1);
    expect(await a.getByRole('group',{name:'Answer approval'}).count()).toBe(0);
    // Decision alone starts nothing. Timing is explicit and the window never
    // sends words or a reconstructed Caller to the recovery backend.
    expect(wakes(loom.db)).toHaveLength(beforeLocal);
    await expect.poll(()=>b.getByRole('form',{name:'Local work timing'}).count()).toBe(1);
    console.info('Clock browser: allowed timing opened');
    const timing=b.getByRole('form',{name:'Local work timing'});
    await timing.getByRole('textbox',{name:'When',exact:true}).fill('not a date');
    await timing.getByLabel('Use approval',{exact:true}).selectOption('once');
    await timing.getByRole('button',{name:'Review timing',exact:true}).click();
    expect(await b.getByRole('region',{name:'Confirm local timing'}).count()).toBe(0);
    await timing.getByLabel('Timing',{exact:true}).selectOption('at');
    await timing.getByRole('button',{name:'Review timing',exact:true}).click();
    expect(wakes(loom.db)).toHaveLength(beforeLocal);
    await b.getByRole('button',{name:'Schedule these saved words',exact:true}).click();
    await expect.poll(()=>b.getByText('Couldn’t schedule local work',{exact:true}).count()).toBe(1);
    expect(wakes(loom.db)).toHaveLength(beforeLocal);
    await timing.getByRole('textbox',{name:'When',exact:true}).fill('2026-11-13 09:31');
    await timing.getByRole('button',{name:'Review timing',exact:true}).click();
    console.info('Clock browser: timing reviewed');
    const confirmation=b.getByRole('region',{name:'Confirm local timing'});
    expect(await b.getByText('Couldn’t schedule local work',{exact:true}).count()).toBe(0);
    expect(await confirmation.getByText(exactDetails!,{exact:true}).count()).toBe(1);
    expect(await confirmation.getByText('At (CT): 2026-11-13 09:31',{exact:true}).count()).toBe(1);
    expect(await confirmation.getByText('Spend one-time Allow',{exact:true}).count()).toBe(1);
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){
      await b.setViewportSize({width,height:900});await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      await confirmation.scrollIntoViewIfNeeded();
      await b.screenshot({path:join(shots,`clock-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    console.info('Clock browser: screenshots complete');
    dropLocalAck=true;
    await b.getByRole('button',{name:'Schedule these saved words',exact:true}).click();
    console.info('Clock browser: lost ack waiting replay');
    await expect.poll(()=>!!releaseLocalReplay).toBe(true);
    expect(wakes(loom.db).filter(w=>w.approval===localCards[0])).toHaveLength(1);
    await b.getByRole('button',{name:/^Wakes/}).click();
    await b.getByRole('button',{name:/Local requests/}).click();await row(b,'Allow once').click();
    await expect.poll(()=>b.getByRole('button',{name:'Review timing',exact:true}).isEnabled()).toBe(false);
    expect(localWires).toHaveLength(2);expect(localWires[1]).toBe(localWires[0]);
    console.info('Clock browser: reader reopened releasing replay');
    releaseLocalReplay!();
    await expect.poll(()=>wakes(loom.db).filter(w=>w.approval===localCards[0]).length).toBe(1);
    const localOnce=wakes(loom.db).find(w=>w.approval===localCards[0])!;
    expect(localOnce).toMatchObject({member:'jonathan',prompt:'<!-- house: local -->\nReport host disk usage: Allow once.',note:'Allow once',due:Date.parse('2026-11-13T15:31:00Z')});
    await expect.poll(()=>b.getByText(/Saved wake .*Local delivery remains held./).count()).toBe(1);
    const scheduleCalls=()=>calls.mock.calls.filter(args=>args[2]==='clock.scheduleLocalFromWindow');
    expect(scheduleCalls().at(-1)?.[3]).toEqual({approval:localCards[0],mode:'at',when:'2026-11-13 09:31',standing:false});
    await b.getByRole('button',{name:/^Wakes/}).click();await row(b,'Morning review').click();
    expect(await b.getByText('Saved',{exact:true}).count()).toBe(0);
    expect(await b.getByText(/Saved wake .*Local delivery remains held./).count()).toBe(0);
    await openLocal(b,1);await b.getByRole('button',{name:'Deny',exact:true}).click();
    await expect.poll(()=>load(loom.db).approvals.find(card=>card.id===localCards[1])?.state).toBe('denied');
    await openLocal(b,2);await b.getByRole('button',{name:'Allow every time',exact:true}).click();
    await expect.poll(()=>load(loom.db).standing.length).toBe(1);
    expect(wakes(loom.db)).toHaveLength(beforeLocal+1);
    await expect.poll(()=>b.getByRole('form',{name:'Local work timing'}).count()).toBe(1);
    await b.getByRole('form',{name:'Local work timing'}).getByLabel('Timing',{exact:true}).selectOption('in');
    await b.getByRole('form',{name:'Local work timing'}).getByRole('textbox',{name:'When',exact:true}).fill('3h');
    await b.getByRole('form',{name:'Local work timing'}).getByLabel('Use approval',{exact:true}).selectOption('standing');
    await b.getByRole('button',{name:'Review timing',exact:true}).click();
    await b.getByRole('button',{name:'Schedule these saved words',exact:true}).click();
    await expect.poll(()=>wakes(loom.db).filter(w=>w.approval===localCards[2]).length).toBe(1);
    expect(load(loom.db).standing[0].uses).toBe(1);
    expect(wakes(loom.db).find(w=>w.approval===localCards[2])).toMatchObject({member:'jonathan',prompt:'<!-- house: local -->\nReport host disk usage: Standing job.',note:'Standing job',due:clock.now()+3*3600_000});
    expect(scheduleCalls().at(-1)?.[3]).toEqual({approval:localCards[2],mode:'in',when:'3h',standing:true});
    expect(await b.getByRole('button',{name:'Run now',exact:true}).count()).toBe(0);
    const guest=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await guest.grantPermissions(['local-network-access'],{origin:loom.url});await guest.addCookies([{name:'loom_ui',value:guestSession,url:loom.url}]);await guest.route('**/*',staticFiles);
    const p=await guest.newPage();await p.goto(`${loom.url}/p/clock-preview`);await expect.poll(()=>row(p,'Pond check').count()).toBe(1);
    expect(await row(p,'Private clock work').count()).toBe(0);expect(await row(p,'Morning review').count()).toBe(0);
    await p.goto(`${loom.url}/p/clock-preview/item/${localCards[0]}`);
    await expect.poll(()=>p.getByText('This work is no longer in view',{exact:true}).count()).toBe(1);
    expect(await p.getByText('Report host disk usage: Allow once.',{exact:false}).count()).toBe(0);
    expect(await p.getByRole('button',{name:'Allow',exact:true}).count()).toBe(0);
    await p.goto(`${loom.url}/p/comms-preview/thread/${privateThreads[0].replace(/^th:/,'')}`);
    await expect.poll(()=>p.getByText('This thread is no longer in view',{exact:true}).count()).toBe(1);
    expect(await p.getByText('Please file these exact words',{exact:false}).count()).toBe(0);
    await guest.close();
  }finally{await browser.close();await loom.close();rmSync(home,{recursive:true,force:true});}
},60_000);
