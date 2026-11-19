import { PROGRAM_OUTPUT_BYTES, looksLikeCredential } from './fixed-program.js';
import { pinnedProgram } from './pinned-program.js';
import { DAY_MS } from '../core/day.js';
import { z } from 'zod';
import { secretValueText } from '../pieces/secrets/input.js';
import { HARNESS_NAME } from './house-layout.js';

/** Keep recursive validation and subsequent serialization within a modest stack and byte budget. */
const boundedJson = z.unknown().refine(value => {
  const withinDepth = (part: unknown, depth: number): boolean => depth <= 32 && (
    !part || typeof part !== 'object' || Object.values(part).every(child => withinDepth(child, depth + 1)));
  try { return withinDepth(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= 8192; }
  catch { return false; }
}).pipe(z.json());
const name = z.string().regex(HARNESS_NAME);

export const houseProgramSchema = pinnedProgram.extend({
  name, timeoutMs: z.number().int().min(1).max(DAY_MS),
  payload: boundedJson.optional(), state: boundedJson.optional(),
}).strict();
export type HouseProgram = z.infer<typeof houseProgramSchema>;

export function programInput(program: HouseProgram, secrets: Record<string, string>) {
  if (Object.keys(secrets).length !== Object.keys(program.secrets).length ||
      !Object.keys(program.secrets).every(key => Object.hasOwn(secrets, key) && secretValueText.safeParse(secrets[key]).success))
    throw new Error('Program secrets unavailable');
  return { version: 1, payload: program.payload, state: program.state };
}

export { PROGRAM_OUTPUT_BYTES };
const resultSchema = z.object({
  version: z.literal(1), wake: z.boolean(), line: z.string().max(1024).regex(/^[^\r\n\u2028\u2029]*$/).optional(),
  payload: boundedJson.optional(), state: boundedJson.optional(),
  post: z.object({channel: z.string().min(1).max(200), text: z.string().min(1).max(4000)}).strict().optional(),
}).strict();
export type ProgramResult = z.infer<typeof resultSchema>;

export function parseProgramResult(text: string, secrets: readonly string[] = []): ProgramResult {
  try {
    if (Buffer.byteLength(text) > PROGRAM_OUTPUT_BYTES) throw new Error();
    if (looksLikeCredential(text, secrets)) throw new Error();
    const value: unknown = JSON.parse(text);
    return resultSchema.parse(value);
  } catch { throw new Error('Invalid program result'); }
}
