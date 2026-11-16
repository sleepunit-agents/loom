/** Owner-gated household setup metadata; installed callers remain trusted.
 * Generated relations batch each roster rather than querying per member/agent. */
import { asc } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
import { browserRef } from '../signin/shared-browser.js';
export function readHouseholdSetup(db: DataDatabase, now: string) {
  const members = db.query.members.findMany({ orderBy: f => [asc(f.position), asc(f.id)],
    with: { memberAgentsByMember: { columns: { agent: true }, orderBy: f => asc(f.agent) } },
  }).sync().map(({ memberAgentsByMember, ...row }) => ({ ...row, agents: memberAgentsByMember.map(link => link.agent) }));
  const agents = db.query.agents.findMany({ with: { agentAccountsByAgent: { columns: { login: true } } } }).sync()
    .map(({ agentAccountsByAgent, ...row }) => ({ ...row, github: agentAccountsByAgent.map(account => account.login) }));
  const credentials = db.query.tokens.findMany().sync(), byToken = new Map(credentials.map(row => [row.fingerprint, row]));
  const settings = db.query.household.findFirst().sync();
  const recipients = db.query.backupRecipients.findMany({ orderBy: f => asc(f.recipient) }).sync().map(row => row.recipient);
  const at = Date.parse(now);
  const sessions = db.query.sessions.findMany().sync().map(row => {
    const token = byToken.get(row.token);
    return { ref: browserRef(row.id), device: row.device, issuedAt: row.issuedAt, seenAt: row.seenAt, isAgent: row.isAgent,
      ended: Date.parse(row.issuedAt) + (row.isAgent ? 6 * 3600000 : 30 * 86400000) <= at || !(token && !token.revokedAt && (!token.expiresAt || Date.parse(token.expiresAt) > at)),
      member: token?.member ?? null, tokenLabel: token?.label ?? null };
  });
  return { members, agents, defaultAgent: settings?.defaultAgent ?? null,
    settings: { timezone: settings?.timezone ?? 'UTC', commsDays: settings?.commsDays ?? 14, githubOwner: settings?.githubOwner ?? '',
      secretsDefault: settings?.secretsDefault ?? 'ask', backupTarget: settings?.backupTarget ?? '', backupAt: settings?.backupAt ?? '03:00',
      backupKeep: settings?.backupKeep ?? 7, backupRecipients: recipients },
    tokens: credentials.map(row => ({ ...row, identity: row.member ?? row.agent ?? row.box, expired: !!row.expiresAt && Date.parse(row.expiresAt) <= at })), sessions };
}
