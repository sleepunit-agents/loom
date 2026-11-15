import { renderTempoChange } from '../pieces/tempo/settings';
import { readMeasuringChange } from '../../../src/core/measuring/change';
import { newId } from './id';
import { useEffect, useState } from 'react';
import Approvals, { ApprovalCard, type ApprovalActions } from '../pieces/approval-view';
import Changes, { ChangeCard, type ChangeActions } from '../pieces/change-view';
import { renderMeasuringChange } from '../pieces/measuring/settings';
import { useDataQuery } from './graphql';
import { approvalsQuery, changesQuery, approvalSnapshot, changeSnapshot, type ApprovalsResult, type ChangesResult } from './work-query';

/** The owner answers the same durable card through the authenticated API.
 * Visibility of a button never confers permission; root rechecks current owner.
 */
const measuringActions: ApprovalActions = {
  supports: approval => !!readMeasuringChange(approval),
  allow: id => answerMeasuring(id, true),
  deny: id => answerMeasuring(id, false),
};
async function answerMeasuring(id: string, allow: boolean): Promise<void> {
  const response = await fetch('/api/measuring/answer', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { id, allow }, id: newId() }),
  });
  const result = await response.json() as { ok: boolean };
  if (!response.ok || !result.ok) throw new Error('Answer was refused');
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
  return <Approvals snapshot={useApprovalSnapshot(timezone)} actions={actions ?? measuringActions} renderChange={approval => renderTempoChange(approval) ?? renderMeasuringChange(approval)}
    navigation={{ selected,
      select: id => visit(id ? `${base}/approval/${encodeURIComponent(id)}` : base),
      folder: folder,
      openFolder: id => visit(id === 'pending' ? base : `${base}/${id}`) }} />;
}
export function ChangesApp({ path, timezone, actions, go }: { path?: string; timezone?: string; actions?: ChangeActions; go?(path: string): void } = {}) {
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
  return <Changes snapshot={useChangeSnapshot(timezone)} actions={actions}
    navigation={{ selected, select: id => visit(id ? `${base}/change/${encodeURIComponent(id)}` : base), folder,
      openFolder: id => visit(id.startsWith('project:') ? `${base}/project/${encodeURIComponent(id.slice(8))}` : id === 'all' ? base : `${base}/${id}`) }}
    openTask={go ? id => go(`/p/tasks-preview/task/${encodeURIComponent(id)}`) : undefined} />;
}
/** Cards read the same current entities as the tiles, never copied payloads. */
export function LiveApprovalCard({ id, timezone, actions }: { id: string; timezone?: string; actions?: ApprovalActions }) {
  return <ApprovalCard id={id} snapshot={useApprovalSnapshot(timezone)} actions={actions ?? measuringActions} renderChange={approval => renderTempoChange(approval) ?? renderMeasuringChange(approval)} />;
}
export function LiveChangeCard({ id, timezone, open }: { id: string; timezone?: string; open(id: string): void }) {
  return <ChangeCard id={id} snapshot={useChangeSnapshot(timezone)} open={open} />;
}
