import { z } from 'zod';
import { name, person, repoOf, hostOf, grantOf, vouchOf, resetOf, writeoffOf } from './targets.js';
const agent = z.string().regex(new RegExp(`^${name}$`));
const slug = z.string().max(80).regex(person);
const timestamp = z.string().datetime({offset:true});
export const whoSchema = z.object({agent,where:z.string().min(1).max(300)}).passthrough();
const principal = z.union([z.literal('?'),slug]);
const people = z.array(slug).max(200).refine(p=>new Set(p).size===p.length,'Duplicate people');
export const callerSchema = z.object({
  who:whoSchema,for:principal,people:people.optional(),
  conversation:z.string().regex(/^cv-[0-9a-f]{12}$/).optional(),
  project:slug.optional(),
}).passthrough();
export const approvalSchema = z.object({
  id:z.string().regex(/^a-[0-9a-f]{8}$/),kind:agent,target:z.string().min(1).max(200).regex(/^[\x21-\x7e]+( [\x21-\x7e]+)*$/),
  what:z.string(),why:z.string(),who:whoSchema,for:principal.optional(),people:people.optional(),
  minutes:z.number().finite().positive().max(1440),at:timestamp,
  state:z.enum(['pending','allowed','denied','used','withdrawn','expired']),
  ask:z.string().optional(),if_yes:z.string().optional(),if_no:z.string().optional(),details:z.string().optional(),
  conversation:z.string().regex(/^cv-[0-9a-f]{12}$/).optional(),
  digest:z.string().regex(/^[0-9a-f]{64}$/).optional(),
  decided:timestamp.optional(),expires:timestamp.optional(),used:timestamp.optional(),withdrawn:timestamp.optional(),
  by:slug.optional(),granted:z.boolean().optional(),superseded_by:z.string().regex(/^a-[0-9a-f]{8}$/).optional(),
  project:slug.optional(),agent:agent.optional(),member:slug.optional(),
}).passthrough().superRefine((a,ctx)=>{
  const parsed = a.kind==='merge'?repoOf(a.target):a.kind==='host'?hostOf(a.target):a.kind==='grant'?grantOf(a.target):a.kind==='vouch-wake'?vouchOf(a.target):a.kind==='principal-reset'?resetOf(a.target):a.kind==='box-write-off'?writeoffOf(a.target):true;
  if(!parsed)ctx.addIssue({code:'custom',message:'Invalid typed approval target'});
  if(['allowed','expired','used'].includes(a.state)&&!a.expires)ctx.addIssue({code:'custom',message:'A yes needs its expiry'});
  if(['allowed','denied','expired','used'].includes(a.state)&&!a.decided)ctx.addIssue({code:'custom',message:'An answer needs its decision time'});
  if(a.state==='used'&&!a.used)ctx.addIssue({code:'custom',message:'A spent receipt needs its use time'});
  if(a.state==='withdrawn'&&!a.withdrawn)ctx.addIssue({code:'custom',message:'A withdrawal needs its time'});
  if(a.agent&&a.agent!==a.who.agent)ctx.addIssue({code:'custom',message:'Scope agent differs from asker'});
});
export const standingSchema = z.object({
  id:z.string().regex(/^s-[0-9a-f]{8}$/),kind:z.literal('local-wake'),agent,
  target:z.string(),digest:z.string().regex(/^[0-9a-f]{64}$/),who:whoSchema,
  for:principal,people:people.optional(),from:z.string().regex(/^a-[0-9a-f]{8}$/),
  what:z.string(),details:z.string().optional(),at:timestamp,by:slug.optional(),
  uses:z.number().int().nonnegative().safe(),used:timestamp.optional(),
  off:z.object({at:timestamp,by:slug.optional()}).passthrough().optional(),
}).passthrough().refine(j=>j.target===`${j.agent}:${j.digest.slice(0,16)}`&&j.who.agent===j.agent,'Standing target differs from caller or digest');

export const ruleSchema = z.object({
  kind:z.enum(['merge','host']),scope:z.string(),tier:z.enum(['do','tell','ask']),
  by:slug,at:timestamp,person:slug.optional(),
}).passthrough();
export const noticeSchema = z.object({at:timestamp,agent,kind:z.string(),target:z.string(),what:z.string(),for:principal.optional()}).passthrough();
