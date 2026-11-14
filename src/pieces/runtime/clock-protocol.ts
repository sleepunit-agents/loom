/** Shared wire data only. These schemas confer no admission or execution. */
import {z} from 'zod';
import {buildIdentity} from './records.js';
export const clockExecutionAssignment=z.object({runner:z.string().min(1),box:z.string().min(1),claimedAt:z.number().int(),house:buildIdentity}).strict();
export const clockExecutionBinding=z.object({agent:z.string(),conversation:z.string(),venue:z.literal('wake'),place:z.string()}).strict();
const messageBase=z.object({seq:z.number().int().positive(),id:z.string().startsWith('clock:'),kind:z.literal('wake')});
export const clockExecutionMessage=z.union([messageBase.extend({text:z.string()}).strict(),messageBase.extend({file:z.string()}).strict()]);
export const clockExecutionAdmission=z.object({execution:z.uuid(),job:z.string(),assignment:clockExecutionAssignment,binding:clockExecutionBinding,
  historyKey:z.string().regex(/^[0-9a-f]{64}$/),
  batch:z.object({conversation:z.string(),messages:z.array(clockExecutionMessage).length(1)}).strict(),
  ttl:z.literal(5000),lifetime:z.number().int().min(1).max(1_800_000)}).strict();
export const clockExecutionCurrent=z.object({current:z.literal(true),ttl:z.literal(5000)}).strict();
export const clockExecutionCompletion=z.object({acknowledged:z.literal(true),more:z.boolean()}).strict();
export const clockExecutionIdle=z.object({current:z.literal(true),more:z.boolean(),ttl:z.literal(5000)}).strict();
