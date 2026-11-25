import { taskId } from '../../../src/task-route';
import { entityAddress, type EntityTarget } from './entities';

/** Reuse the source references supplied by the shared question and project readers. */
export function linkedEntity(path: string): EntityTarget | undefined {
  if (path === '/p/inbox-preview') return { kind: 'question' };
  const pr = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[#?].*)?$/.exec(path);
  if (pr) return { kind: 'change', id: 'github:' + pr[1] + '/' + pr[2] + '#' + pr[3] };
  const memory = /^\/p\/work\/notes\/project\/([^/]+)\/memory\/([^/]+)$/.exec(path);
  if (memory)
    try {
      return {
        kind: 'memory',
        id: decodeURIComponent(memory[1]).split(':')[0] + ':' + decodeURIComponent(memory[2]),
      };
    } catch {
      return;
    }
  const ticket = taskId(path);
  if (ticket !== undefined) return { kind: 'ticket', id: ticket };
  const match =
    /^\/p\/(inbox-preview\/ask|approvals-preview\/approval|settings-preview\/requests|comms-preview\/thread|work\/project|work\/changes\/change|activity-preview\/memory|people-preview\/person|comms-preview\/conversation|knowledge-preview\/page)\/([^/?#]+)$/.exec(
      path,
    );
  if (!match) return;
  const kinds = {
    'inbox-preview/ask': 'question',
    'approvals-preview/approval': 'approval',
    'settings-preview/requests': 'secretRequest',
    'comms-preview/thread': 'conversation',
    'work/project': 'project',
    'work/changes/change': 'change',
    'activity-preview/memory': 'memory',
    'people-preview/person': 'person',
    'comms-preview/conversation': 'episode',
    'knowledge-preview/page': 'knowledge',
  } as const;
  const kind = kinds[match[1] as keyof typeof kinds];
  try {
    return { kind, id: (kind === 'conversation' ? 'th:' : '') + decodeURIComponent(match[2]) };
  } catch {
    return;
  }
}
export function openLinkedEntity(path: string) {
  const target = linkedEntity(path);
  if (target) location.hash = entityAddress(target);
}
