import { AsyncLocalStorage } from 'node:async_hooks';
/** Follows admitted background work through offer pools and asynchronous provider calls. */
export const periodicContext = new AsyncLocalStorage<{ home: string; job: string }>();
