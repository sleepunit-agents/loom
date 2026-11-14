/** Internal Linux restore materialization. The output remains quarantined;
 * owning Secrets recovery and usable-home acceptance are separate work. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { restorePending, restorePrefix } from '../home-state.js';
import { withHouseholdRestore, type RestoreBudget, type ValidatedHouseholdBundle } from './backup-restore.js';

/** Temporary owning role until Secrets supplies its recovery implementation.
 * Construct it with an explicit, isolated, absent holder destination and owner
 * authority. It must never discover a live holder, self-grant, or change one.
 * restore consumes borrowed opaque bytes, durably restores ALL holder state
 * (including historical identities and fingerprint/receipt keys), and returns
 * the original recovery session. On rejection it must clean its own acquisitions.
 * accept checks that actual restored state against the supplied recovery part.
 * close stops/joins all original recovery resources, even after failed accept;
 * it retains the stopped restored state. Neither method may retain input bytes.
 * This is trusted local code, not a serialized capability or operation input.
 */
export interface HouseholdSecretsRestore {
  restore(bytes: Buffer): Promise<{
    accept(): Promise<void>;
    close(): Promise<void>;
  }>;
}

/** Fresh staging plus owning Secrets recovery. Still NOT a usable-home restore.
 * Never reopens/adopts an existing candidate; never removes the startup fence.
 * Success reports only this invocation's joined owning recovery. The returned
 * state is not a receipt/capability authorizing future activation or retry.
 * No production role or public caller exists yet. The owning implementation and
 * actual restored sign-in/stdio acceptance remain required before activation.
 */
export async function stageHouseholdRestoreWithRecovery(ciphertext: Uint8Array, identity: string, destination: string,
  secrets: HouseholdSecretsRestore, budget?: RestoreBudget): Promise<{ home: string; state: 'awaiting-household-acceptance' }> {
  try {
    // Pin the original role method before decryption's first async boundary.
    const restoreMethod = secrets?.restore;
    if (typeof restoreMethod !== 'function') throw Error();
    const restore = restoreMethod.bind(secrets);
    return await withHouseholdRestore(ciphertext, identity, async bundle => {
      materialize(bundle, destination);
      const original = bundle.files.get('secrets/recovery.age')!;
      const copy = Buffer.from(original);
      try {
        const session = await restore(copy);
        // Capture cleanup before reading/validating accept so malformed accept
        // cannot skip the original session's available cleanup.
        const closeMethod = session?.close;
        if (typeof closeMethod !== 'function') throw Error();
        const close = closeMethod.bind(session);
        try {
          const acceptMethod = session.accept;
          if (typeof acceptMethod !== 'function' || !copy.equals(original)) throw Error();
          const accept = acceptMethod.bind(session);
          await accept();
          if (!copy.equals(original)) throw Error();
        } finally { await close(); }
        if (!copy.equals(original)) throw Error();
      } finally { copy.fill(0); }
      return { home: destination, state: 'awaiting-household-acceptance' as const };
    }, budget);
  } catch { throw new Error('Household owning recovery failed'); }
}

/** Destination must NOT exist, even as an empty directory. Its existing parent
 * must belong to this OS user with mode 0700. Destination basename must start
 * with .loom-restore- (with a nonempty suffix): startup reserves that namespace
 * even before the first blocker write. Never replaces/deletes any path.
 * Decryption and complete validation precede destination IO. Failed writes leave
 * private, blocked candidates, not a usable home. No retry into an existing one.
 * Caller must retain the encrypted source until recovery has been accepted.
 */
export async function stageHouseholdRestore(ciphertext: Uint8Array, identity: string, destination: string,
  budget?: RestoreBudget): Promise<{ home: string; state: 'awaiting-secrets-restore' }> {
  try {
    return await withHouseholdRestore(ciphertext, identity, bundle => materialize(bundle, destination), budget);
  } catch { throw new Error('Household restore staging failed'); }
}

function materialize(bundle: ValidatedHouseholdBundle, home: string): { home: string; state: 'awaiting-secrets-restore' } {
  if (process.platform !== 'linux' || process.getuid === undefined || !isAbsolute(home)
    || home.includes('\\') || home.includes('\0') || home.endsWith('/')) throw Error();
  const parts = home.split('/').slice(1);
  if (!parts.length || parts.some(p => !p || p === '.' || p === '..')) throw Error();
  if (!parts.at(-1)!.startsWith(restorePrefix) || parts.at(-1)!.length <= restorePrefix.length) throw Error();
  const held: number[] = [], edges: { parent: number; leaf: string; fd: number }[] = [];
  const directories = new Map<string, number>();
  const at = (fd: number, leaf: string) => `/proc/self/fd/${fd}/${leaf}`;
  const pin = (parent: number | undefined, leaf: string): number => {
    const fd = openSync(parent === undefined ? leaf : at(parent, leaf), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    held.push(fd);
    if (parent !== undefined) edges.push({ parent, leaf, fd });
    return fd;
  };
  const privateDirectory = (parent: number, leaf: string): number => {
    mkdirSync(at(parent, leaf), { mode: 0o700 }); // exclusive: EEXIST refuses
    const fd = pin(parent, leaf);
    const st = fstatSync(fd);
    if (st.uid !== process.getuid!() || (st.mode & 0o7777) !== 0o700) throw Error();
    return fd;
  };
  const write = (parent: number, leaf: string, bytes: Uint8Array): void => {
    const fd = openSync(at(parent, leaf), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!count) throw Error();
        offset += count;
      }
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || st.size !== bytes.length || (st.mode & 0o7777) !== 0o600) throw Error();
      fsyncSync(fd);
    } finally { closeSync(fd); }
  };
  let failed = false;
  try {
    let parent = pin(undefined, '/');
    for (const part of parts.slice(0, -1)) parent = pin(parent, part);
    const st = fstatSync(parent);
    if (st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o700) throw Error();
    const root = privateDirectory(parent, parts.at(-1)!);
    // Persist the blocker before publishing any app image. If this first write
    // fails there is no loom.db; all later failures retain the durable blocker.
    write(root, restorePending, Buffer.from('awaiting owning Secrets recovery and restored-home acceptance\n'));
    fsyncSync(root); fsyncSync(parent);
    directories.set('', root);
    for (const [path, bytes] of bundle.files) {
      const components = path.split('/'), leaf = components.pop()!;
      let dir = root, prefix = '';
      for (const component of components) {
        prefix = prefix ? `${prefix}/${component}` : component;
        let fd = directories.get(prefix);
        if (fd === undefined) { fd = privateDirectory(dir, component); directories.set(prefix, fd); }
        dir = fd;
      }
      write(dir, leaf, bytes);
    }
    // Fail rather than report a home whose name was replaced during the write.
    // Every write used pinned descriptors even if an ancestor was renamed.
    for (const { parent, leaf, fd } of edges) {
      const linked = lstatSync(at(parent, leaf)), pinned = fstatSync(fd);
      if (!linked.isDirectory() || linked.dev !== pinned.dev || linked.ino !== pinned.ino) throw Error();
    }
    // Child contents before directory entries, then the destination's parent.
    for (const fd of [...directories.values()].reverse()) fsyncSync(fd);
    fsyncSync(parent);
  } catch { failed = true; }
  finally {
    // A close failure is failure too, but never prevents the other closes.
    for (const fd of held.reverse()) try { closeSync(fd); } catch { failed = true; }
  }
  if (failed) throw Error();
  return { home, state: 'awaiting-secrets-restore' };
}
