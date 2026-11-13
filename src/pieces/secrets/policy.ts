/** Metadata only. Request policy and at-start permission are deliberately separate. */
import { z } from 'zod';
import type { Db } from '../../core/index.js';
import { secretName } from './input.js';

const agents = z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100)).max(1000);
export const secretPolicy = z.object({
  default: z.enum(['ask', 'auto', 'never']).default('ask'),
  secrets: z.record(secretName, z.object({
    grant: z.enum(['ask', 'auto', 'never']).optional(),
    agents: agents.optional(), houses: agents.optional(),
    minutes: z.number().int().positive().max(480).optional(),
  }).strict()).default({}),
}).strict();
export type SecretPolicy = z.infer<typeof secretPolicy>;
export function readSecretPolicy(db: Db): SecretPolicy {
  const row = db.prepare("SELECT value FROM secrets_meta WHERE key='policy'").get() as { value: string } | undefined;
  return row ? secretPolicy.parse(JSON.parse(row.value)) : { default: 'ask', secrets: {} };
}
export function requestDecision(policy: SecretPolicy, agent: string, name: string) {
  const rule = Object.hasOwn(policy.secrets, name) ? policy.secrets[name] : undefined;
  const level = rule?.grant === 'auto' ? (rule.agents?.includes(agent) ? 'auto' : 'ask') : rule?.grant ?? policy.default;
  return { level, minutes: rule?.minutes ?? 60 };
}
/** Called only by the runtime that authenticated the agent; this returns no value. */
export function secretStartPermission(db: Db, agent: string, name: string): 'allowed' | 'denied' | 'ask' {
  const policy = readSecretPolicy(db);
  const rule = Object.hasOwn(policy.secrets, name) ? policy.secrets[name] : undefined;
  // Old start policy uses explicit never; the request default does not grant start access.
  if (rule?.grant === 'never') return 'denied';
  return rule?.houses?.includes(agent) ? 'allowed' : 'ask';
}
