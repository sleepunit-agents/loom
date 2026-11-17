import { z } from 'zod';
import { householdId } from '../../slug.js';
export const secretName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** What a secret is for, in the owner's words. Never the value. */
export const secretDescription = z.string().max(4000);
/** The agent a secret is for: a household agent's id. */
export const secretAgent = householdId;

/** A house's words are displayed as one plain line; they never decide access. */
export const requestReason = z.string().max(2000).transform(text => text.normalize('NFKC')
  .replace(/[\p{C}\p{Z}<>[\]{}]/gu, ' ').replace(/ +/g, ' ').trim().slice(0, 300))
  .pipe(z.string().min(1));

/** How long a grant may last: a minute to a year. The one statement of it for the request an agent makes, the
 * record of that request, and a standing rule. */
export const GRANT_MINUTES_MAX = 525600;
export const grantMinutes = z.number().int().min(1).max(GRANT_MINUTES_MAX);
/** What an agent sends to ask for a secret: the `secrets.request` operation's input, and what a body's
 * `request_secret` tool takes and passes on unchanged. */
export const agentSecretRequest = z.object({ id: z.uuid(), secret: secretName, why: requestReason, minutes: grantMinutes,
  scope: z.enum(['agent', 'job']).default('job') }).strict();
