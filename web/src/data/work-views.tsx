import { readTempoChange, renderTempoChange } from '../pieces/tempo/settings';
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
function settingsPath(card: Parameters<typeof readTempoChange>[0]) {
  return readTempoChange(card) ? '/api/tempo/answerSettings' : readMeasuringChange(card) ? '/api/measuring/answer' : undefined;
}
function settingsActions(snapshot: ReturnType<typeof useApprovalSnapshot>): ApprovalActions {
  return { supports: approval => !!settingsPath(approval),
    allow: id => answerSettings(snapshot.approvals.find(card => card.id === id), true),
    deny: id => answerSettings(snapshot.approvals.find(card => card.id === id), false) };
}
async function answerSettings(card: ReturnType<typeof useApprovalSnapshot>['approvals'][number] | undefined, allow: boolean): Promise<void> {
  if (!card) throw new Error('Approval unavailable');
  const path = settingsPath(card);
  if (!path) throw new Error('Approval unavailable');
  const id = card.id;
  const response = await fetch(path, {
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
  const snapshot = useApprovalSnapshot(timezone);
  return <Approvals snapshot={snapshot} actions={actions ?? settingsActions(snapshot)} renderChange={approval => renderTempoChange(approval) ?? renderMeasuringChange(approval)}
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
  const snapshot = useApprovalSnapshot(timezone);
  return <ApprovalCard id={id} snapshot={snapshot} actions={actions ?? settingsActions(snapshot)} renderChange={approval => renderTempoChange(approval) ?? renderMeasuringChange(approval)} />;
}
export function LiveChangeCard({ id, timezone, open }: { id: string; timezone?: string; open(id: string): void }) {
  return <ChangeCard id={id} snapshot={useChangeSnapshot(timezone)} open={open} />;
}
