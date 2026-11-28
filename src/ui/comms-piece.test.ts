/** Tests for retained Comms helpers; retired renderer/paging adapters have been removed. */
import { expect, it } from 'vitest';
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

import { latestHarness, messageView, type Message } from '../../test/fixtures/legacy-comms-message.js';
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

it('shows only the latest retained reply harness, including imports, and clears on an ordinary reply',()=>{
 const base:Message={id:'th/1',thread:'th',seq:1,at:0,kind:'reply',from:'art',text:'Reply',card:{on:'Codex'}};
 expect(latestHarness([base])).toBe('Codex');
 expect(latestHarness([{...base,seq:2,card:undefined},base])).toBeUndefined();
 expect(latestHarness([base,{...base,seq:2,kind:'card',card:{on:'Other'}}])).toBe('Codex');
 for(const on of ['<Codex>','two words','a'.repeat(25),'Codex\n',17])expect(latestHarness([{...base,card:{on}}])).toBeUndefined();
 expect(latestHarness([{...base,text:null}])).toBeUndefined();
 expect(latestHarness([])).toBeUndefined();
});
