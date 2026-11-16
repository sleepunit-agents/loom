/** Owner setup metadata only; never returns a token bearer or other identities. */
import { and, eq, isNotNull } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
export function readProgramSetupTokens(db: DataDatabase) {
  return db.query.tokens.findMany({ where: f => and(eq(f.kind, 'owner'), isNotNull(f.member)),
    columns: { fingerprint: true, label: true, member: true, createdAt: true, expiresAt: true, revokedAt: true },
  }).sync();
}
