/** Git object reader for the separate runner, against an already fetched repository. */
import type { BuildSnapshot } from './build-inspection.js';

/** Bound to one repository by the runner. Must use argv, enforce maxBytes while reading,
 * reject nonzero exits, and disable replacement objects. Never run on a request path.
 * Process lifetime, cancellation, environment and outside-effect gating belong to the runner. */
export type SnapshotGit = (args: readonly string[], maxBytes: number) => Promise<string>;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const filePath = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const houseLimit = 4 * 1024 * 1024;
const modes: Record<string, string> = { '040000': 'tree', '100644': 'blob', '100755': 'blob', '160000': 'commit' };
function path(value: string) {
  if (!filePath.test(value) || value.split('/').some(p => p === '.' || p === '..')) throw new Error('Invalid snapshot path');
  return value;
}
function objectId(value: string) {
  if (!oid.test(value)) throw new Error('Invalid Git object id');
  return value;
}
/** Resolve HEAD, a full ref or a full object id exactly once. No revision expressions. */
export async function gitSnapshot(git: SnapshotGit, revision = 'HEAD'): Promise<BuildSnapshot> {
  const ref = /^refs\/(?:heads|tags|remotes)\/[A-Za-z0-9._/-]+$/;
  if (!oid.test(revision) && revision !== 'HEAD' && (!ref.test(revision)
    || revision.includes('..') || revision.includes('//') || revision.endsWith('/')
    || revision.split('/').some(p => p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock')))) {
    throw new Error('Invalid snapshot revision');
  }
  async function run(args: string[], limit: number) {
    const text = await git(['--no-replace-objects', '--literal-pathspecs', ...args], limit);
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('Git snapshot output exceeds limit');
    return text;
  }
  const commit = objectId((await run(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], 128)).trim());
  const pinned = (at: string) => { if (at !== commit) throw new Error('Snapshot commit mismatch'); };
  async function entry(at: string, file: string) {
    pinned(at); path(file);
    const raw = await run(['ls-tree', '-z', '--full-tree', commit, '--', file], 4096);
    // A literal exact entry only: no directory expansion, symlinks or unknown modes.
    const match = /^(040000|100644|100755|160000) (tree|blob|commit) ([0-9a-f]+)\t([^\0]+)\0$/.exec(raw);
    if (!match || match[4] !== file || modes[match[1]] !== match[2]) {
      throw new Error('Missing or unsupported Git snapshot entry');
    }
    return { id: objectId(match[3]), type: match[2] as 'tree' | 'blob' | 'commit' };
  }
  return Object.freeze({ commit, object: entry,
    async text(at: string, file: string) {
      const object = await entry(at, file);
      if (object.type !== 'blob') throw new Error('Snapshot text must be a regular file');
      const size = await run(['cat-file', '-s', object.id], 32);
      if (!/^(?:0|[1-9][0-9]*)\n$/.test(size) || Number(size) > houseLimit) throw new Error('Invalid or oversized snapshot text');
      const text = await run(['cat-file', 'blob', object.id], houseLimit);
      if (Buffer.byteLength(text, 'utf8') !== Number(size)) throw new Error('Snapshot text byte count mismatch');
      return text;
    },
  });
}
