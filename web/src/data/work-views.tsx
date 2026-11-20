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
import { sendWorkAnswer } from './work-answer';
import { readProposal, type ProposalNow } from './work-proposal';
import type { ReviewRound } from '../pieces/change-view/model';
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
  return owner ? {...(standing?{always:{approval:standing.approval,label:alwaysLabel(standing),run:async(id:string)=>{if(id!==standing.approval)throw Error('Approval changed');await sendWorkAlways(standing);}}}:{}),allow:(id,confirm)=>sendWorkAnswer({piece:'approvals',id,answer:'allow',...(confirm?{confirm:true as const}:{})}),deny:id=>sendWorkAnswer({piece:'approvals',id,answer:'deny'})} : undefined;
}

/** Read the owner preview for the open card and discard results when it closes or changes. */
function useProposalNow(snapshot: ApprovalSnapshot, id: string | undefined, owner: boolean) {
  const row = owner && snapshot.status === 'live' ? snapshot.approvals.find(row =>
    row.id === id && row.operation === 'household.change') : undefined;
  const opened = row?.id, state = row?.state;
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<{ id: string; revision: number; state: typeof state; value: ProposalNow }>();
  useEffect(() => {
    setPreview(undefined);
    if (!opened) return;
    let current = true;
    void readProposal(opened).then(value => { if (current && value) setPreview({ id: opened, revision, state, value }); });
    return () => { current = false; };
  }, [opened, revision, state]);
  useEffect(() => {
    if (!opened || typeof window === 'undefined') return;
    const refresh = () => setRevision(value => value + 1);
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
      window.clearInterval(interval);
    };
  }, [opened]);
  const held = preview?.id === opened && preview?.revision === revision && preview?.state === state ? preview?.value : undefined;
  const refresh = (id: string) => { if (id === opened) setRevision(value => value + 1); };
  return { snapshot: held ? { ...snapshot, approvals: snapshot.approvals.map(row => row.id === opened
    ? { ...row, card: held.card, blocked: held.blocked, exactRequest: held.exact } : row) } : snapshot, refresh };
}

// Times are said in the household's zone (the desk's own clock reading, data/zone.ts) unless the root supplies
// one; until that is read, and where it cannot be, in the browser's own.
function localTimezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
export function useApprovalSnapshot(timezone?: string) {
  const zone = useHouseholdZone();
  return approvalSnapshot(useDataQuery<ApprovalsResult>(approvalsQuery), timezone ?? zone ?? localTimezone());
}
export function useApprovalList() {
  return useApprovalSnapshot();
}
export function useChangeSnapshot(timezone?: string) {
  const zone = useHouseholdZone();
  return changeSnapshot(useDataQuery<ChangesResult>(changesQuery), timezone ?? zone ?? localTimezone());
}
/** The signed-in member's id, from the same small reading Comms makes of who is at the desk. It only decides
 * whether a private request says "for you" or the person's name. */
const viewerQuery = 'query WorkViewer { homeComms { member } }';
function useViewer(): string | undefined {
  const reading = useDataQuery<{ homeComms: { member: string } | null }>(viewerQuery);
  return reading.status === 'live' ? reading.data?.homeComms?.member ?? undefined : undefined;
}
/** Commands are injected by the authenticated composition. Never substitute
 * the replaced record feed's operation protocol or optimistically change rows. */
export function ApprovalsApp({ path, timezone, actions, go }: { path?: string; timezone?: string; actions?: ApprovalActions; go?(path: string): void } = {}) {
  const access=useWorkAccess(), read=useApprovalSnapshot(timezone), changes=useChangeSnapshot(timezone), names=useAgentNames(), viewer=useViewer();
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
  const { snapshot, refresh } = useProposalNow(read, selected, access.owner);
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
  const answerActions = actions ?? (defaultActions && { ...defaultActions, openRuleConversation: go ?? ((next:string)=>window.location.assign(next)) });
  return <Approvals snapshot={snapshot} actions={answerActions && { ...answerActions, refreshProposal: refresh }} names={names} viewer={viewer} renderChange={approval=>renderTempoChange(approval) ?? renderMeasuringChange(approval)}
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
  const review = useDataQuery<{changeReviewHistory: ReviewRound[]}>(
    'query ChangeReviewHistory($change: String!) { changeReviewHistory(change: $change) { change job headCommit tier round verdict findings } }',
    {change: current?.id ?? ''}, {pause: !current || snapshot.status !== 'live'});
  const reviewHistory = current && { change: current.id, status: review.status,
    rounds: review.status === 'live' ? review.data?.changeReviewHistory?.filter(row => row.change === current.id) ?? [] : [] };
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
  return <Changes snapshot={{ ...snapshot, reviewHistory }} actions={actions ?? defaultActions} names={names}
    navigation={{ selected, select: id => visit(id ? `${base}/change/${encodeURIComponent(id)}` : base), folder,
      openFolder: id => visit(id.startsWith('project:') ? `${base}/project/${encodeURIComponent(id.slice(8))}` : id === 'all' ? base : `${base}/${id}`) }}
    openTask={go ? id => go(`/p/tasks-preview/task/${encodeURIComponent(id)}`) : undefined} />;
}
/** Cards read current entities. Inline approvals answer one request; standing grants live in the tiles. */
export function LiveApprovalCard({ id, timezone, actions, displayTitle }: { id: string; displayTitle?: string; timezone?: string; actions?: ApprovalActions }) {
  const owner=useWorkAccess().owner, names=useAgentNames(), viewer=useViewer();
  const [details, setDetails] = useState<string>();
  const open = details === id;
  const { snapshot, refresh }=useProposalNow(useApprovalSnapshot(timezone),open ? id : undefined,owner);
  const defaultActions=ownerApprovalActions(owner);
  const answerActions = actions ?? defaultActions;
  return <ApprovalCard id={id} snapshot={snapshot} displayTitle={displayTitle} details={owner ? { open, toggle: () => setDetails(open ? undefined : id) } : undefined} actions={answerActions && { ...answerActions, refreshProposal: refresh }} names={names} viewer={viewer} renderChange={approval=>renderTempoChange(approval) ?? renderMeasuringChange(approval)} />;
}
export function LiveChangeCard({ id, timezone, open }: { id: string; timezone?: string; open(id: string): void }) {
  const names = useAgentNames();
  return <ChangeCard id={id} snapshot={useChangeSnapshot(timezone)} open={open} name={id => displayName(id, names)} />;
}
