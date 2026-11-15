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

import { latestHarness, messageView, type Message } from '../../web/src/pieces/comms/message.js';
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
