import { z } from 'zod';
import { householdId } from '../slug.js';

export const omittedWakeTools = z.array(z.enum(['Workflow', 'ReportFindings', 'ScheduleWakeup'])).max(3)
  .refine(names => new Set(names).size === names.length, 'Duplicate tool');
export const wakeToolProfiles = z.array(z.object({
  agent: householdId, trigger: z.string().min(1).max(256), omitClaudeTools: omittedWakeTools,
}).strict()).max(256).refine(rows => new Set(rows.map(row => JSON.stringify([row.agent, row.trigger]))).size === rows.length,
  'Duplicate wake tool profile');
export type WakeToolProfiles = z.infer<typeof wakeToolProfiles>;
