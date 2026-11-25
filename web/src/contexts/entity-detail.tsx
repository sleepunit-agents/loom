import { lazy, Suspense } from 'react';
import { useDataQuery } from '../data/graphql';
import { memoryQueries } from '../memory/queries';
import type { EntityTarget } from './entities';
import { openLinkedEntity } from './entity-links';
import { ConversationHistory } from './conversation-history';
import { useDeadline } from '../pieces/comms/use-deadline';
import { Facts } from './entity-facts';

const Question = lazy(async () => ({
  default: (await import('../pieces/comms/inline-question')).InlineQuestion,
}));
const Approval = lazy(async () => ({ default: (await import('../data/work-views')).LiveApprovalCard }));
const detailSources = {
  knowledge: memoryQueries.page,
  person: memoryQueries.person,
  projectNotes: memoryQueries.project,
  memory: memoryQueries.projectMemory,
  activity: memoryQueries.activityEntry,
};
export function RichDetail({ target }: { target: EntityTarget & { id: string } }) {
  const { kind, id } = target;
  const source = detailSources[kind as keyof typeof detailSources];
  const selection = source?.(id);
  const snapshot = useDataQuery<Record<string, Record<string, unknown> | null>>(
    selection?.query ?? '{__typename}',
    selection?.variables,
    { pause: !selection },
  );
  const record = Object.values(snapshot.data || {})[0];
  const expires = record?.expires;
  const deadline =
    typeof expires === 'number'
      ? new Date(expires).toISOString()
      : typeof expires === 'string'
        ? expires
        : null;
  const now = useDeadline([deadline]);
  if (kind === 'conversation') return <ConversationHistory thread={id} />;
  if (kind === 'question')
    return (
      <Suspense fallback="Opening question…">
        <Question id={id} go={openLinkedEntity} contextWorkspace writable readVisible />
      </Suspense>
    );
  if (kind === 'approval')
    return (
      <Suspense fallback="Opening approval…">
        <Approval id={id} />
      </Suspense>
    );
  if (!selection) return null;
  if (snapshot.status === 'loading') return <p role="status">Loading details…</p>;
  if (!record || (deadline && Date.parse(deadline) <= now)) return <p>Details unavailable.</p>;
  return <Facts row={record} section="detail" />;
}
export const hasDetail = (kind: EntityTarget['kind']) =>
  Object.hasOwn(detailSources, kind) || ['conversation', 'question', 'approval'].includes(kind);
