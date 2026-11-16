import { renderTempoChange } from '../pieces/tempo/settings';
import { renderMeasuringChange } from '../pieces/measuring/settings';
import { useEffect, useState } from 'react';
import Approvals, { ApprovalCard, type ApprovalActions } from '../pieces/approval-view';
import Changes, { ChangeCard, type ChangeActions } from '../pieces/change-view';
import { useDataQuery } from './graphql';
import { refreshChanges } from './work-refresh';
import { alwaysInput, alwaysLabel, sendWorkAlways, type WorkAlwaysInput, type RulePerson, type MergeRequest } from './work-always';
import { sendApprovalRule } from './work-rule';
import { sendWorkAnswer } from './work-answer';
import { approvalsQuery, changesQuery, approvalSnapshot, changeSnapshot, type ApprovalsResult, type ChangesResult } from './work-query';

const ownerQuery = 'query WorkAnswerOwner { workAnswerOwner workChangesRefresh members { id role } }';
const mergeRequestsQuery = 'query WorkMergeRequests { approvals { id kind target state agent project actingFor operation } }';
function useWorkAccess() {
  const snapshot = useDataQuery<{workAnswerOwner:boolean;workChangesRefresh:boolean;members:RulePerson[]}>(ownerQuery);
  return {owner:snapshot.status === 'live' && snapshot.data?.workAnswerOwner === true,
    refresh:snapshot.status === 'live' && snapshot.data?.workChangesRefresh === true,
    members:snapshot.status === 'live' && snapshot.data?.workAnswerOwner === true ? snapshot.data?.members ?? [] : []};
}
function ownerApprovalActions(owner: boolean, standing?:WorkAlwaysInput): ApprovalActions | undefined {
  return owner ? {...(standing?{always:{approval:standing.approval,label:alwaysLabel(standing),run:async(id:string)=>{if(id!==standing.approval)throw Error('Approval changed');await sendWorkAlways(standing);}}}:{}),setRule:sendApprovalRule,allow:(id,confirm)=>sendWorkAnswer({piece:'approvals',id,answer:'allow',...(confirm?{confirm:true as const}:{})}),deny:id=>sendWorkAnswer({piece:'approvals',id,answer:'deny'})} : undefined;
}

// The root may supply household time. The browser's own timezone is a display
// default, requiring no broader read of household/private settings.
function localTimezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
export function useApprovalSnapshot(timezone = localTimezone()) {
  return approvalSnapshot(useDataQuery<ApprovalsResult>(approvalsQuery), timezone);
}
export function useChangeSnapshot(timezone = localTimezone()) {
  return changeSnapshot(useDataQuery<ChangesResult>(changesQuery), timezone);
}
/** Commands are injected by the authenticated composition. Never substitute
 * the replaced record feed's operation protocol or optimistically change rows. */
export function ApprovalsApp({ path, timezone, actions, go }: { path?: string; timezone?: string; actions?: ApprovalActions; go?(path: string): void } = {}) {
  const access=useWorkAccess(), snapshot=useApprovalSnapshot(timezone), changes=useChangeSnapshot(timezone);
  const base = '/p/approvals-preview';
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? base : location.pathname);
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const currentPath = path ?? localPath;
  let selected: string | undefined;
  if (currentPath.startsWith(`${base}/approval/`)) {
    try { selected = decodeURIComponent(currentPath.slice(`${base}/approval/`.length)) || undefined; }
    catch { /* Malformed URLs leave the reader closed. */ }
  }
  const folder = ['history', 'rules', 'notices'].find(id => currentPath === `${base}/${id}`) ?? 'pending';
  const visit = (next: string) => {
    if (go) go(next);
    else {
      if (typeof history !== 'undefined') history.pushState(null, '', next);
      setLocalPath(next);
    }
  };
  const standing=alwaysInput(snapshot.approvals.find(card=>card.id===selected),changes.status==='live'?changes.changes:[],access.members);
  const defaultActions=ownerApprovalActions(access.owner,standing);
  return <Approvals snapshot={snapshot} actions={actions ?? defaultActions} renderChange={approval=>renderTempoChange(approval) ?? renderMeasuringChange(approval)}
    navigation={{ selected,
      select: id => visit(id ? `${base}/approval/${encodeURIComponent(id)}` : base),
      folder: folder,
      openFolder: id => visit(id === 'pending' ? base : `${base}/${id}`) }} />;
}
export function ChangesApp({ path, timezone, actions, go }: { path?: string; timezone?: string; actions?: ChangeActions; go?(path: string): void } = {}) {
  const snapshot = useChangeSnapshot(timezone), access = useWorkAccess(), owner = access.owner;
  const requests = useDataQuery<{approvals:MergeRequest[]}>(mergeRequestsQuery);
  const findRequest = (id:string,head:string) => {
    const row = snapshot.changes.find(row => row.id === id && row.headCommit === head);
    return row && requests.status === 'live' ? requests.data?.approvals?.find(request => request.kind === 'merge' && request.state === 'pending'
      && request.target === `${id}@${head}` && request.agent === row.agent && request.project === row.project && request.operation === null) : undefined;
  };
  const base = '/p/changes-preview';
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? base : location.pathname);
  useEffect(() => {
    if (go) return;
    const pop = () => setLocalPath(location.pathname);
    if (typeof window === 'undefined') return;
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const currentPath = path ?? localPath;
  let selected: string | undefined;
  if (currentPath.startsWith(`${base}/change/`)) {
    try { selected = decodeURIComponent(currentPath.slice(`${base}/change/`.length)) || undefined; }
    catch { /* Malformed URLs leave the reader closed. */ }
  }
  let folder = ['you', 'lately'].find(id => currentPath === `${base}/${id}`) ?? 'all';
  if (currentPath.startsWith(`${base}/project/`)) {
    try {
      const project = decodeURIComponent(currentPath.slice(`${base}/project/`.length));
      if (project) folder = `project:${project}`;
    } catch { /* Malformed project links show all visible changes. */ }
  }
  const visit = (next: string) => {
    if (go) go(next);
    else {
      if (typeof history !== 'undefined') history.pushState(null, '', next);
      setLocalPath(next);
    }
  };
  const current=snapshot.changes.find(row=>row.id===selected);
  const standing=alwaysInput(current?findRequest(current.id,current.headCommit):undefined,snapshot.status==='live'?snapshot.changes:[],access.members);
  const defaultActions: ChangeActions | undefined = owner && requests.status === 'live' ? {
    ...(standing?{always:{change:standing.change,head:standing.head,project:standing.project,label:alwaysLabel(standing),run:async(id:string,head:string)=>{if(id!==standing.change||head!==standing.head)throw Error('Change moved');await sendWorkAlways(standing);}}}:{}),
    ...(access.refresh ? {refresh:refreshChanges} : {}),
    canAnswer:(id,head)=>!!findRequest(id,head),
    async answer(id,head,answer) {
      const request = findRequest(id,head); if (!request) throw new Error('No approval is waiting for this commit.');
      await sendWorkAnswer({piece:'changes',id,head,approval:request.id,answer});
    },
  } : undefined;
  return <Changes snapshot={snapshot} actions={actions ?? defaultActions}
    navigation={{ selected, select: id => visit(id ? `${base}/change/${encodeURIComponent(id)}` : base), folder,
      openFolder: id => visit(id.startsWith('project:') ? `${base}/project/${encodeURIComponent(id.slice(8))}` : id === 'all' ? base : `${base}/${id}`) }}
    openTask={go ? id => go(`/p/tasks-preview/task/${encodeURIComponent(id)}`) : undefined} />;
}
/** Cards read current entities. Inline approvals answer one request; standing grants live in the tiles. */
export function LiveApprovalCard({ id, timezone, actions }: { id: string; timezone?: string; actions?: ApprovalActions }) {
  const snapshot=useApprovalSnapshot(timezone);
  const defaultActions=ownerApprovalActions(useWorkAccess().owner);
  return <ApprovalCard id={id} snapshot={snapshot} actions={actions ?? defaultActions} renderChange={approval=>renderTempoChange(approval) ?? renderMeasuringChange(approval)} />;
}
export function LiveChangeCard({ id, timezone, open }: { id: string; timezone?: string; open(id: string): void }) {
  return <ChangeCard id={id} snapshot={useChangeSnapshot(timezone)} open={open} />;
}
