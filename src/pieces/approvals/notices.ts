import { createHash } from 'node:crypto';
import type { State } from './model.js';
import type { ApprovalNotice, Ask } from '../attention/role.js';
import { approvalNoticeRecord } from '../attention/approval-notices.js';
import { repoOf, hostOf } from './targets.js';
/** Assign once in the owning write/import transaction. Original source fields
 * are retained; later source removal cannot renumber surviving events. */
export function identifyNotices(s:State): void {
  const occurrences=new Map<string,number>();
  for(const n of s.notices) {
    if(n.id!==undefined)continue;
    const digest=createHash('sha256').update(JSON.stringify([n.at,n.agent,n.kind,n.target,n.what,n.for??null]),'utf16le').digest('hex');
    const occurrence=occurrences.get(digest)??0;occurrences.set(digest,occurrence+1);
    n.id=`legacy:${digest}:${occurrence}`;
  }
}
export function noticeEntries(s: State) {
  return s.notices.flatMap(n=>{
    if(!n.id || n.member || !/^[a-z][a-z0-9-]{0,63}$/.test(n.agent) || !Number.isFinite(Date.parse(n.at))
      || !(n.kind==='merge' && repoOf(n.target) || n.kind==='host' && hostOf(n.target)))return [];
    return [{id:n.id,notice:n}];
  });
}
export function noticeSnapshot(s:State): ApprovalNotice[] {
  return noticeEntries(s).map(({id,notice:n})=>({id,agent:n.agent,kind:n.kind,at:Date.parse(n.at)}));
}
export function currentNotice(s:State, ask:Ask): boolean {
  return noticeSnapshot(s).some(n=>JSON.stringify(approvalNoticeRecord(n))===JSON.stringify(ask));
}
