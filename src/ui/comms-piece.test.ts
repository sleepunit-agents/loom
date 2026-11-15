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


it('opens only exact Clock local-approval paths in this window, keeping arbitrary internal links inert',()=>{
 const html=replyHtml('[Review local request](/p/clock-preview/item/a-1234abcd) [external](https://example.com)');
 expect(html).toContain('href="/p/clock-preview/item/a-1234abcd"');
 expect(html).toMatch(/<a href="\/p\/clock-preview\/item\/a-1234abcd">Review local request<\/a>/);
 expect(html).toMatch(/href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
 for(const path of ['/p/clock-preview/item/a-1234abcd?allow=true','/p/clock-preview/item/a-1234abcd/../../settings','/p/clock-preview/item/a-1234abcD','/p/clock-preview/item/w-123456','/p/clock-preview/item/a-%31%32%33%34abcd','//evil.invalid/p/clock-preview/item/a-1234abcd','/p/approvals-preview','/p/clock-preview/item/a-1234abcd#allow'])expect(replyHtml(`[bad](${path})`)).not.toContain('<a ');
});
