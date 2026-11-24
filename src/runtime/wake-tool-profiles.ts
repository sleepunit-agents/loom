import { z } from 'zod';
import { householdId } from '../slug.js';

export const omittedWakeTools = z.array(z.enum(['Workflow', 'ReportFindings', 'ScheduleWakeup'])).max(3)
  .refine(names => new Set(names).size === names.length, 'Duplicate tool');
export type OmittedWakeTools = z.infer<typeof omittedWakeTools>;
export const wakeToolProfiles = z.array(z.object({
  agent: householdId, trigger: z.string().min(1).max(256), // A household config shared across versions can mention a newer optional tool.
  // Keep that profile on the default inventory until this coordinator understands every name.
  omitClaudeTools: z.array(z.string()).transform(names => omittedWakeTools.safeParse(names).data ?? []),
}).strict()).max(256).refine(rows => new Set(rows.map(row => JSON.stringify([row.agent, row.trigger]))).size === rows.length,
  'Duplicate wake tool profile');
export type WakeToolProfiles = z.input<typeof wakeToolProfiles>;
