import { z } from 'zod';
import { bridgeConnections } from '../../core/data/schema.js';
const id = z.string().min(1).max(200);
export const venueSchema = z.object({
  id, platform: z.enum(bridgeConnections.platform.enumValues), agent: id, workspace: id, bot: id,
  tokenSecret: id, appSecret: id.optional(), enabled: z.boolean().default(true),
  only: z.array(id).default([]), ignore: z.array(id).default([]),
  botRoles: z.array(id).default([]),
}).strict();
export type Venue = z.infer<typeof venueSchema>;
