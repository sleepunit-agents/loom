import { expect, it } from 'vitest';
import { replyHtml } from '../../web/src/pieces/comms/render.js';
it('preserves Comms reply sanitising: no HTML, images, insecure schemes, or arbitrary internal links',()=>{
 const html=replyHtml('<script>alert(1)</script> ![image](https://evil.invalid/x) [bad](javascript:alert(1)) [insecure](http://evil.invalid) [inside](https://loom.invalid/a/art/anything) [ok](https://example.com)');
 expect(html).not.toMatch(/<script|<img|href="(?:javascript:|http:|https:\/\/loom.invalid)/i);expect(html).toContain('href="https://example.com"');expect(html).toContain('noopener noreferrer');
});

import { afterEach, vi } from 'vitest';
import { readDraft, writeDraft, editDraft, clearDraft, draftKey } from '../../web/src/pieces/comms/drafts.js';
afterEach(()=>vi.unstubAllGlobals());
function draftStorage(){
 const values=new Map<string,string>();
 vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
 return values;
}
it('keeps a base32 message id through failed sends and reloads, rotating only when words change',()=>{
 draftStorage();
 const draft=editDraft(readDraft('jonathan','new:art'),'Send these words');writeDraft('jonathan','new:art',draft);
 expect(draft.id).toMatch(/^[a-z2-7]{16}$/);
 const retry=readDraft('jonathan','new:art');expect(retry).toEqual(draft);
 expect(editDraft(retry,retry.text)).toBe(retry);
 const changed=editDraft(retry,'Different words');expect(changed.id).not.toBe(retry.id);
 writeDraft('jonathan','new:art',changed);
 // A delayed success for the previous send cannot clear this changed draft.
 clearDraft('jonathan','new:art',retry);expect(readDraft('jonathan','new:art')).toEqual(changed);
 clearDraft('jonathan','new:art',changed);expect(readDraft('jonathan','new:art').text).toBe('');
});
it('partitions draft words and retry ids by member and thread, and upgrades text-only drafts',()=>{
 const storage=draftStorage();storage.set(draftKey('jonathan','th:one'),'Legacy words');
 const legacy=readDraft('jonathan','th:one');expect(legacy.text).toBe('Legacy words');expect(legacy.id).toMatch(/^[a-z2-7]{16}$/);
 expect(storage.has(draftKey('jonathan','th:one'))).toBe(false);
 expect(readDraft('jonathan','th:one')).toEqual(legacy);
 expect(readDraft('other','th:one').text).toBe('');expect(readDraft('jonathan','th:two').text).toBe('');
});
it('keeps the in-memory retry id when device storage is unavailable',()=>{
 vi.stubGlobal('localStorage',{getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');},removeItem:()=>{throw new Error('denied');}});
 const draft=editDraft(readDraft('jonathan','th:one'),'Unsaved locally');
 expect(()=>writeDraft('jonathan','th:one',draft)).not.toThrow();
 expect(editDraft(draft,draft.text).id).toBe(draft.id);expect(()=>clearDraft('jonathan','th:one',draft)).not.toThrow();
});

import { latestHarness, messageView, type Message } from '../../web/src/pieces/comms/message.js';
import { workingView } from '../../web/src/pieces/comms/working.js';
it('ages a connected working spell into quiet and stuck, refreshing only for body movement',()=>{
 const since=Date.parse('2026-11-13T05:00:00Z'),t={agent:'art',working:true,workingSince:since};
 expect(workingView(t,[],since+119999,true)?.face).toBe('working');
 expect(workingView(t,[],since+120000,true)).toMatchObject({face:'quiet',text:'Quiet for 2m 0s — art is still running'});
 expect(workingView(t,[],since+720000,true)).toMatchObject({face:'stuck',text:expect.stringContaining('it may be stuck')});
 expect(workingView({...t,alive:{at:since+719000,tokens:0}},[],since+720000,true)?.face).toBe('working');
 expect(workingView({...t,alive:{at:since+800000}},[],since+720000,true)?.face).toBe('working');
 expect(workingView(t,[],since+720000,false)).toBeNull();expect(workingView({...t,working:false},[],since+720000,true)).toBeNull();
});
it('uses retained current and imported step times, including any overdue running helper, without prior-turn or plan alarms',()=>{
 const since=Date.parse('2026-11-13T05:00:00Z'),t={agent:'art',working:true,workingSince:since};
 const base:Message={id:'th/1',thread:'th',seq:1,at:since,kind:'card',from:'art',text:'Run the tests',tool:'shell',state:'running',step:{t0:new Date(since).toISOString(),limit:60}};
 expect(workingView(t,[base],since+90000,true)?.face).toBe('working');
 expect(workingView(t,[base],since+90001,true)).toMatchObject({face:'stuck',text:expect.stringContaining('past its limit')});
 const child={...base,id:'th/2',seq:2,text:'Read a file',at:since+90000,step:{t0:new Date(since+90000).toISOString(),limit:300}};
 expect(workingView(t,[base,child],since+90001,true)?.text).toContain('Run the tests');
 expect(workingView(t,[{...base,text:null}],since+90001,true)?.face).toBe('working');
 expect(workingView(t,[{...base,step:{t0:new Date(since-61000).toISOString(),limit:1}}],since+90001,true)?.face).toBe('working');
 expect(workingView(t,[{...base,tool:'TodoWrite',step:{limit:1}}],since+90001,true)?.face).toBe('working');
 const imported={...base,tool:undefined,state:undefined,step:undefined,card:{tool:'shell',state:'done',t0:new Date(since).toISOString(),t1:new Date(since+710000).toISOString()}};
 expect(workingView(t,[imported],since+720000,true)?.face).toBe('working');
});
it('maps legacy nested cards and asks while preserving current runtime records',()=>{
 const base:Message={id:'th/1',thread:'th',seq:1,at:0,kind:'card',from:'art',text:'Ran tests'};
 expect(messageView({...base,card:{tool:'shell',state:'done',step:{output:'passed'}}})).toMatchObject({tool:'shell',state:'done',step:{output:'passed'}});
 expect(messageView({...base,tool:'current',state:'running',step:{body:'current'},card:{tool:'old',state:'done',step:{body:'old'}}})).toMatchObject({tool:'current',state:'running',step:{body:'current'}});
 const ask={...base,kind:'ask',text:null,ref:'approval:one',ask:{text:'Continue?',why:'Tests passed',if_yes:'I continue',if_no:'I stop'}};
 expect(messageView(ask).ask).toMatchObject({question:'Continue?',why:'Tests passed',yes:'I continue',no:'I stop',canAnswer:true});
 expect(messageView({...ask,answer:{verdict:'denied',by:'jonathan'}}).ask).toMatchObject({answer:'denied',answered:true,canAnswer:false});
 expect(messageView({...ask,ask:{ask:'Which?',answers:'words'}}).ask?.canAnswer).toBe(false);
 expect(messageView({...ask,ref:undefined}).ask?.canAnswer).toBe(false);
 expect(messageView({...base,text:null})).toEqual({text:null,tool:undefined,state:undefined,step:undefined,ask:undefined,nextRetry:undefined,retryStart:undefined});
});

it('shows a retained start retry time, hiding it after settlement, failure or expiry',()=>{
 const m:Message={id:'th/2',thread:'th',seq:2,at:0,kind:'error',from:'art',text:"Art couldn't start; retrying.",step:{error:'start-retry',retry_at:'2026-11-13T05:30:00Z',reason:'private host reason'}};
 expect(messageView(m)).toMatchObject({nextRetry:'2026-11-13T05:30:00.000Z'});
 expect(messageView({...m,step:{...m.step as object,settled:true}}).nextRetry).toBeUndefined();
 expect(messageView({...m,step:{error:'start-failed',retry_at:'2026-11-13T05:30:00Z'}}).nextRetry).toBeUndefined();
 expect(messageView({...m,text:null}).nextRetry).toBeUndefined();
 expect(messageView({...m,kind:'card'}).nextRetry).toBeUndefined();
 for(const retry_at of ['not a date','',17,null])expect(messageView({...m,step:{error:'start-retry',retry_at}}).nextRetry).toBeUndefined();
 // Imported error cards keep the retry metadata on card itself.
 expect(messageView({...m,step:undefined,card:{error:'start-retry',retry_at:'2026-11-13T05:30:00Z'}}).nextRetry).toBe('2026-11-13T05:30:00.000Z');
});

it('offers final-start retry only from a retained authorized backend projection',()=>{
 const m:Message={id:'th/2',thread:'th',seq:2,at:1,kind:'error',from:'art',text:"Art couldn't start.",step:{error:'start-failed'},retryStart:{seq:1,generation:0}};
 expect(messageView(m).retryStart).toEqual({seq:1,generation:0});
 for(const change of [{text:null},{retryStart:undefined},{step:{error:'start-retry'}},{retryStart:{seq:1,generation:-1}}])expect(messageView({...m,...change}).retryStart).toBeUndefined();
});

import { EarlierPages, retainedMessage } from '../../web/src/pieces/comms/pages.js';
it('expires earlier-page words, imported asks and every private field at the server deadline',()=>{
 const m:Message={id:'th/1',thread:'th',seq:1,at:0,kind:'ask',from:'art',text:null,keepUntil:100,ask:{ask:'Private question'},answer:{verdict:'yes'},card:{tool:'private tool'},step:{body:'private output'},retryStart:{seq:1,generation:0},ref:'private-ref'};
 const pages=new EarlierPages();pages.accept(pages.begin(),[m],99);
 expect(messageView(pages.rows[0]).ask?.question).toBe('Private question');
 pages.expire(100);expect(pages.rows).toEqual([{id:'th/1',thread:'th',seq:1,at:0,kind:'ask',from:'art',text:null}]);
 expect(retainedMessage({...m,text:'Private message'},101).text).toBeNull();
 for(const keepUntil of [undefined,null,'100',NaN,Infinity])expect(retainedMessage({...m,keepUntil},0).text).toBeNull();
});
it('discards disconnected or unmounted page responses and expires delayed pages before caching',()=>{
 const pages=new EarlierPages(),old=pages.begin();pages.clear();
 const m:Message={id:'th/1',thread:'th',seq:1,at:0,kind:'reply',from:'art',text:'Private reply',keepUntil:100};
 expect(pages.accept(old,[m],10)).toBe(false);expect(pages.rows).toEqual([]);
 expect(pages.accept(pages.begin(),[m],100)).toBe(true);expect(JSON.stringify(pages.rows)).not.toContain('Private reply');
 pages.accept(pages.begin(),[{...m,id:'th/2',seq:2,keepUntil:200}],100);
 pages.accept(pages.begin(),[m],100);expect(pages.rows.map(m=>m.seq)).toEqual([1,2]);
});

import { ConversationPages, retainedStep, type ConversationStep } from '../../web/src/pieces/comms/conversation-pages.js';
it('expires every ordinary activity label field at its deadline and discards arbitrary envelopes',()=>{
 const step:ConversationStep={seq:1,conversation:'cv-public',at:0,keepUntil:100,text:'Private label',run:'private run',id:'private card',tool:'Shell',state:'done'};
 const pages=new ConversationPages();pages.accept(pages.begin(),[{...step,body:'unwanted body'} as ConversationStep],99);
 expect(pages.rows[0].text).toBe('Private label');expect(JSON.stringify(pages.rows)).not.toContain('unwanted body');
 pages.expire(100);expect(pages.rows).toEqual([{seq:1,conversation:'cv-public',at:0,keepUntil:100,text:null}]);
 for(const keepUntil of [NaN,Infinity,undefined])expect(retainedStep({...step,keepUntil} as ConversationStep,0).text).toBeNull();
});
it('fences delayed conversation pages on Live replacement, access loss or unmount and merges by global sequence',()=>{
 const pages=new ConversationPages(),generation=pages.begin();
 const step:ConversationStep={seq:1,conversation:'cv-public',at:0,keepUntil:100,text:'Old label',id:'same-card',run:'run-one'};
 pages.accept(generation,[{...step,seq:2,run:'run-two'},step],1);
 pages.accept(generation,[{...step,text:'Updated label'}],1);
 expect(pages.rows.map(row=>row.text)).toEqual(['Updated label','Old label']);
 pages.clear();expect(pages.accept(generation,[step],1)).toBe(false);expect(pages.rows).toEqual([]);
 pages.accept(pages.begin(),[step],100);expect(pages.rows[0].text).toBeNull();
});

import { ReplyCursor } from '../../web/src/pieces/comms/follow.js';
it('counts appended replies by sequence across the live cap without counting earlier pages or card updates',()=>{
 const cursor=new ReplyCursor();
 expect(cursor.advance([{seq:100,kind:'reply'}])).toEqual({initial:true,added:0,sent:false});
 expect(cursor.advance([{seq:101,kind:'reply'}])).toEqual({initial:false,added:1,sent:false});
 expect(cursor.advance([{seq:1,kind:'reply'},{seq:101,kind:'reply'}]).added).toBe(0);
 expect(cursor.advance([{seq:101,kind:'reply'},{seq:102,kind:'card'}]).added).toBe(0);
 expect(cursor.advance([{seq:102,kind:'card'}]).added).toBe(0);
 expect(cursor.advance([{seq:103,kind:'message'}])).toEqual({initial:false,added:1,sent:true});
 cursor.reset();expect(cursor.advance([{seq:105,kind:'reply'}])).toEqual({initial:true,added:0,sent:false});
});

import { bindComposerViewport } from '../../web/src/pieces/comms/viewport.js';
it('bounds only the focused composer at visual keyboard resize/pan, ignores zoom, and removes listeners on unmount',()=>{
 const viewport=Object.assign(new EventTarget(),{height:900,offsetTop:0,scale:1});
 const win=Object.assign(new EventTarget(),{visualViewport:viewport,innerHeight:900});
 const styles=new Map<string,string>(),attributes=new Set<string>();
 const box={style:{setProperty:(k:string,v:string)=>styles.set(k,v),removeProperty:(k:string)=>styles.delete(k)},setAttribute:(k:string)=>attributes.add(k),removeAttribute:(k:string)=>attributes.delete(k),getBoundingClientRect:()=>({top:40})};
 const input={},doc={activeElement:input};
 const form=Object.assign(new EventTarget(),{closest:()=>box,contains:(el:unknown)=>el===input});
 vi.stubGlobal('window',win);vi.stubGlobal('document',doc);
 const stop=bindComposerViewport(form as unknown as HTMLFormElement);
 expect(styles.size).toBe(0);
 viewport.height=450;viewport.offsetTop=50;viewport.dispatchEvent(new Event('resize'));
 expect(styles.get('--comms-visible-height')).toBe('460px');expect(attributes.has('data-comms-keyboard')).toBe(true);
 viewport.offsetTop=20;viewport.dispatchEvent(new Event('scroll'));expect(styles.get('--comms-visible-height')).toBe('430px');
 viewport.scale=2;viewport.dispatchEvent(new Event('resize'));expect(styles.size).toBe(0);
 viewport.scale=1;viewport.dispatchEvent(new Event('resize'));expect(styles.size).toBe(1);
 doc.activeElement={};form.dispatchEvent(new Event('focusout'));expect(styles.size).toBe(0);
 doc.activeElement=input;form.dispatchEvent(new Event('focusin'));expect(styles.size).toBe(1);
 viewport.height=900;viewport.offsetTop=0;win.dispatchEvent(new Event('resize'));expect(styles.size).toBe(0);
 viewport.height=450;viewport.dispatchEvent(new Event('resize'));stop();expect(styles.size).toBe(0);expect(attributes.size).toBe(0);
 viewport.dispatchEvent(new Event('resize'));viewport.dispatchEvent(new Event('scroll'));form.dispatchEvent(new Event('focusin'));win.dispatchEvent(new Event('resize'));expect(styles.size).toBe(0);
});

it('shows only the latest retained reply harness, including imports, and clears on an ordinary reply',()=>{
 const base:Message={id:'th/1',thread:'th',seq:1,at:0,kind:'reply',from:'art',text:'Reply',card:{on:'Codex'}};
 expect(latestHarness([base])).toBe('Codex');
 expect(latestHarness([{...base,seq:2,card:undefined},base])).toBeUndefined();
 expect(latestHarness([base,{...base,seq:2,kind:'card',card:{on:'Other'}}])).toBe('Codex');
 for(const on of ['<Codex>','two words','a'.repeat(25),'Codex\n',17])expect(latestHarness([{...base,card:{on}}])).toBeUndefined();
 expect(latestHarness([{...base,text:null}])).toBeUndefined();
 expect(latestHarness([])).toBeUndefined();
});

import { bindThreadRead } from '../../web/src/pieces/comms/read.js';
it('marks replies read when a hidden thread returns, coalesces events, retries failure and cleans up',async()=>{
 vi.useFakeTimers();
 const doc=Object.assign(new EventTarget(),{visibilityState:'hidden',hasFocus:()=>focused});let focused=false;
 const win=new EventTarget();vi.stubGlobal('document',doc);vi.stubGlobal('window',win);
 const calls:number[]=[];let finish!:(ok:boolean)=>void;
 const stop=bindThreadRead(8,seq=>{calls.push(seq);return new Promise(resolve=>{finish=resolve;});});
 await vi.advanceTimersByTimeAsync(30000);expect(calls).toEqual([]);
 doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));await Promise.resolve();expect(calls).toEqual([]);
 focused=true;win.dispatchEvent(new Event('focus'));doc.dispatchEvent(new Event('visibilitychange'));await Promise.resolve();expect(calls).toEqual([8]);
 finish(false);await vi.advanceTimersByTimeAsync(30000);expect(calls).toEqual([8,8]);
 finish(true);await vi.advanceTimersByTimeAsync(30000);expect(calls).toEqual([8,8,8]);
 finish(true);await vi.advanceTimersByTimeAsync(0);doc.visibilityState='hidden';await vi.advanceTimersByTimeAsync(30000);expect(calls).toEqual([8,8,8]);
 doc.visibilityState='visible';win.dispatchEvent(new Event('focus'));await Promise.resolve();expect(calls).toEqual([8,8,8,8]);
 finish(true);await vi.advanceTimersByTimeAsync(0);stop();win.dispatchEvent(new Event('focus'));doc.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(30000);expect(calls).toEqual([8,8,8,8]);
 const stale=bindThreadRead(9,async seq=>{calls.push(seq);return true;});stale();await Promise.resolve();expect(calls).toEqual([8,8,8,8]);
 vi.useRealTimers();
});

import { thinkingView } from '../../web/src/pieces/comms/working.js';
it('shows thinking only for a retained pending turn, clearing on progress, terminal notices and disconnect',()=>{
 const thread={agent:'art',working:false,archived:null};
 const send:Message={id:'send',thread:'th',seq:10,at:0,kind:'message',from:'jonathan',text:'Hello',delivery:'sending'};
 expect(thinkingView(thread,[send],true)).toBe('art is thinking');
 expect(thinkingView(thread,[{...send,delivery:'delivered'}],true)).toBe('art is thinking');
 for(const delivery of ['held','failed',undefined])expect(thinkingView(thread,[{...send,delivery}],true)).toBeNull();
 const progress={...send,id:'reply',seq:11,kind:'reply',from:'art',text:'Answer'};
 for(const kind of ['reply','card','ask'])expect(thinkingView(thread,[{...progress,kind},send],true)).toBeNull();
 for(const error of ['no-reply','loop','start-failed'])expect(thinkingView(thread,[send,{...progress,kind:'error',step:{error}}],true)).toBeNull();
 expect(thinkingView(thread,[send,{...progress,kind:'error',step:{error:'start-retry'}}],true)).toBe('art is thinking');
 expect(thinkingView(thread,[{...progress,seq:9},send],true)).toBe('art is thinking');
 expect(thinkingView(thread,[{...send,generation:1},{...progress,kind:'error',step:{error:'start-failed',generation:0}}],true)).toBe('art is thinking');
 expect(thinkingView(thread,[send,{...progress,seq:11},{...send,id:'next',seq:12}],true)).toBe('art is thinking');
 expect(thinkingView(thread,[{...send,text:null}],true)).toBeNull();
 expect(thinkingView(thread,[send,{...progress,text:null}],true)).toBeNull();
 expect(thinkingView({...thread,working:true},[send],true)).toBeNull();
 expect(thinkingView({...thread,archived:1},[send],true)).toBeNull();
 expect(thinkingView(thread,[send],false)).toBeNull();
 expect(thinkingView(thread,[],true)).toBeNull();
});

import { folderThreads } from '../../web/src/pieces/comms/threads.js';
it('keeps background work separate, promotes member follow-ups and ranks pins then unread',()=>{
 const base={archived:null,pinned:false,unread:false,last:100};
 const rows=[{...base,id:'ordinary'},{...base,id:'unread',unread:true,last:1},{...base,id:'pin',pinned:true,last:0},{...base,id:'job',background:true},{...base,id:'archive',background:true,archived:5}];
 expect(folderThreads(rows,'live').map(t=>t.id)).toEqual(['pin','unread','ordinary']);
 expect(folderThreads(rows,'background').map(t=>t.id)).toEqual(['job']);
 expect(folderThreads(rows,'archived').map(t=>t.id)).toEqual(['archive']);
 const selected=rows[3];selected.background=false;
 expect(folderThreads(rows,'live')).toContain(selected);expect(folderThreads(rows,'background')).toEqual([]);
 expect(rows.map(t=>t.id)).toEqual(['ordinary','unread','pin','job','archive']);
});
