import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { localSecretSource, privateBytes } from './local-holder.js';
import { localHolderMutations } from './holder-mutations.js';
import { secretName } from './input.js';
const path = z.string().refine(isAbsolute);
const schema = z.object({socket:path, ca:path, cert:path, key:path,
  servername:z.hostname(),
  github:z.record(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/), secretName),
}).strict();
/** Only an explicit private config; no search, environment values or old-state fallback. */
export function configuredSecretHolder(file: string) {
  let bytes: Buffer | undefined;
  try {
    bytes = privateBytes(file);
    const {github, ...config} = schema.parse(JSON.parse(bytes.toString('utf8')));
    return {source:localSecretSource(config), github};
  } catch { throw new Error('Invalid local secret holder configuration'); }
  finally { bytes?.fill(0); }
}

const writesSchema = z.object({
  holder: z.object({socket:path,ca:path,cert:path,key:path,servername:z.hostname()}).strict(),
  retryKeys: z.object({active:path,previous:z.array(path)}).strict(),
}).strict();
/** Separate explicit mutation config; the existing reader config stays read-only. */
export function configuredSecretWrites(file: string) {
  let bytes: Buffer | undefined;
  try {
    bytes = privateBytes(file);
    const config = writesSchema.parse(JSON.parse(bytes.toString('utf8')));
    return {holder:localHolderMutations(config.holder),retryKeys:config.retryKeys};
  } catch {throw new Error('Invalid secret mutation configuration');}
  finally {bytes?.fill(0);}
}
