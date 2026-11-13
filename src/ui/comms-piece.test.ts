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

import { messageView, type Message } from '../../web/src/pieces/comms/message.js';
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
