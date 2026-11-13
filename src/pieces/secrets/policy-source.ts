/** Pure strict policy decoder shared by offline import planning and persistence. */
import { z } from 'zod';
import { parseLegacyMetadataJson } from './source-json.js';
import { secretAgent, secretName } from './input.js';
import { secretPolicy, type SecretPolicy } from './policy.js';

const level = z.enum(['ask', 'auto', 'never']);
const sourcePolicy = z.object({
  v: z.literal(1).optional(),
  default: level.default('ask'),
  secrets: z.record(secretName, z.object({
    grant: level.optional(),
    agents: z.array(secretAgent).max(1000).optional(),
    houses: z.array(secretAgent).max(1000).optional(),
    // The old decide() clamps positive integer durations at eight hours.
    minutes: z.number().positive().refine(Number.isInteger).transform(n => Math.min(n, 480)).optional(),
  }).strict()).default({}),
}).strict();
/** No raw source or validation diagnostics escape: a malformed metadata file may
 * contain an accidental value. Unknown fields are refused, never copied to DB. */
export function parseLegacySecretPolicy(bytes: Buffer): SecretPolicy {
  try {
    const parsed = sourcePolicy.parse(parseLegacyMetadataJson(bytes));
    return secretPolicy.parse({ default: parsed.default, secrets: parsed.secrets });
  } catch { throw new Error('Invalid legacy secret policy'); }
}

