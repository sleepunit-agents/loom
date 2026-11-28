/** Owner-gated household setup metadata; installed callers remain trusted.
 * Generated relations batch each roster rather than querying per member/agent. */
import { asc, eq } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
import { browserRef } from '../signin/shared-browser.js';
import { jobTokenCurrent, sessionEnds, tokenJobColumns, tokenLive, type TokenJob } from './authentication.js';
import { jobs, tokens } from './schema.js';
import { householdSettings } from './household-settings.js';
/** A token's state as Setup lists it. A body's token whose job is no longer claimed is 'ended with its job': sign-in
 * refuses it (jobTokenCurrent, the same test), however its own row reads. Revoked and expired come first, since
 * they are said by the row itself. */
export type SetupTokenState = 'active' | 'revoked' | 'expired' | 'ended with its job';
export function setupTokenState(token: Pick<typeof tokens.$inferSelect, 'revokedAt' | 'expiresAt' | 'agent' | 'job'>, job: TokenJob | undefined, at: number): SetupTokenState {
  if (token.revokedAt) return 'revoked';
  if (token.expiresAt && Date.parse(token.expiresAt) <= at) return 'expired';
  return token.job !== null && !jobTokenCurrent(token, job) ? 'ended with its job' : 'active';
}
export function readHouseholdSetup(db: DataDatabase, now: string) {
  const members = db.query.members.findMany({ orderBy: f => [asc(f.position), asc(f.id)],
    with: { memberAgentsByMember: { columns: { agent: true }, orderBy: f => asc(f.agent) } },
  }).sync().map(({ memberAgentsByMember, ...row }) => ({ ...row, agents: memberAgentsByMember.map(link => link.agent) }));
  const agents = db.query.agents.findMany({ with: { agentAccountsByAgent: { columns: { login: true } } } }).sync()
    .map(({ agentAccountsByAgent, ...row }) => ({ ...row, github: agentAccountsByAgent.map(account => account.login) }));
  const credentials = db.query.tokens.findMany().sync(), byToken = new Map(credentials.map(row => [row.fingerprint, row]));
  // The jobs that job-bound tokens are bound to, in one read joined on the jobs primary key: one row per such
  // token, never a query per token.
  const tokenJobs = new Map(db.select({ fingerprint: tokens.fingerprint, ...tokenJobColumns }).from(tokens).innerJoin(jobs, eq(jobs.id, tokens.job)).all()
    .map(({ fingerprint, ...job }) => [fingerprint, job]));
  const { defaultAgent, ...settings } = householdSettings(db);
  const recipients = db.query.backupRecipients.findMany({ orderBy: f => asc(f.recipient) }).sync().map(row => row.recipient);
  const at = Date.parse(now);
  const present = new Set(members.filter(member => !member.removedAt).map(member => member.id));
  const sessions = db.query.sessions.findMany().sync().map(row => {
    const token = byToken.get(row.token);
    return { ref: browserRef(row.id), device: row.device, issuedAt: row.issuedAt, seenAt: row.seenAt, isAgent: row.isAgent,
      // Ended means what the door means: one it would refuse now (currentSession in authentication.ts). It is
      // worked out from the rows this read already has, and household-read.test.ts holds the two together.
      ended: sessionEnds(row) <= at || !(token && tokenLive(token, at)) || !present.has(token.member ?? ''),
      member: token?.member ?? null, tokenLabel: token?.label ?? null };
  });
  return { members, agents, defaultAgent,
    settings: { ...settings, backupRecipients: recipients },
    tokens: credentials.map(row => ({ ...row, identity: row.member ?? row.agent ?? row.box, expired: !!row.expiresAt && Date.parse(row.expiresAt) <= at,
      forJob: row.job !== null, state: setupTokenState(row, tokenJobs.get(row.fingerprint), at) })), sessions };
}
