import {z} from 'zod';
import {householdId} from '../slug.js';
import {kitTool} from './kit-manifest.js';

export const kitPin=z.strictObject({repository:kitTool.shape.repository,commit:kitTool.shape.commit,image:kitTool.shape.image});
export const kitTransport=z.enum(['ready','socket','catalog','capacity','image']);
export const kitAvailabilityReport=z.strictObject({
  id:z.uuid(),
  pin:kitPin.optional(),
  transport:kitTransport,
  offered:z.array(z.strictObject({kit:householdId,tool:kitTool.shape.name})).max(62),
});
export const kitUnavailable=z.strictObject({
  kit:householdId,
  partial:z.literal(true).optional(),
  reason:z.enum(['empty','policy','house','credential','socket','catalog','capacity','image'] as const),
});
export type KitUnavailable=z.infer<typeof kitUnavailable>;
export const kitUnavailableList=z.array(kitUnavailable);

export const kitReasons:Record<KitUnavailable['reason'],{why:string;fix:string}>={
  empty:{why:'it defines no tools',fix:'Add tools to the kit.'},
  policy:{why:'tool policy blocks its tools',fix:'Review the tool restrictions for this agent.'},
  house:{why:'the job ran in a different house than the one pinned by the kit',fix:'Run the job with the approved house, or review and approve new kit pins for the house being used.'},
  credential:{why:'a required tool credential is unavailable',fix:'Check that the required credential is stored and that loom can read it.'},
  socket:{why:'the worker could not open its kit socket',fix:'Check the worker state directory and its socket path.'},
  catalog:{why:'the worker could not load its kit tools',fix:'Check the connection and credentials between the worker and loom.'},
  capacity:{why:'the job exceeds the harness tool limit',fix:'Reduce the number of tools granted to this job.'},
  image:{why:'the worker could not identify the mounted house image',fix:'Check that the worker engine reports an immutable image ID.'},
};
