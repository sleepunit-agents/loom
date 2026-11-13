/** Registry and generated client share response and command declarations. */
import { z } from 'zod';
const tokenInfo=z.object({ref:z.string(),label:z.string(),role:z.string(),member:z.string().optional(),created:z.string(),expires:z.string().optional(),revoked:z.string().optional(),last_used:z.string().optional(),from:z.string().optional(),passkey:z.boolean()}).strict();
const sessionInfo=z.object({ref:z.string(),issuedAt:z.number(),expiresAt:z.number(),seenAt:z.number().optional(),device:z.string().optional(),label:z.string().optional(),via:z.enum(['token','link','passkey']).optional(),agent:z.boolean(),token:z.string().optional(),member:z.string().optional(),ended:z.boolean()}).strict();
export const accessResponses={
  token:{list:z.array(tokenInfo),create:z.object({token:z.string(),record:tokenInfo}).strict(),revoke:z.object({revoked:z.number(),passkeys:z.number(),devices:z.number()}).strict()},
  sessions:{list:z.array(sessionInfo),revoke:z.object({revoked:z.number(),devices:z.number()}).strict()},
};
export function accessCommands(piece:'token'|'sessions') {return Object.keys(accessResponses[piece]).map(name=>({name,write:name==='revoke',positional:['json']}));}
