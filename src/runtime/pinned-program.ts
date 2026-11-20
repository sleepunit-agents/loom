import {z} from 'zod';
import {SHA256_HEX,SHA256_HEX_WITHIN} from '../core/sha256-hex.js';
import {COMMIT} from '../apps/merge-target.js';
import {houseSecretAlias,secretName} from '../pieces/secrets/input.js';
import {houseFile,houseRepository} from './house-input.js';

export const KIT_IMAGE=new RegExp('^sha256:'+SHA256_HEX_WITHIN+'$');
/** Engines can inspect the same immutable image under a bare or prefixed digest. */
export function canonicalKitImage(id:unknown):string|undefined{
  if(typeof id!=='string')return;
  if(KIT_IMAGE.test(id))return id;
  if(SHA256_HEX.test(id))return 'sha256:'+id;
}
export const programLiteral=z.string().max(4096).refine(value=>!value.includes('\0'));
export const programPath=z.string().refine(houseFile).regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*$/);
export const programSecretAlias=houseSecretAlias.regex(/^KIT_[A-Z][A-Z0-9_]{0,59}$/);
export const pinnedProgram=z.strictObject({
  program:programPath, repository:z.string().refine(houseRepository),
  commit:z.string().regex(COMMIT),image:z.string().regex(KIT_IMAGE),
  args:z.array(programLiteral).max(64),
  secrets:z.record(programSecretAlias,secretName).refine(bindings=>Object.keys(bindings).length<=16),
});
