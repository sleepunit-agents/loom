/** A kit tool runs one executable from an approved immutable house image. Every
 * argument is either one literal or one whole typed value. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {SHA256_HEX,SHA256_HEX_WITHIN} from '../core/sha256-hex.js';
import {COMMIT} from '../apps/merge-target.js';
import {houseSecretAlias,secretName} from '../pieces/secrets/input.js';
import {houseFile,houseRepository} from './house-source.js';

import {denialCoversTool} from './tool-denial.js';
import {harnessToolPrefix} from './body-harness.js';

export const kitModelName=(name:string)=>'kit_'+name;
/** Two kits may declare the same name. Keep both identifiable within the harness's 64-character limit. */
export function qualifiedKitName(name:string,kit:string){
  const hash=createHash('sha256').update(kit).digest('hex').slice(0,16);
  const prefix=kitModelName(name)+'_';
  return prefix+kit.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,64-prefix.length-hash.length-1)+'_'+hash;
}
export function kitToolDenied(name:string,denials:readonly string[],kit?:string){
  const names=[kitModelName(name),...(kit?[qualifiedKitName(name,kit)]:[])];
  return denials.some(entry=>names.some(model=>denialCoversTool(entry,harnessToolPrefix+model)));
}
export const KIT_IMAGE=new RegExp('^sha256:'+SHA256_HEX_WITHIN+'$');
/** Engines can inspect the same immutable image under a bare or prefixed digest. */
export function canonicalKitImage(id:unknown):string|undefined{
  if(typeof id!=='string')return;
  if(KIT_IMAGE.test(id))return id;
  if(SHA256_HEX.test(id))return 'sha256:'+id;
}
const safeKey=z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).refine(key=>!Object.hasOwn(Object.prototype,key));
const description=z.string().trim().min(1).max(512);
const text=z.string().max(4096).refine(value=>!value.includes('\0'));
const inputText=text.refine(value=>value.length>0&&!/^[-@]/.test(value)&&!value.includes('..')&&!/[\/\\\x00-\x1f\x7f]/.test(value),'Argument must be a single value, without path or option syntax');
export const kitParameter=z.strictObject({type:z.enum(['string','integer','boolean']),description});
const bounded=(value:Record<string,unknown>)=>Object.keys(value).length<=16;
export const kitTool=z.strictObject({
  name:safeKey,description,
  program:z.string().refine(houseFile).regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*$/),repository:z.string().refine(houseRepository),
  commit:z.string().regex(COMMIT),image:z.string().regex(KIT_IMAGE),
  parameters:z.record(safeKey,kitParameter).refine(bounded),
  args:z.array(z.union([text,z.strictObject({parameter:safeKey})])).max(64),
  secrets:z.record(houseSecretAlias.refine(key=>/^KIT_[A-Z][A-Z0-9_]{0,59}$/.test(key)),secretName).refine(bounded),
}).refine(tool=>tool.args.every(arg=>typeof arg==='string'||Object.hasOwn(tool.parameters,arg.parameter)),'Unknown parameter');
export type KitTool=z.infer<typeof kitTool>;
export const kitTools=z.array(kitTool).max(16).refine(tools=>new Set(tools.map(tool=>tool.name)).size===tools.length,'Repeated tool name');

export function kitInputSchema(parameters:KitTool['parameters']){
  return z.strictObject(Object.fromEntries(Object.entries(parameters).map(([name,field])=>[
    name,(field.type==='boolean'?z.boolean():field.type==='integer'?z.number().int().nonnegative():inputText).describe(field.description),
  ])));
}
export function kitArguments(tool:KitTool,input:unknown):string[]{
  const values=kitInputSchema(tool.parameters).parse(input);
  return tool.args.map(arg=>typeof arg==='string'?arg:String(values[arg.parameter]));
}
