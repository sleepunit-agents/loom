import { taskPath } from '../../../src/task-route';
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
import { alwaysInput, alwaysLabel, sendWorkAlways, type MergeRequest } from './work-always';
import { sendWorkAnswer } from './work-answer';
import { ownerApprovalActions, useProposalNow, useStandingAnswer, useViewer, useWorkAccess } from './work-approvals';
import type { ReviewRound } from '../pieces/change-view/model';
import type { ApprovalSnapshot } from '../pieces/approval-view/model';
import { approvalsQuery, inboxApprovalsQuery, inlineApprovalQuery, changesQuery, approvalSnapshot, changeSnapshot, type ApprovalsResult, type ChangesResult } from './work-query';

const mergeRequestsQuery = 'query WorkMergeRequests { approvals { id kind target state agent project actingFor operation } }';
// Times are said in the household's zone (the desk's own clock reading, data/zone.ts) unless the root supplies
// one; until that is read, and where it cannot be, in the browser's own.
function localTimezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
export function useApprovalSnapshot(timezone?: string) {
  const zone = useHouseholdZone();
  return approvalSnapshot(useDataQuery<ApprovalsResult>(approvalsQuery), timezone ?? zone ?? localTimezone());
}
export function useInboxApprovalLabels(ids: string[]) {
  const reading=useDataQuery<{approvals: Pick<ApprovalsResult['approvals'][number],'id'|'operation'|'what'|'details'>[]}>(inboxApprovalsQuery,{ids},{pause:!ids.length});
  return reading.status==='live' ? reading.data?.approvals ?? [] : [];
}
export function useChangeSnapshot(timezone?: string) {
  const zone = useHouseholdZone();
  return changeSnapshot(useDataQuery<ChangesResult>(changesQuery), timezone ?? zone ?? localTimezone());
}
/** Commands are injected by the authenticated composition. Never substitute
 * the replaced record feed's operation protocol or optimistically change rows. */
export function ApprovalsApp({ path, timezone, actions, go }: { path?: string; timezone?: string; actions?: ApprovalActions; go?(path: string): void } = {}) {
  const access=useWorkAccess(), read=useApprovalSnapshot(timezone), names=useAgentNames(), viewer=useViewer();
  const base = '/p/approvals-preview';
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? base : location.pathname);
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const currentPath = (path ?? localPath).split('?')[0];
  const historyPath = base + '/history';
  const historyReader = currentPath.startsWith(historyPath + '/approval/');
  const folder = historyReader ? 'history' : ['history', 'rules', 'notices'].find(id => currentPath === base + '/' + id) ?? 'pending';
  const listPath = folder === 'history' ? historyPath : base;
  const readerPrefix = listPath + '/approval/';
  let selected: string | undefined;
  if (currentPath.startsWith(readerPrefix)) {
    try { selected = decodeURIComponent(currentPath.slice(readerPrefix.length)) || undefined; }
    catch { /* Malformed URLs leave the reader closed. */ }
  }
  const { snapshot, refresh } = useProposalNow(read, selected, access.owner);
  const visit = (next: string) => {
    if (go) go(next);
    else {
      if (typeof history !== 'undefined') history.pushState(null, '', next);
      setLocalPath(next);
    }
  };
  const card=snapshot.approvals.find(row=>row.id===selected);
  const standing=useStandingAnswer(card,access);
  const defaultActions=ownerApprovalActions(access.owner,standing);
  const answerActions = actions ?? (defaultActions && { ...defaultActions, openRuleConversation: go ?? ((next:string)=>window.location.assign(next)) });
  return <Approvals snapshot={snapshot} actions={answerActions && { ...answerActions, refreshProposal: refresh }} names={names} viewer={viewer} renderChange={approval=>renderTempoChange(approval) ?? renderMeasuringChange(approval)}
    navigation={{ selected,
      select: id => visit(id ? readerPrefix + encodeURIComponent(id) : listPath),
      folder: folder,
      openFolder: id => visit(id === 'pending' ? base : `${base}/${id}`) }} />;
}
export function ChangesApp({ path, timezone, actions, go, base='/p/changes-preview', project }: { path?: string; base?: string; project?: string; timezone?: string; actions?: ChangeActions; go?(path: string): void } = {}) {
  const visible = useChangeSnapshot(timezone), access = useWorkAccess(), owner = access.owner, names = useAgentNames();
  const snapshot = project ? {...visible, changes:visible.changes.filter(change=>change.project===project)} : visible;
  const requests = useDataQuery<{approvals:MergeRequest[]}>(mergeRequestsQuery);
  const findRequest = (id:string,head:string) => {
    const row = snapshot.changes.find(row => row.id === id && row.headCommit === head);
    return row && requests.status === 'live' ? requests.data?.approvals?.find(request => request.kind === 'merge' && request.state === 'pending'
      && request.target === `${id}@${head}` && request.agent === row.agent && request.project === row.project && request.operation === null) : undefined;
  };
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? base : location.pathname);
  useEffect(() => {
    if (go) return;
    const pop = () => setLocalPath(location.pathname);
    if (typeof window === 'undefined') return;
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const pathOnly = (path ?? localPath).split('?')[0];
  const changeAt = pathOnly.indexOf('/change/',base.length);
  const currentPath = changeAt<0 ? pathOnly : pathOnly.slice(0,changeAt);
  let selected: string | undefined;
  if (changeAt>=0) {
    try { selected = decodeURIComponent(pathOnly.slice(changeAt+'/change/'.length)) || undefined; }
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
  const listPath = base.startsWith('/p/work/') ? currentPath : base;
  return <Changes projectReader={!!project} snapshot={{ ...snapshot, reviewHistory }} actions={actions ?? defaultActions} names={names}
    navigation={{ selected, select: id => visit(id ? `${listPath}/change/${encodeURIComponent(id)}` : listPath), folder,
      openFolder: id => visit(id.startsWith('project:') ? `${base}/project/${encodeURIComponent(id.slice(8))}` : id === 'all' ? base : `${base}/${id}`) }}
    openTask={go ? id => go(taskPath(id)) : undefined} />;
}
/** Cards read current entities. Inline approvals answer one request; standing grants live in the tiles. */
type LiveApprovalProps = { id: string; showBlocker?: boolean; displayTitle?: string; timezone?: string; actions?: ApprovalActions };

export function LiveApprovalCard(props: LiveApprovalProps) {
  const base=useApprovalSnapshot(props.timezone);
  return <CurrentApprovalCard {...props} base={base}/>;
}

export function useInboxApproval(id: string | undefined, zone: string | undefined) {
  const read=useDataQuery<Pick<ApprovalsResult,'approvals'|'approvalRecord'>>(inlineApprovalQuery,{id:id ?? ''},{pause:!id});
  return approvalSnapshot({...read,data:read.data && {...read.data,approvalRules:[],approvalNotices:[]}},zone ?? localTimezone());
}

export function CurrentApprovalCard({ id, actions, displayTitle, showBlocker = false, base }: Omit<LiveApprovalProps,'timezone'> & {base:ApprovalSnapshot}) {
  const owner=useWorkAccess().owner, names=useAgentNames(), viewer=useViewer();
  const [details, setDetails] = useState<string>();
  const open = details === id;
  const waiting=showBlocker && base.approvals.some(row=>row.id===id && row.state==='pending');
  const { snapshot, refresh }=useProposalNow(base,open || waiting ? id : undefined,owner,!open);
  const defaultActions=ownerApprovalActions(owner);
  const answerActions = actions ?? defaultActions;
  const showRefusal = (approval: string) => {
    if (approval !== id || !owner) return;
    refresh(id);
    setDetails(id);
  };
  return <ApprovalCard id={id} snapshot={snapshot} displayTitle={displayTitle} details={owner ? { open, toggle: () => setDetails(open ? undefined : id) } : undefined} actions={answerActions && { ...answerActions, refreshProposal: showRefusal }} names={names} viewer={viewer} renderChange={approval=>renderTempoChange(approval) ?? renderMeasuringChange(approval)} />;
}
export function LiveChangeCard({ id, timezone, open }: { id: string; timezone?: string; open(id: string): void }) {
  const names = useAgentNames();
  return <ChangeCard id={id} snapshot={useChangeSnapshot(timezone)} open={open} name={id => displayName(id, names)} />;
}
