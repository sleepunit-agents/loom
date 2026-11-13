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
