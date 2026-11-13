import { z } from 'zod';
const ref=z.string().regex(/^[0-9a-f]{64}$/);
const keyInfo=z.object({ref,label:z.string(),created:z.number(),lastUsed:z.number().optional(),ended:z.boolean(),made:z.number()}).strict();
const sessionInfo=z.object({ref,label:z.string().optional(),device:z.string().optional(),via:z.enum(['token','link','passkey']).optional(),issuedAt:z.number(),seenAt:z.number().optional(),ended:z.boolean()}).strict();
export const accountResponses={
  read:z.object({member:z.string(),passkeys:z.array(keyInfo),sessions:z.array(sessionInfo)}).strict(),
  removePasskey:z.object({removed:z.number(),revoked:z.number()}).strict(),
  revokeSession:z.object({revoked:z.literal(true),devices:z.number()}).strict(),
};
export function accountCommands(){return Object.keys(accountResponses).map(name=>({name,write:name!=='read',positional:['json']}));}
