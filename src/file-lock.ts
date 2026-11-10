/** Contention before entering a file's critical section. Never replay a whole HTTP request:
 * it may already have spent a sign-in link, created a token, or performed another write.
 * The daemon's nonblocking scope (sqlite.ts) covers file waits too; CLI callers still wait.
 * Keep paths and holder details out of the response.
 */
export class FileLockBusy extends Error {
  constructor() { super('state busy; try again'); }
}
