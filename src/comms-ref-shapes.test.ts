/** Retained server card/ref boundaries outlive the retired desktop client. */
import {expect,it} from 'vitest';
import {CARD_PAGE,REFS_MAX,refShape} from './comms-refs.js';
it('card destinations reject external navigation and path traversal',()=>{
 for(const page of ['p/tasks/task/t-12','conversation/cv-0123456789ab','knowledge/dns-health','projects/pond','people/loren','a/mark','inbox'])expect(CARD_PAGE.test(page),page).toBe(true);
 for(const page of ['\\evil.com','/evil','//evil.com','p/tasks/task/t-12?x=1','p/tasks/../admin','javascript:alert(1)','a/Mark','knowledge/../x','inbox/x'])expect(CARD_PAGE.test(page),page).toBe(false);
});
it('refs accept known identifiers and reject malformed or executable values',()=>{
 for(const [ref,kind] of [['t-1','task'],['github:acme/app#3','pr'],['cv-0123456789ab','conv'],['a-0123abcd','approval'],['note:a/b','note'],['knowledge:x','knowledge'],['project:x','project'],['person:x','person'],['agent:x','agent'],['at:x','at']])expect(refShape(ref),ref).toBe(kind);
 for(const ref of ['t-1234567890','github:a/b#c','cv-1','a-0123','note:a/../b','note:','at:X','evil:x','t-1" onclick="x','note:.hidden'])expect(refShape(ref),ref).toBeUndefined();
 expect(REFS_MAX).toBe(60);
});
