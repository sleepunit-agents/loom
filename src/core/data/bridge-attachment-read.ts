import { and, asc, eq, sql } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
import { bridgeFileMessages, bridgeFiles } from './schema.js';

/** Read the files linked to an authorized incoming message. Only a download needs the blob in memory. */
export function readBridgeAttachments(db: DataDatabase, input: { incoming: string; file?: string }, maxBytes: number) {
  const bytes = sql<number>`length(${bridgeFiles.contents})`;
  const contents = input.file
    ? sql<Buffer | null>`case when ${bytes} <= ${maxBytes} then ${bridgeFiles.contents} end`
    : sql<null>`null`;
  return db.select({ file: bridgeFiles.file, name: bridgeFiles.name, fetchedAt: bridgeFiles.fetchedAt, bytes, contents })
    .from(bridgeFiles)
    .innerJoin(bridgeFileMessages, and(eq(bridgeFileMessages.connection, bridgeFiles.connection), eq(bridgeFileMessages.file, bridgeFiles.file)))
    .where(and(eq(bridgeFileMessages.incoming, input.incoming), input.file ? eq(bridgeFiles.file, input.file) : undefined))
    .orderBy(asc(bridgeFiles.file)).all();
}
