/** Shared wire/local configuration syntax; no database or host probing. */
import { z } from 'zod';
export const machineFacts = z.array(z.string().trim().min(1).max(256).refine(value => !/[\0\r\n]/.test(value)))
  .max(128).refine(facts => new Set(facts).size === facts.length, 'Duplicate machine fact');

/** Machine status has its own authenticated poll field, outside operator-supplied labels. */
export const reservedMachineFact = (fact: string) => /^loom:machine(?:$|[-:])/i.test(fact);
export const workerFacts = machineFacts.refine(facts => !facts.some(reservedMachineFact));
const name = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\0\r\n*]/.test(value));
export const machineReport = z.object({
  version: z.literal(1), enabled: z.literal(false), user: name,
  cwd: z.string().startsWith('/').max(4096).refine(value => !/[\0\r\n]/.test(value)),
  agents: z.array(name).min(1).max(128).refine(agents => new Set(agents).size === agents.length),
}).strict();
export type MachineReport = z.infer<typeof machineReport>;
