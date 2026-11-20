/** Adapter to central next-mode credentials. No runtime credential store. */
import { HouseholdRows } from '../../core/household/rows.js';
import { TokenDatabase } from '../../core/household/tokens.js';
import type { RuntimeCredentials } from './credentials.js';

/** Match exactly the job-bearing role grammar accepted by central Signin.token. */
const jobOf = (role: string) => /^agent:[a-z0-9-]+(?:\/[a-z0-9-]+)?@([a-z0-9-]+)$/.exec(role)?.[1];
export const centralRuntimeCredentials: RuntimeCredentials = {
  revokeJob(db, { job, now }) {
    if (!db.inTransaction) throw new Error('Runtime credentials require the caller transaction');
    const tokens = new TokenDatabase(db);
    if (tokens.document()) tokens.change(records => {
      for (const token of records) if (!token.revoked && jobOf(token.role) === job)
        token.revoked = new Date(now).toISOString();
    });
  },
  revokeBox(db, { box, jobs, now }) {
    if (!db.inTransaction) throw new Error('Runtime credentials require the caller transaction');
    const tokens = new TokenDatabase(db), jobIds = new Set(jobs);
    // Match the same job-bearing role grammar accepted by central Signin.token.
    // Display labels are never authority and may be duplicated or renamed.
    if (tokens.document()) tokens.change(records => {
      for (const token of records) {
        const job = jobOf(token.role);
        if (!token.revoked && (token.role === `runner:${box}` || (job !== undefined && jobIds.has(job))))
          token.revoked = new Date(now).toISOString();
      }
    });
    new HouseholdRows(db, 'settings').put(`signin-principal:runner:${box}`, { active: false });
  },
};
