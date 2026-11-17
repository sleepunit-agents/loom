import { z } from 'zod';
import { householdId } from '../../slug.js';
export const secretName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
// Names no startup secret may take, whatever the harness: how the body finds and runs programs, where it
// connects, what loom itself hands a body, and the tools protocol's own prefix.
const BODY_CONTROLS = new Set(['PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'XDG_CONFIG_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
/** The name a house knows one of its startup secrets by. A body hands the secret to its house as an
 * environment variable of this name, so it is a name an environment variable can have, of at most 200
 * characters, and not one a body's own running depends on. This is the one statement of it: the door that
 * stores an alias, the plan loom hands a body and the body itself all ask here, so an alias the door takes
 * is never one that stops the body. (A body also refuses a name its own machine already sets or its
 * harness signs in with, which only it can know: runtime/body-secrets.ts.) */
export function isHouseSecretAlias(name: string): boolean {
  const key = name.toUpperCase();
  return /^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(name) && !BODY_CONTROLS.has(key) && !/^(?:NODE_|MCP_|LD_|DYLD_|LOOM_BODY_)/.test(key);
}
export const houseSecretAlias = z.string().refine(isHouseSecretAlias, 'An alias is a name an environment variable can have, and not one a body runs by');
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
