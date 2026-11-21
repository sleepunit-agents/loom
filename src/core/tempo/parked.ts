import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { approvals, secretRequests, secretGrants } from '../data/schema.js';

/** Parked continuations have their own watch names. Ordinary answer watches deliver their original words. */
export function parkedSource(watch: string | null | undefined) {
  const match = /^(park-approval|park-secret):([A-Za-z0-9_-]{1,200})$/.exec(watch ?? '');
  return match ? { approval:match[1] === 'park-approval', id:match[2] } : undefined;
}

export function parkedVerdict(db: DataDatabase, source: NonNullable<ReturnType<typeof parkedSource>>, now: number) {
  if (source.approval) {
    const row = db.select({state:approvals.state, expires:approvals.expiresAt}).from(approvals).where(eq(approvals.id,source.id)).get();
    if (!row) return 'unavailable';
    if (row.state === 'allowed' && row.expires && Date.parse(row.expires) <= now) return 'expired';
    return row.state;
  }
  const row = db.select({state:secretRequests.state}).from(secretRequests).where(eq(secretRequests.id, source.id)).get();
  if (!row) return 'unavailable';
  if (row.state !== 'allowed') return row.state;
  const grant = db.select({expires:secretGrants.expiresAt}).from(secretGrants).where(eq(secretGrants.request, source.id)).get();
  return grant && Date.parse(grant.expires) > now ? 'allowed' : 'expired';
}
