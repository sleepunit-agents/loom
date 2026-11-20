/** Owner configuration only. References are never secret values or execution authority. */
import { z } from 'zod';
export const secretName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const slug = z.string().max(40).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const scopes = z.record(z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|tailnet:[a-z][a-z0-9-]{0,39})$/),
  z.string().max(200).refine(value => value.split('+').length <= 10 && value.split('+').every(word => /^(?:owner|[a-z0-9]+(?:-[a-z0-9]+)*|service:[a-z][a-z0-9-]{0,39})$/.test(word))))
  .refine(value => Object.keys(value).length <= 40);
const steers = z.record(slug.refine(value => value !== 'owner'), z.array(slug.refine(value => value !== 'owner')).min(1).max(10))
  .refine(value => Object.keys(value).length <= 40);
const secretMap = z.record(secretName, secretName).refine(value => Object.keys(value).length <= 32);
const port = z.object({
  ip: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}$/).refine(value => value.split('.').every(octet => Number(octet) <= 255)),
  port: z.number().int().min(1024).max(65535),
}).strict();
const tailnet = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  socket: z.string().max(400).regex(/^\/(?:[A-Za-z0-9._-]+\/)*tailscaled\.sock$/)
    .refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
}).strict();
export const grantFields = {
  nested: z.boolean(), gpu: z.boolean(), repoSecret: secretName.optional(), secrets: secretMap,
  ports: z.array(port).max(8).refine(value => new Set(value.map(item => item.port)).size === value.length),
  tailnets: z.array(tailnet).max(4).refine(value => new Set(value.map(item => item.name)).size === value.length),
  logins: z.array(z.enum(['claude', 'codex'])).max(2).optional(), scopes, steers,
};
export const houseGrants = z.object({ ...grantFields, scopeStores: z.record(secretName, secretName) }).strict();
/** Missing capability lists reset; missing scopes/steers/logins preserve prior restrictions. */
export const grantInput = z.object({
  nested: grantFields.nested.default(false), gpu: grantFields.gpu.default(false), repoSecret: grantFields.repoSecret,
  secrets: secretMap.default({}), ports: grantFields.ports.default([]), tailnets: grantFields.tailnets.default([]),
  logins: z.union([grantFields.logins.unwrap(), z.literal('default')]).optional(),
  scopes: z.union([scopes, z.literal('none')]).optional(), steers: z.union([steers, z.literal('none')]).optional(),
}).strict();
