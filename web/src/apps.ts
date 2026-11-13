import { sharingApp } from './pieces/sharing/registration';
import { tasksApp } from './pieces/tasks/registration';
/** Composition is the one place that chooses the installed first-party apps. */
export const apps = [tasksApp, sharingApp];
export const appAt = (path: string) => apps.find(app => path === app.path || path.startsWith(`${app.path}/`));

/** Home's piece may supply these ordinary record-driven surfaces; the shell fetches nothing. */
export const shellSurfaces: import('./shell').ShellSurfaces = {};
