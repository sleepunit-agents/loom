/** Next-side configuration only. Saving never arms the old backup program. */
import { z } from 'zod';
import { isAbsolute, relative, resolve, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Foundation } from '../app.js';
import { OperationError } from '../operations/index.js';
import { householdOperation as operation } from './commands.js';
import { backupSettingsSchema } from './backup-schema.js';
import { HouseholdDatabase } from './document.js';
import { SharingDatabase } from './sharing.js';
import { mayAct, type Viewer } from '../../policy.js';

/** Resolve existing ancestors too: a not-yet-created directory below a symlink
 * must not put encrypted bundles beside their future local drill key. */
function canonical(path: string): string {
  let held = resolve(path); const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(held), ...tail.reverse()); } catch {
      const parent = dirname(held);
      if (parent === held) throw new OperationError('invalid', 'Cannot resolve the backup target');
      tail.push(basename(held)); held = parent;
    }
  }
}
function outsideHome(target: string, home: string): boolean {
  const path = target.startsWith('path:') ? target.slice(5) : target.startsWith('git:/') ? target.slice(4)
    : target.startsWith('git:file:') ? decodeURIComponent(new URL(target.slice(4)).pathname) : undefined;
  if (!path) return true;
  const inside = (a: string, b: string) => { const r = relative(b, a); return r === '' || !isAbsolute(r) && r !== '..' && !r.startsWith('../'); };
  return !inside(resolve(path), resolve(home)) && !inside(canonical(path), canonical(home));
}
export function installHouseholdBackup(app: Foundation, home: string): void {
  const household = new HouseholdDatabase(app.db), sharing = new SharingDatabase(app.db, home);
  const owner = (v: Viewer) => mayAct(v, {}, sharing.sharing(), 'household');
  const read = () => {
    const raw = household.document();
    if (!raw) throw new OperationError('unavailable', 'Household is unavailable');
    if (raw.backup === undefined) return { settings: null, state: 'off' as const, message: 'Nightly backup is off.' };
    const settings = backupSettingsSchema.safeParse(raw.backup);
    // Imported unknown fields never become returned metadata (or error text).
    if (!settings.success) return { settings: null, state: 'invalid' as const, message: 'Saved backup settings are invalid. Replace them before enabling backups.' };
    return { settings: settings.data, state: 'awaiting-runner' as const, message: 'Configuration saved. Next-mode backup execution is not available yet; no backup is scheduled.' };
  };
  app.operations.register(operation({ name: 'household.backup', input: z.object({}).strict(), may: owner, run: read }));
  app.operations.register(operation({
    name: 'household.setBackup', write: true, input: backupSettingsSchema, may: owner,
    run(ctx, input) {
      if (!outsideHome(input.target, home)) throw new OperationError('invalid', 'A backup target must be outside the household home');
      household.change(home, raw => { raw.backup = input; });
      ctx.changed('household.backup', 'household'); return read();
    },
  }));
  app.operations.register(operation({
    name: 'household.backupOff', write: true, input: z.object({}).strict(), may: owner,
    run(ctx) {
      household.change(home, raw => { delete raw.backup; });
      ctx.changed('household.backup', 'household'); return read();
    },
  }));
  app.live.register({
    name: 'household.backup', ids: () => ['household'],
    read(id, viewer) { if (id === 'household' && owner(viewer)) return { id, ...read() }; },
    inScope: (_record, scope) => scope === undefined,
  });
}
