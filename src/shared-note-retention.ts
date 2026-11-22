import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { agents } from './core/data/schema.js';
import type { Clock } from './core/clock.js';
import type { DataDatabase } from './core/data/database.js';
import { householdTimezone } from './core/data/household-settings.js';
import { nextTime } from './core/tempo/calendar.js';
import { Notes } from './notes.js';
import type { AgentSource, MindSources } from './pieces/mind/sources.js';

/** Paths only. Note text and the private text citing it stay in their source files. */
function collect(cited: Set<string>, rows: Iterable<unknown[]>) {
  for (const row of rows) for (const field of row) {
    if (typeof field !== 'string') continue;
    for (const match of field.matchAll(/(?:\bnote:|\bnotes\/)[A-Za-z0-9][A-Za-z0-9._/-]*/g)) cited.add(match[0]);
  }
}

/** Prevent another writer from adding a citation between collecting it and applying expiry. */
function snapshot<T>(file: string, dryRun: boolean, read: (source: Database.Database) => T): T {
  const source = new Database(file, { fileMustExist: true, readonly: dryRun, timeout: 0 });
  try {
    const tx = source.transaction(() => read(source));
    return dryRun ? tx.deferred() : tx.immediate();
  } finally { source.close(); }
}

export function sweepAgentNotes(db: DataDatabase, agent: AgentSource, knowledgeFile: string, now: () => number, dryRun: boolean) {
  const cited = new Set<string>();
  const tx = db.$client.transaction(() => {
    collect(cited, db.$client.prepare(`SELECT title, description, goal, why, done_when, ask, if_yes, if_no,
      spec_item, criterion, source_id FROM tasks WHERE status <> 'closed'`).raw().iterate() as Iterable<unknown[]>);
    for (const row of db.$client.prepare(`SELECT source_id FROM tasks WHERE status <> 'closed' AND source_kind='note' AND source_id IS NOT NULL`).iterate() as Iterable<{source_id: string}>) {
      cited.add(row.source_id);
    }
    collect(cited, db.$client.prepare(`SELECT c.text FROM task_comments c JOIN tasks t ON t.id=c.task WHERE t.status <> 'closed'`).raw().iterate() as Iterable<unknown[]>);
    return snapshot(knowledgeFile, dryRun, knowledge => {
      collect(cited, knowledge.prepare(`SELECT title, body, provenance FROM pages WHERE status='active'
        UNION ALL SELECT claim, source_locator, excerpt FROM citations JOIN pages ON pages.id=page_id WHERE pages.status='active'
        UNION ALL SELECT words, evidence, NULL FROM page_annotations JOIN pages ON pages.id=page_id WHERE pages.status='active'
        UNION ALL SELECT reason, evidence, NULL FROM page_supersessions JOIN pages ON pages.id=page_id WHERE pages.status='active'`).raw().iterate() as Iterable<unknown[]>);
      return snapshot(agent.memories, dryRun, memories => {
        collect(cited, memories.prepare('SELECT title, content, metadata, provenance FROM memories WHERE archived=0').raw().iterate() as Iterable<unknown[]>);
        const notes = new Notes(agent.directory, now, { prepared: true, readonly: dryRun });
        try { return notes.sweep(cited, { dryRun }); } finally { notes.close(); }
      });
    });
  });
  return dryRun ? tx.deferred() : tx.immediate();
}

/** The retired note timer ran at 04:41. Keep that hour on the household clock. */
export function nightlyNoteRetention(db: DataDatabase, clock: Clock, sources: MindSources, agentId: string,
  changed: () => void, report: (error: Error) => void) {
  let stopped = false;
  let cancel: (() => void) | undefined;
  const schedule = () => {
    cancel = clock.at(nextTime('04:41', 'daily', clock.now(), householdTimezone(db)), () => {
      try {
        const record = db.select({removed:agents.removedAt}).from(agents).where(eq(agents.id,agentId)).get();
        if (!record || record.removed) return;
        const agent = sources.agents.find(source => source.agent === agentId);
        if (!agent) throw new Error('Note retention agent unavailable');
        if (sweepAgentNotes(db, agent, sources.commons.knowledge, () => clock.now(), false).gone.length) changed();
      } catch { report(new Error('Nightly note retention could not finish')); }
      finally { if (!stopped) schedule(); }
    });
  };
  schedule();
  return () => { stopped = true; cancel?.(); };
}
