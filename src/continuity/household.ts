/**
 * Explicit household metadata for the next stdio composition. Nothing imports
 * this to select a backend: callers opt in with a home. Legacy householdOf and
 * contextFromHome remain JSON-only, and standalone contexts need no app DB.
 */
import Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { HouseholdDatabase } from '../core/household/document.js';
import { agentDir, commonsDir, commonsKnowledgePath, type Household } from '../household.js';

export interface ContinuityHousehold {
  household: Household;
  agent: string;
  contextDir: string;
  knowledgePath: string;
  peoplePath: string;
}

/**
 * Opens only an existing database, reads a coherent metadata snapshot, closes.
 * No migrations, journal-mode changes, application locks, jobs, or JSON reads.
 * SQLite may create WAL/SHM sidecars when opening a checkpointed WAL database;
 * do not use immutable mode, which would miss a running daemon's committed WAL.
 * Missing/uninitialised/damaged app metadata is an error, never a fallback.
 */
export function readContinuityHousehold(home: string, agent?: string): ContinuityHousehold {
  const canonicalHome = realpathSync(home);
  const db = new Database(join(canonicalHome, 'loom.db'), { readonly: true, fileMustExist: true, timeout: 0 });
  let household: Household;
  try {
    // Defence in depth, including against accidental future writes on this
    // connection. This setting is connection-local, not persisted app state.
    db.pragma('query_only = ON');
    const found = new HouseholdDatabase(db).household(canonicalHome);
    if (!found) throw new Error(`no household metadata in ${canonicalHome}/loom.db`);
    household = found;
  } finally { db.close(); }
  const selected = agent ?? household.default;
  if (!household.agents.includes(selected)) throw new Error(`agent ${JSON.stringify(selected)} is not in the household at ${canonicalHome}`);
  return {
    household, agent: selected, contextDir: agentDir(household, selected),
    knowledgePath: commonsKnowledgePath(household), peoplePath: join(commonsDir(household), 'people.db'),
  };
}

/**
 * Resolve a configured stdio target without discovering a backend from a file
 * or import receipt. An explicit context outside the configured household is
 * standalone; an in-house context must name a registered agent. Symlink aliases
 * use their real target just as the existing context-directory contract does.
 */
export function continuityTarget(options: { home?: string; agent?: string; contextDir?: string }):
  { contextDir: string; metadata: ContinuityHousehold | null } {
  const { home, agent, contextDir } = options;
  if (contextDir !== undefined) {
    const context = resolve(contextDir);
    if (home === undefined) return { contextDir: context, metadata: null };
    let canonicalHome: string;
    try { canonicalHome = realpathSync(home); }
    catch (error) {
      if (dirname(context) === join(resolve(home), 'agents')) throw error;
      return { contextDir: context, metadata: null };
    }
    let real: string;
    try { real = realpathSync(context); }
    catch (error) {
      // A typo under a household must not silently become a standalone brain.
      if (dirname(context) === join(canonicalHome, 'agents') || dirname(context) === join(resolve(home), 'agents')) throw error;
      return { contextDir: context, metadata: null };
    }
    if (dirname(real) !== join(canonicalHome, 'agents')) return { contextDir: context, metadata: null };
    const metadata = readContinuityHousehold(home, basename(real));
    return { contextDir: metadata.contextDir, metadata };
  }
  if (home === undefined) throw new Error('next stdio needs an explicit household home or standalone context directory');
  const metadata = readContinuityHousehold(home, agent);
  return { contextDir: metadata.contextDir, metadata };
}
