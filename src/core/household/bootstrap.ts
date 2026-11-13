/** Publish a complete portable context, then register it in the app transaction.
 * Filesystem publication can outlive a rolled-back SQLite transaction. A private
 * receipt binds that orphan to the exact caller/request; retry may register it
 * only while its initial files are still byte-identical. Never overwrite a context.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AGENT_NAME } from '../../household.js';
import { buildIdentityMd } from '../../tools/identity-scaffold.js';
import { buildPreferencesMd, buildSelfModelMd } from '../../tools/bootstrap.js';
import { OperationError, type Context } from '../operations/index.js';
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
  realDir(home);
  const parent = join(home, 'agents'), target = join(parent, input.agent);
  if (!existsSync(parent)) { mkdirSync(parent, { mode: 0o700 }); syncDir(home); }
  realDir(parent);
  const identity = buildIdentityMd({ name: input.name, purpose: input.purpose, voice: input.voice, user: household.owner }) +
    (input.rules ? `\n## Rules\n\n${input.rules}\n` : '') + (input.ask ? `\n## When to ask first\n\n${input.ask}\n` : '');
  const files: Record<string, string> = {
    'IDENTITY.md': identity, 'preferences.md': buildPreferencesMd(input.name, undefined, household.owner), 'self-model.md': buildSelfModelMd(),
  };
  const receipt = JSON.stringify({ v: 1, viewer: ctx.receipt.viewer, id: ctx.receipt.id, inputHash: ctx.receipt.inputHash,
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])) });
  // Do not follow even dangling symlinks, and never adopt an unrelated directory.
  let present = false; try { lstatSync(target); present = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (present) {
    realDir(target);
    try {
      if (readdirSync(target).sort().join('\n') !== [marker, ...Object.keys(files)].sort().join('\n')) throw new Error('Changed context');
      for (const name of [marker, ...Object.keys(files)]) {
        const stat = lstatSync(join(target, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe file');
      }
      if (readFileSync(join(target, marker), 'utf8') !== receipt || Object.entries(files).some(([name, value]) => readFileSync(join(target, name), 'utf8') !== value)) throw new Error('Different context');
    } catch { throw new OperationError('conflict', 'Context already exists; register it separately or retry its original unchanged creation'); }
  } else {
    const stage = mkdtempSync(join(parent, '.bootstrap-'));
    try {
      for (const [name, value] of Object.entries({ ...files, [marker]: receipt })) {
        const fd = openSync(join(stage, name), 'wx', 0o600);
        try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
      }
      syncDir(stage);
      // All daemon operations are synchronous and serialized; no incomplete context
      // is ever registered. Abandoned hidden staging directories are inert.
      renameSync(stage, target); syncDir(parent);
    } finally { if (existsSync(stage)) rmSync(stage, { recursive: true }); }
  }
  addHouseholdAgent(ctx.db, home, input.agent);
  ctx.changed('household.sharing', 'household'); ctx.changed('core.access', 'household');
  return { agent: input.agent, contextDir: target, mcp: { command: 'loom', args: ['mcp', '--next', '--home', home, '--agent', input.agent] } };
}
