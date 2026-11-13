import { tasksApp } from './pieces/tasks/registration';
/** Composition is the one place that chooses the installed first-party apps. */
export const apps = [tasksApp];
export const appAt = (path: string) => apps.find(app => path === app.path || path.startsWith(`${app.path}/`));
