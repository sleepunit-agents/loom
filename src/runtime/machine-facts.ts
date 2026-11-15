/** Shared wire/local configuration syntax; no database or host probing. */
import { z } from 'zod';
export const machineFacts = z.array(z.string().trim().min(1).max(256).refine(value => !/[\0\r\n]/.test(value)))
  .max(128).refine(facts => new Set(facts).size === facts.length, 'Duplicate machine fact');
