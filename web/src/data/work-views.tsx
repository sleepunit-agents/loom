import { renderTempoChange } from '../pieces/tempo/settings';
import { renderMeasuringChange } from '../pieces/measuring/settings';
import { useEffect, useState } from 'react';
import Approvals, { ApprovalCard, type ApprovalActions } from '../pieces/approval-view';
import Changes, { ChangeCard, type ChangeActions } from '../pieces/change-view';
import { useDataQuery } from './graphql';
import { useAgentNames } from './names';
import { displayName } from '../kit/words';
import { useHouseholdZone } from './zone';
import { refreshChanges } from './work-refresh';
import { alwaysInput, alwaysLabel, sendWorkAlways, type WorkAlwaysInput, type RulePerson, type MergeRequest } from './work-always';
import { sendApprovalRule } from './work-rule';
import { sendWorkAnswer } from './work-answer';
import { readProposal, type ProposalNow } from './work-proposal';
import type { ApprovalSnapshot } from '../pieces/approval-view/model';
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

/** A household owner who opens a waiting household card is shown what it would replace and anything that
 * already stands against it. Neither is on the card (work-proposal.ts), so it is read when the card opens. */
function useProposalNow(snapshot: ApprovalSnapshot, id: string | undefined, owner: boolean): ApprovalSnapshot {
  const card = owner && snapshot.status === 'live' ? snapshot.approvals.find(row => row.id === id && row.state === 'pending' && row.operation === 'household.change') : undefined;
  const key = card?.id;
  const [now, setNow] = useState<ProposalNow & { id: string }>();
  useEffect(() => {
    if (!key) return;
    let current = true;
    void readProposal(key).then(value => { if (current && value) setNow({ id: key, ...value }); });
    return () => { current = false; };
  }, [key]);
  if (!card || now?.id !== card.id) return snapshot;
  return { ...snapshot, approvals: snapshot.approvals.map(row => row.id === card.id ? { ...row, changeSummary: now.summary, problem: now.problem } : row) };
}

// Times are said in the household's zone (the desk's own clock reading, data/zone.ts) unless the root supplies
// one; until that is read, and where it cannot be, in the browser's own.
function localTimezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
export function useApprovalSnapshot(timezone?: string) {
  const zone = useHouseholdZone();
  return approvalSnapshot(useDataQuery<ApprovalsResult>(approvalsQuery), timezone ?? zone ?? localTimezone());
}
export function useChangeSnapshot(timezone?: string) {
  const zone = useHouseholdZone();
  return changeSnapshot(useDataQuery<ChangesResult>(changesQuery), timezone ?? zone ?? localTimezone());
}
/** Commands are injected by the authenticated composition. Never substitute
 * the replaced record feed's operation protocol or optimistically change rows. */
export function ApprovalsApp({ path, timezone, actions, go }: { path?: string; timezone?: string; actions?: ApprovalActions; go?(path: string): void } = {}) {
  const access=useWorkAccess(), read=useApprovalSnapshot(timezone), changes=useChangeSnapshot(timezone);
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
  const snapshot = useProposalNow(read, selected, access.owner);
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
  const snapshot = useChangeSnapshot(timezone), access = useWorkAccess(), owner = access.owner, names = useAgentNames();
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
  return <Changes snapshot={snapshot} actions={actions ?? defaultActions} names={names}
    navigation={{ selected, select: id => visit(id ? `${base}/change/${encodeURIComponent(id)}` : base), folder,
      openFolder: id => visit(id.startsWith('project:') ? `${base}/project/${encodeURIComponent(id.slice(8))}` : id === 'all' ? base : `${base}/${id}`) }}
    openTask={go ? id => go(`/p/tasks-preview/task/${encodeURIComponent(id)}`) : undefined} />;
}
/** Cards read current entities. Inline approvals answer one request; standing grants live in the tiles. */
export function LiveApprovalCard({ id, timezone, actions }: { id: string; timezone?: string; actions?: ApprovalActions }) {
  const owner=useWorkAccess().owner, snapshot=useProposalNow(useApprovalSnapshot(timezone),id,owner);
  const defaultActions=ownerApprovalActions(owner);
  return <ApprovalCard id={id} snapshot={snapshot} actions={actions ?? defaultActions} renderChange={approval=>renderTempoChange(approval) ?? renderMeasuringChange(approval)} />;
}
export function LiveChangeCard({ id, timezone, open }: { id: string; timezone?: string; open(id: string): void }) {
  const names = useAgentNames();
  return <ChangeCard id={id} snapshot={useChangeSnapshot(timezone)} open={open} name={id => displayName(id, names)} />;
}
