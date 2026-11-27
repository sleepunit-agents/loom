import { z } from 'zod';
import { brick, none } from './kit.js';

/** The Inbox's fixed folders, as the desktop lists them (web/src/pieces/inbox-view/model.ts, folderWords and
 * errorsFolder). The first holds what waits on the member. A folder per agent is not one of them. */
export const inboxFolders = ['needs', 'alerts', 'answered', 'fyi', 'all', 'errors'] as const;

// The two lists of what waits on the member. Neither answers anything: a row's chip places the brick that does.
export default brick({ name: 'inbox', big: true, flags: ['new item'],
  shows: "The member's Inbox as a list, one folder at a time: each item's words, who asked, when and its state, and every folder's count. needs is what waits on the member. An item is answered in its question brick.",
  params: z.object({ folder: z.enum(inboxFolders).default('needs') }).strict(), references: {},
  actions: { read: { operation: 'inbox.read', detail: none }, dismissResult: { operation: 'inbox.dismissResult', detail: none } } });
