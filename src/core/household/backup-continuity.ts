/** Explicit continuity inputs for the future encrypted household bundle.
 * No source discovery, app/legacy stores, publication or restored daemon.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { capturePortableFiles, type PortableFile, type ContextFileSelection } from './backup-files.js';
import type { Db } from '../db/index.js';

export interface ContinuitySources {
  /** Trusted registered-agent selection. null records deliberate store absence;
   * it is never inferred by catching a failed open or snapshot. */
  agents: readonly { agent: string; memories: Db | null; notes: Db | null }[];
  knowledge: Db | null;
  people: Db | null;
}
export interface ContinuityBudget { imageBytes: number; databaseBytes: number }
export interface HouseholdContinuity {
  databases: PortableFile[];
  files: PortableFile[];
  absent: string[];
}
const MAX_IMAGE = 256 * 1024 * 1024, MAX_DATABASES_BYTES = 512 * 1024 * 1024;
const agentName = /^[a-z][a-z0-9-]{0,39}$/;
const hashPattern = /^[a-f0-9]{64}$/;

/** Serialize each trusted continuity connection inside its own read transaction.
 * SQLite serialization includes the connection's WAL view; never copy .db/WAL
 * files or run legacy programs. Unlike the filtered app image, these stores are
 * intentionally complete, including SQLite virtual tables and their shadow rows.
 * This is not a simultaneous snapshot across databases or mutable documents.
 * Notes attachment selection comes ONLY from the corresponding reopened image;
 * concurrent attachment removal/change fails the capture instead of omitting it.
 * The caller owns every returned plaintext Buffer and must wipe after encryption.
 * Borrowed source connections remain open; no writes or caller transactions are committed.
 */
export function captureHouseholdContinuity(home: string, sources: ContinuitySources,
  budget: ContinuityBudget = { imageBytes: MAX_IMAGE, databaseBytes: MAX_DATABASES_BYTES }): HouseholdContinuity {
  const databases: PortableFile[] = [], absent: string[] = [], selection: ContextFileSelection[] = [];
  const sizes = new Map<string, number>();
  let files: PortableFile[] = [], total = 0, accepted = false;
  const snapshot = (source: Db | null, path: string, notes = false): string[] => {
    if (source === null) { absent.push(path); return []; }
    let bytes: Buffer | undefined, reopened: Db | undefined, transferred = false;
    try {
      if (source.inTransaction || !source.open) throw Error();
      source.transaction(() => {
        // Force the read snapshot before counting pages and serializing it.
        source.prepare('SELECT name FROM sqlite_schema').all();
        const count = Number(source.pragma('page_count', { simple: true }));
        const size = Number(source.pragma('page_size', { simple: true }));
        if (!Number.isSafeInteger(count) || !Number.isSafeInteger(size) || count < 0 || size <= 0
          || count * size > budget.imageBytes || total + count * size > budget.databaseBytes) throw Error();
        bytes = source.serialize();
      })();
      if (!bytes || bytes.length > budget.imageBytes || total + bytes.length > budget.databaseBytes) throw Error();
      // sqlite3_deserialize cannot open a WAL-mode header. SQLite documents
      // changing its read/write version bytes to rollback mode for this use.
      // The serialized image already contains the connection's committed WAL view.
      // https://sqlite.org/c3ref/deserialize.html
      if (bytes.length < 100 || bytes.toString('ascii', 0, 16) !== 'SQLite format 3\0') throw Error();
      bytes[18] = 1; bytes[19] = 1;
      reopened = new Database(bytes);
      sqliteVec.load(reopened);
      if (reopened.pragma('integrity_check', { simple: true }) !== 'ok'
        || (reopened.pragma('foreign_key_check') as unknown[]).length) throw Error();
      const hashes: string[] = [];
      if (notes) {
        // Require the owning schema even when it has no attachments.
        reopened.prepare('SELECT path FROM notes LIMIT 0').all();
        for (const row of reopened.prepare('SELECT sha256,bytes FROM note_files').all() as {sha256: unknown; bytes: unknown}[]) {
          if (typeof row.sha256 !== 'string' || !hashPattern.test(row.sha256)
            || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 10 * 1024 * 1024) throw Error();
          const attachment = `${path.slice(0, -'notes.db'.length)}note-files/${row.sha256.slice(0, 2)}/${row.sha256}`;
          if (sizes.has(attachment) && sizes.get(attachment) !== row.bytes) throw Error();
          sizes.set(attachment, row.bytes); hashes.push(row.sha256);
        }
      }
      // A failed close cannot turn a snapshot into successful ownership transfer.
      reopened.close(); reopened = undefined;
      databases.push({ path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
      total += bytes.length; transferred = true;
      return [...new Set(hashes)];
    } finally {
      try { reopened?.close(); } finally { if (!transferred) bytes?.fill(0); }
    }
  };
  try {
    // A worker may lower the memory ceiling, never raise the format's caps.
    budget = { ...budget };
    if (![budget.imageBytes, budget.databaseBytes].every(value => Number.isSafeInteger(value) && value > 0)
      || budget.imageBytes > MAX_IMAGE || budget.databaseBytes > MAX_DATABASES_BYTES) throw Error();
    const agents = sources.agents.map(item => ({ ...item }));
    if (new Set(agents.map(item => item.agent)).size !== agents.length || agents.some(item => !agentName.test(item.agent))) throw Error();
    for (const item of agents.sort((a, b) => a.agent.localeCompare(b.agent))) {
      const prefix = `agents/${item.agent}/`;
      snapshot(item.memories, `${prefix}memories.db`);
      selection.push({ agent: item.agent, noteHashes: snapshot(item.notes, `${prefix}notes.db`, true) });
    }
    snapshot(sources.knowledge, 'commons/knowledge.db');
    snapshot(sources.people, 'commons/people.db');
    files = capturePortableFiles(home, selection);
    for (const [path, size] of sizes) {
      const file = files.find(item => item.path === path);
      if (!file || file.bytes.length !== size) throw Error();
    }
    accepted = true;
    return { databases, files, absent };
  } catch {
    throw new Error('Household continuity capture failed');
  } finally {
    if (!accepted) for (const file of [...databases, ...files]) file.bytes.fill(0);
  }
}
