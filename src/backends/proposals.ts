/**
 * Drafted memory writes waiting for a person to accept them.
 *
 * A proposal is not a memory. Proposals live in their own table (`proposals`), which recall, the memory
 * list, the salience digest and find-similar never read. A draft can be rough; it becomes a memory only when
 * it is ratified, and ratifying writes it through the same checks as any other memory write.
 *
 * Both functions here work on the caller's connection, inside the caller's transaction, so the draft, the
 * memory and the command's receipt are saved together.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { MemoryInput, MemoryRef } from './types.js';
import { retryWrite } from './retry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProposalInput {
  category: string;
  title: string;
  content: string;
  project?: string;
  ttl?: string;
  metadata?: Record<string, unknown>;
  /** Where the proposal came from, e.g. a lane name. */
  source?: string;
}

export interface ProposalRow {
  id: number;
  uuid: string;
  category: string | null;
  title: string | null;
  content: string | null;
  project: string | null;
  ttl: string | null;
  metadata: string;
  source: string | null;
  created: string;
  status: string;
}

export interface ProposalRef {
  id: number;
  uuid: string;
}

/** Optional Art-on-accept edits applied at ratify time. */
export interface ProposalOverrides {
  title?: string;
  content?: string;
  category?: string;
  project?: string;
  ttl?: string;
}

/** Thrown when a proposal id can't be found in the queue. */
export class UnknownProposalError extends Error {
  constructor(id: number) {
    super(`proposal not found: ${id}`);
    this.name = 'UnknownProposalError';
  }
}

// ─── Queue operations ─────────────────────────────────────────────────────────

/**
 * Stage a pending proposal. A draft can be rough, so it is not held to the
 * `remember` shape a memory is, but it does need a non-empty title, content
 * and category so the row is at least shaped like a memory. Ratifying it
 * holds it to the full shape.
 */
function validateProposal(input:ProposalInput){
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new Error('proposal title is required and cannot be empty');
  }
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    throw new Error('proposal content is required and cannot be empty');
  }
  if (typeof input.category !== 'string' || input.category.trim() === '') {
    throw new Error('proposal category is required and cannot be empty');
  }

}
function writeProposal(db:Database,input:ProposalInput):ProposalRef {
    const uuid = randomUUID();
    const created = new Date().toISOString();
    const result = retryWrite(() =>
      db
        .prepare(`
          INSERT INTO proposals (
            uuid, category, title, content, project, ttl, metadata, source, created, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `)
        .run(
          uuid,
          input.category,
          input.title,
          input.content,
          input.project ?? null,
          input.ttl ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.source ?? null,
          created,
        ),
    );
    return { id: Number(result.lastInsertRowid), uuid };
}
/** A command supplies its independently owned source transaction; no file is opened. */
export function proposeOnConnection(db:Database,input:ProposalInput):ProposalRef {
  if(!db.inTransaction)throw Error('Proposal command needs its source transaction');
  validateProposal(input);return writeProposal(db,input);
}
function proposalInput(proposal:ProposalRow,overrides:ProposalOverrides):MemoryInput {
  return {category:overrides.category??proposal.category??'',title:overrides.title??proposal.title??'',content:overrides.content??proposal.content??'',project:overrides.project??proposal.project??undefined,ttl:overrides.ttl??proposal.ttl??undefined,metadata:parseMetadata(proposal.metadata)};
}
/** Memory effect, draft removal and the caller's receipt share this transaction. */
export async function ratifyOnConnection(db:Database,id:number,overrides:ProposalOverrides,write:(input:MemoryInput)=>Promise<MemoryRef>):Promise<MemoryRef> {
  if(!db.inTransaction)throw Error('Ratification needs its source transaction');
  const proposal=db.prepare("SELECT * FROM proposals WHERE id=? AND status='pending'").get(id) as ProposalRow|undefined;
  if(!proposal)throw new UnknownProposalError(id);
  const ref=await write(proposalInput(proposal,overrides));
  db.prepare("DELETE FROM proposals WHERE id=? AND status='pending'").run(id);
  return ref;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
