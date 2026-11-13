/** Repository snapshot inspection for the separate runner. No store, process or credential access. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
const path = z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine(v => !v.split('/').some(p => p === '.' || p === '..'));
const buildSchema = z.object({ containerfile: path, context: path, watch: z.array(path).max(64).optional() }).strict();
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export interface BuildSnapshot {
  /** Immutable commit id, resolved once by the runner after fetching. Never a moving branch. */
  commit: string;
  text(commit: string, path: string): Promise<string>;
  object(commit: string, path: string): Promise<{ id: string; type: 'tree' | 'blob' | 'commit' }>;
}
/**
 * Inspect only the build declaration, not the executable house specification.
 * The caller owns fetching, outside-effect gating and authorization; this helper is unregistered.
 */
export async function inspectBuild(snapshot: BuildSnapshot, agent: string, houseFile = 'house/house.json') {
  z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).parse(agent);
  const commit = oid.parse(snapshot.commit);
  path.parse(houseFile);
  const text = await snapshot.text(commit, houseFile);
  if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error('House file exceeds 4 MiB');
  const house = z.object({ build: buildSchema }).parse(JSON.parse(text));
  const build = house.build;
  const watched = [...new Set(build.watch ?? [])].sort();
  const objects = new Map<string, { id: string; type: 'tree' | 'blob' | 'commit' }>();
  for (const at of new Set([build.context, build.containerfile, ...watched])) {
    const object = await snapshot.object(commit, at);
    oid.parse(object.id);
    if (!['tree', 'blob', 'commit'].includes(object.type)) throw new Error('Unknown Git object type');
    objects.set(at, object);
  }
  const context = objects.get(build.context)!;
  const containerfile = objects.get(build.containerfile)!;
  if (context.type !== 'tree' || containerfile.type !== 'blob') throw new Error('Build context must be a tree and Containerfile a blob');
  const suffix = watched.length
    ? createHash('sha256').update(JSON.stringify([context.id, containerfile.id,
      ...watched.map(at => [at, objects.get(at)!.id])])).digest('hex').slice(0, 20)
    : context.id.slice(0, 12) + containerfile.id.slice(0, 8);
  return { commit, image: `loom-house-${agent}:${suffix}` };
}
