import { knowledgeApp } from './pieces/knowledge/registration';
import { sharingApp } from './pieces/sharing/registration';
import { tasksApp } from './pieces/tasks/registration';
import { changesApp } from './pieces/changes/registration';
import { approvalsApp } from './pieces/approvals/registration';
import { bridgesApp } from './pieces/bridges/registration';
import { inboxApp } from './pieces/attention/registration';
/** Composition is the one place that chooses the installed first-party apps. */
export const apps = [tasksApp, approvalsApp, sharingApp, changesApp, knowledgeApp, inboxApp, bridgesApp];
export const appAt = (path: string) => apps.find(app => path === app.path || path.startsWith(`${app.path}/`));

/** Home's piece may supply these ordinary record-driven surfaces; the shell fetches nothing. */
export const shellSurfaces: import('./shell').ShellSurfaces = {};
