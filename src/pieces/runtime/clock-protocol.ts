/** Shared wire data only. These schemas confer no admission or execution. */
import {z} from 'zod';
import {buildIdentity} from './records.js';
export const clockExecutionAssignment=z.object({runner:z.string().min(1),box:z.string().min(1),claimedAt:z.number().int(),house:buildIdentity}).strict();
export const clockExecutionBinding=z.object({agent:z.string(),conversation:z.string(),venue:z.literal('wake'),place:z.string()}).strict();
export const clockExecutionAdmission=z.object({execution:z.uuid(),job:z.string(),assignment:clockExecutionAssignment,binding:clockExecutionBinding,
  batch:z.object({conversation:z.string(),messages:z.array(z.object({seq:z.number().int().positive(),id:z.string().startsWith('clock:'),kind:z.literal('wake'),text:z.string()}).strict()).length(1)}).strict(),
  ttl:z.literal(5000)}).strict();
export const clockExecutionCurrent=z.object({current:z.literal(true),ttl:z.literal(5000)}).strict();
export const clockExecutionCompletion=z.object({acknowledged:z.literal(true)}).strict();
