import { useEffect, useState } from 'react';
import Approvals, { ApprovalCard, type ApprovalActions } from '../pieces/approval-view';
import Changes, { ChangeCard, type ChangeActions } from '../pieces/change-view';
import { renderMeasuringChange } from '../pieces/measuring/settings';
import { useDataQuery } from './graphql';
import { approvalsQuery, changesQuery, approvalSnapshot, changeSnapshot, type ApprovalsResult, type ChangesResult } from './work-query';

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
export function ApprovalsApp({ timezone, actions }: { path?: string; timezone?: string; actions?: ApprovalActions }) {
  return <Approvals snapshot={useApprovalSnapshot(timezone)} actions={actions} renderChange={renderMeasuringChange} />;
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
  const visit = (next: string) => {
    if (go) go(next);
    else {
      if (typeof history !== 'undefined') history.pushState(null, '', next);
      setLocalPath(next);
    }
  };
  return <Changes snapshot={useChangeSnapshot(timezone)} actions={actions}
    navigation={{ selected, select: id => visit(id ? `${base}/change/${encodeURIComponent(id)}` : base) }}
    openTask={go ? id => go(`/p/tasks-preview/task/${encodeURIComponent(id)}`) : undefined} />;
}
/** Cards read the same current entities as the tiles, never copied payloads. */
export function LiveApprovalCard({ id, timezone, actions }: { id: string; timezone?: string; actions?: ApprovalActions }) {
  return <ApprovalCard id={id} snapshot={useApprovalSnapshot(timezone)} actions={actions} renderChange={renderMeasuringChange} />;
}
export function LiveChangeCard({ id, timezone, open }: { id: string; timezone?: string; open(id: string): void }) {
  return <ChangeCard id={id} snapshot={useChangeSnapshot(timezone)} open={open} />;
}
