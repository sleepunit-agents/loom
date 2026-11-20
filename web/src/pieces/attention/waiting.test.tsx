import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
const f=vi.hoisted(()=>({snapshot:{} as any,listeners:new Set<()=>void>()}));
vi.mock('../../data/graphql',()=>({useDataQuery:()=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshot)}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
import { waitingCounts, waitingPreview, WaitingRow, deskWaitingCountsQuery } from './waiting';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const row={id:'question',source:'comms',toKind:'person',to:'owner',agent:'art',at:'2026-11-14T00:00:00Z',state:'waiting' as const,volume:'full' as const,answers:'yes-no' as const,thread:'th:private',bodyKeepUntil:new Date(50).toISOString(),body:{words:'Private question',why:'Private reason'},read:false,refs:[]};
const preview={status:'live' as const,data:{homeComms:{member:'owner'},inboxItems:[row]}};
let tree:ReturnType<typeof create>|undefined;
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;vi.useRealTimers();f.listeners.clear();});
it('uses authoritative full-mailbox and per-agent counts without selecting words',()=>{
 const result=waitingCounts({status:'live',data:{homeComms:{member:'owner'},inboxFolders:{needs:102,agents:[{id:'art',needs:2}]}}});
 expect(result.total).toBe(102);expect(result.agents.get('art')).toBe(2);
 expect(deskWaitingCountsQuery).not.toContain('body');expect(deskWaitingCountsQuery).not.toContain('inboxItems');
});
it.each(['loading','offline','denied'] as const)('clears retained counts and words on %s',status=>{
 expect(waitingCounts({status,data:{homeComms:{member:'owner'},inboxFolders:{needs:102,agents:[]}}})).toEqual({status,agents:new Map()});
 expect(waitingPreview({...preview,status},0)).toEqual({status});
});
it('distinguishes an empty live mailbox from missing identity or malformed counters',()=>{
 expect(waitingCounts({status:'live',data:{homeComms:{member:'owner'},inboxFolders:{needs:0,agents:[]}}}).total).toBe(0);
 expect(waitingCounts({status:'live'}).status).toBe('loading');
 expect(waitingCounts({status:'live',data:{homeComms:null,inboxFolders:{needs:1,agents:[]}}}).status).toBe('denied');
 expect(waitingCounts({status:'live',data:{homeComms:{member:'owner'},inboxFolders:{needs:1,agents:[{id:'art',needs:-1}]}}}).status).toBe('offline');
});
it('refuses mismatched recipients/agents and hides expired private body text',()=>{
 expect(waitingPreview(preview,0,'art').item?.body?.words).toBe('Private question');
 expect(waitingPreview(preview,50).item?.body).toBeNull();
 expect(waitingPreview({...preview,data:{...preview.data,homeComms:{member:'other'}}},0)).toEqual({status:'denied'});
 expect(waitingPreview(preview,0,'foreign')).toEqual({status:'offline'});
 expect(waitingPreview({...preview,data:{...preview.data,inboxItems:[]}},0)).toEqual({status:'live'});
});
it('withdraws private wording at its deadline and routes the preview into the actual Inbox',async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);f.snapshot=preview;const go=vi.fn();
 await act(async()=>{tree=create(h(WaitingRow,{agent:'art',go}));});
 expect(JSON.stringify(tree!.toJSON())).toContain('Private question');
 const button=tree!.root.findByType('button');await act(async()=>button.props.onClick());
 expect(go).toHaveBeenCalledExactlyOnceWith('/p/inbox-preview/ask/question');
 await act(async()=>{await vi.advanceTimersByTimeAsync(50);});
 const words=JSON.stringify(tree!.toJSON());expect(words).not.toContain('Private question');expect(words).not.toContain('Private reason');expect(words).toContain('Open it in the Inbox to read it.');
});
it('does not mark a preview read or submit an answer',async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);f.snapshot=preview;
 await act(async()=>{tree=create(h(WaitingRow,{go:vi.fn()}));});
 expect(tree!.root.findAllByType('form')).toHaveLength(0);
 expect(tree!.root.findAllByType('textarea')).toHaveLength(0);
});
