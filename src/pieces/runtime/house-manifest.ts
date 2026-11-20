/** Pure validation of repository declarations. A manifest requests capabilities; it grants none. */
import { z } from 'zod';
import { inspectBuild, type BuildSnapshot } from './build-inspection.js';

const relative = z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine(v => !v.split('/').some(p => p === '.' || p === '..'));
const absolute = z.string().regex(/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine(v => !v.split('/').some(p => p === '.' || p === '..'))
  .refine(v => v !== '/run/secrets' && !v.startsWith('/run/secrets/'));
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const reserved = new Set(['LOOM_URL', 'HOUSE_ID', 'HOUSE_AGENT', 'HOUSE_TASK', 'HOUSE_SERVICE',
  'HOUSE_SESSION', 'LOOM_RUNTIME_NATIVE_HISTORY', 'PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);
const variable = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).refine(v => !reserved.has(v));
const destination = z.union([z.object({ file: name }).strict(), z.object({ env: variable }).strict()]);
const command = z.array(z.string().max(400)).min(1).max(32);
const port = z.string().regex(/^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{4,5})$/)
  .transform(v => { const parts = v.split(':'); return { ip: parts.length === 2 ? parts[0] : null, port: Number(parts.at(-1)) }; })
  .refine(v => v.port >= 1024 && v.port <= 65535 && (!v.ip || v.ip.split('.').every(p => Number(p) <= 255)));
const runFields = {
  command: command.optional(),
  secrets: z.record(name, destination).default({}),
  env: z.record(variable, z.string().max(2000).refine(v => !/[\x00-\x1f]/.test(v))).default({}),
  mounts: z.object({ state: absolute.optional(), nested: absolute.optional(), mirror: absolute.optional() }).strict().default({}),
  harnesses: z.array(z.enum(['claude', 'codex'])).max(4).optional(),
  nested: z.boolean().default(false),
  hostname: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
  ports: z.array(port).max(8).default([]),
  tailnets: z.record(slug, absolute).default({}),
};
const runBase = z.object(runFields).strict();
type RunInput = z.infer<typeof runBase>;
function validateRun(v: RunInput, ctx: z.RefinementCtx) {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Object.keys(v.secrets).length > 32) fail('At most 32 secrets');
  if (Object.keys(v.tailnets).length > 4) fail('At most 4 tailnets');
  const files = new Set<string>(), envs = new Set<string>(), targets = new Set<string>();
  for (const at of Object.values(v.secrets)) {
    const set = 'file' in at ? files : envs;
    const key = 'file' in at ? at.file : at.env;
    if (set.has(key)) fail('Secret destinations must be unique');
    set.add(key);
  }
  for (const key of Object.keys(v.env)) if (envs.has(key)) fail('Static env overlaps a secret destination');
  const harnesses = v.harnesses ?? [];
  if (new Set(harnesses).size !== harnesses.length) fail('Harnesses must be unique');
  for (const h of harnesses) {
    const key = h === 'claude' ? 'CLAUDE_SECURESTORAGE_CONFIG_DIR' : 'LOOM_LOGIN_CODEX';
    if (Object.hasOwn(v.env, key) || envs.has(key)) fail('Env is set by the requested harness login');
  }
  for (const target of [...Object.values(v.mounts), ...Object.values(v.tailnets)]) {
    if (target === undefined) continue;
    if (targets.has(target)) fail('Mount and tailnet destinations must be unique');
    targets.add(target);
  }
  if (new Set(v.ports.map(p => p.port)).size !== v.ports.length) fail('Ports must be unique');
}
const runSchema = runBase.superRefine(validateRun);
function normalizeRun(v: RunInput, task: 'stdin' | 'env' | null) {
  const { harnesses, ...rest } = v;
  return { ...rest, command: v.command ?? null, hostname: v.hostname ?? null, task, logins: harnesses ?? [] };
}
const build = z.object({ containerfile: relative, context: relative,
  watch: z.array(relative).max(64).transform(v => [...new Set(v)].sort()).optional() }).strict();
const houseSchema = z.object({ ...runFields, build,
  task: z.enum(['stdin', 'env']).default('stdin'),
  services: z.record(slug, runSchema).default({}),
  attach: z.array(z.string().max(400)).min(1).max(16).default(['sh']),
}).strict().superRefine(validateRun).refine(v => Object.keys(v.services).length <= 16, 'At most 16 services');

/** Parses at most 4 MiB of JSON. No IO, store, credential lookup or execution authorization. */
export function parseHouseManifest(text: string) {
  if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error('House file exceeds 4 MiB');
  const h = houseSchema.parse(JSON.parse(text));
  const { build, task, services, attach, ...run } = h;
  return { build, ...normalizeRun(run, task),
    services: Object.fromEntries(Object.entries(services).map(([key, value]) => [key, normalizeRun(value, null)])), attach };
}
export type HouseManifest = ReturnType<typeof parseHouseManifest>;

/** Full manifest validation precedes object inspection, all at the same immutable commit. */
export async function inspectHouseBuild(snapshot: BuildSnapshot, agent: string, houseFile?: string) {
  let house: HouseManifest | undefined;
  const inspected = await inspectBuild({
    commit: snapshot.commit,
    async text(commit, path) {
      const text = await snapshot.text(commit, path);
      house = parseHouseManifest(text);
      return text;
    },
    object: (commit, path) => snapshot.object(commit, path),
  }, agent, houseFile);
  return { ...inspected, house: house! };
}
