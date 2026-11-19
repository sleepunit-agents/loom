import { DAY_MS } from '../core/day.js';
import { z } from 'zod';
import { houseSecretAlias, secretValueText } from '../pieces/secrets/input.js';
import { HARNESS_NAME, HOUSE_REPOSITORY } from './house-layout.js';

/** Keep recursive validation and subsequent serialization within a modest stack and byte budget. */
const boundedJson = z.unknown().refine(value => {
  const withinDepth = (part: unknown, depth: number): boolean => depth <= 32 && (
    !part || typeof part !== 'object' || Object.values(part).every(child => withinDepth(child, depth + 1)));
  try { return withinDepth(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= 8192; }
  catch { return false; }
}).pipe(z.json());
const name = z.string().regex(HARNESS_NAME);
const arg = z.string().max(1024).refine(value => !value.includes('\0'));
export const houseProgramSchema = z.object({
  name, args: z.array(arg).max(32), timeoutMs: z.number().int().min(1).max(DAY_MS),
  secrets: z.array(houseSecretAlias).max(16).refine(names => new Set(names).size === names.length),
  payload: boundedJson.optional(), state: boundedJson.optional(),
}).strict();
export type HouseProgram = z.infer<typeof houseProgramSchema>;

export function programExecutable(value: string): string {
  if (!name.safeParse(value).success) throw new Error('Invalid program name');
  return HOUSE_REPOSITORY + '/.loom/programs/' + value;
}
export function programInput(program: HouseProgram, secrets: Record<string, string>) {
  if (Object.keys(secrets).length !== program.secrets.length ||
      !program.secrets.every(key => Object.hasOwn(secrets, key) && secretValueText.safeParse(secrets[key]).success))
    throw new Error('Program secrets unavailable');
  return { version: 1, payload: program.payload, state: program.state, secrets };
}

export const PROGRAM_OUTPUT_BYTES = 16_384;
const resultSchema = z.object({
  version: z.literal(1), wake: z.boolean(), line: z.string().max(1024).regex(/^[^\r\n\u2028\u2029]*$/).optional(),
  payload: boundedJson.optional(), state: boundedJson.optional(),
  post: z.object({channel: z.string().min(1).max(200), text: z.string().min(1).max(4000)}).strict().optional(),
}).strict();
export type ProgramResult = z.infer<typeof resultSchema>;

const credential = /(?:Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|AGE-SECRET-KEY-|(?:body_|loom_ui=)[a-f0-9]{32,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[\w-]{10,}|sk-(?:ant-)?[\w-]{20,})/i;
export function parseProgramResult(text: string, secrets: readonly string[] = []): ProgramResult {
  try {
    if (Buffer.byteLength(text) > PROGRAM_OUTPUT_BYTES) throw new Error();
    const forms = secrets.flatMap(secret => [secret, Buffer.from(secret).toString('base64')]);
    const inspect = (part: string) => {
      if (credential.test(part) || forms.some(value => value && part.includes(value))) throw new Error();
    };
    inspect(text);
    const value = JSON.parse(text, (key: string, field: unknown) => {
      inspect(key);
      if (typeof field === 'string') inspect(field);
      return field;
    });
    return resultSchema.parse(value);
  } catch { throw new Error('Invalid program result'); }
}
