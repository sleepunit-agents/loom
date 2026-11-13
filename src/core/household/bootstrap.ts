/** Publish a complete portable context, then register it in the app transaction.
 * Filesystem publication can outlive a rolled-back SQLite transaction. A private
 * receipt binds that orphan to the exact caller/request; retry may register it
 * only while its initial files are still byte-identical. Never overwrite a context.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, linkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AGENT_NAME } from '../../household.js';
import { buildIdentityMd } from '../../tools/identity-scaffold.js';
import { buildPreferencesMd, buildSelfModelMd } from '../../tools/bootstrap.js';
import { OperationError, type Context, type WriteReceipt } from '../operations/index.js';
import { HouseholdDatabase } from './document.js';
import { addHouseholdAgent } from './agents.js';
const text = z.string().trim().min(1).max(20_000);
export const bootstrapInput = z.object({
  agent: z.string().regex(AGENT_NAME), name: z.string().trim().min(1).max(120).regex(/^[^\r\n]+$/),
  purpose: text, voice: text, rules: z.string().trim().max(20_000).default(''), ask: z.string().trim().max(20_000).default(''),
}).strict();
export type BootstrapInput = z.infer<typeof bootstrapInput>;
const marker = '.loom-bootstrap.json';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function syncDir(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function realDir(path: string) { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new OperationError('invalid', 'Agent directories must be real directories'); }
export function bootstrapHouseholdAgent(ctx: Context, home: string, input: BootstrapInput) {
  if (!ctx.receipt || !ctx.db.inTransaction) throw new Error('Bootstrap requires an operation transaction');
  const household = new HouseholdDatabase(ctx.db).household(home);
  if (!household) throw new OperationError('unavailable', 'Household is not initialized');
  if (household.agents.includes(input.agent)) throw new OperationError('conflict', 'Agent is already registered');
  const target = publishBootstrapContext(home, input, household.owner, ctx.receipt);
  addHouseholdAgent(ctx.db, home, input.agent, true);
  ctx.changed('household.sharing', 'household'); ctx.changed('core.access', 'household');
  return { agent: input.agent, contextDir: target, mcp: { command: 'loom', args: ['mcp', '--next', '--home', home, '--agent', input.agent] } };
}

/** Filesystem publication only. The caller commits its registration and recovery identity. */
export function publishBootstrapContext(home: string, input: BootstrapInput, owner: string | undefined, publication: Pick<WriteReceipt, 'viewer' | 'id' | 'inputHash'>): string {
  realDir(home);
  const parent = join(home, 'agents'), target = join(parent, input.agent);
  if (!existsSync(parent)) { mkdirSync(parent, { mode: 0o700 }); syncDir(home); }
  realDir(parent);
  const identity = buildIdentityMd({ name: input.name, purpose: input.purpose, voice: input.voice, user: owner }) +
    (input.rules ? `\n## Rules\n\n${input.rules}\n` : '') + (input.ask ? `\n## When to ask first\n\n${input.ask}\n` : '');
  const files: Record<string, string> = {
    'IDENTITY.md': identity, 'preferences.md': buildPreferencesMd(input.name, undefined, owner), 'self-model.md': buildSelfModelMd(),
  };
  const receipt = JSON.stringify({ v: 1, viewer: publication.viewer, id: publication.id, inputHash: publication.inputHash,
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])) });
  // Do not follow even dangling symlinks, and never adopt an unrelated directory.
  let present = false; try { lstatSync(target); present = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const all = { [marker]: receipt, ...files };
  if (present) {
    realDir(target);
    try {
      if (!readFileSync(join(target, marker)).equals(Buffer.from(receipt))) throw new Error('Different request');
      if (readdirSync(target).some(name => !Object.hasOwn(all, name))) throw new Error('Changed context');
      for (const [name, value] of Object.entries(all)) {
        const path = join(target, name);
        let stat;
        try { stat = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !readFileSync(path).equals(Buffer.from(value))) throw new Error('Changed context');
      }
    } catch { throw new OperationError('conflict', 'Context already exists; register it separately or retry its original unchanged creation'); }
  }
  const stage = mkdtempSync(join(parent, '.bootstrap-'));
  try {
    for (const [name, value] of Object.entries(all)) {
      const fd = openSync(join(stage, name), 'wx', 0o600);
      try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    }
    syncDir(stage);
    if (!present) {
      // mkdir and hard links are exclusive even against other filesystem callers.
      // A crash before the receipt link leaves an inert, unregistered reservation;
      // it is refused on retry, never adopted or automatically deleted.
      try { mkdirSync(target, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new OperationError('conflict', 'Context already exists'); throw e; }
    }
    for (const name of Object.keys(all)) {
      const path = join(target, name);
      if (present) {
        try { lstatSync(path); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      linkSync(join(stage, name), path);
    }
  } finally { rmSync(stage, { recursive: true }); }
  // Flush recovered files too, including a prior publication whose flush failed.
  for (const name of Object.keys(all)) {
    const fd = openSync(join(target, name), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  // Repeat directory flushes on recovery too: a previous attempt may have
  // published successfully and then failed here before SQLite registration.
  syncDir(target); syncDir(parent); syncDir(home);
  return target;
}
