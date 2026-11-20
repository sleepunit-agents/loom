import {z} from 'zod';
import {bridgeConnections} from '../data/schema.js';
/** A channel on a bridge, and a thread in it: the one way a caller names a place nothing has been said in yet.
 * A note's target (handoff.ts), an agent's own post (src/shared-bridge-reply.ts) and a channel rule's report
 * target (pieces/bridges/settings.ts) are all written this way. */
export const channelTarget=z.object({platform:z.enum(bridgeConnections.platform.enumValues),workspace:z.string().min(1).max(200),channel:z.string().min(1).max(200),thread:z.string().min(1).max(200).optional()}).strict();
export type ChannelTarget=z.infer<typeof channelTarget>;
