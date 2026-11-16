/** Current shared household facts for the outside permission boundary. */
import {readSharingPolicy,readConversationScope} from './core/data/sharing.js';
import { maySee, type Sharing, type Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { builtinServices } from './core/services.js';

export function sharedSharing(db: DataDatabase): Sharing {
  return {...readSharingPolicy(db),services:builtinServices(db.$client)};
}
export function canReadSharedConversation(db: DataDatabase, viewer: Viewer, id: string): boolean {
  const row = readConversationScope(db,id);
  return !!row && maySee(viewer, { type: 'conversation', agent: row.agent, project: row.project ?? undefined,
    member: row.member ?? undefined }, sharedSharing(db));
}
