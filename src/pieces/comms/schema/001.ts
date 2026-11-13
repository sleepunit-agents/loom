export const schema = [{ number: 1, sql: `
CREATE TABLE comms_threads (
 id TEXT PRIMARY KEY, member TEXT NOT NULL, agent TEXT NOT NULL, project TEXT,
 record TEXT NOT NULL
);
CREATE INDEX comms_threads_member ON comms_threads(member, agent);
CREATE TABLE comms_messages (
 thread TEXT NOT NULL REFERENCES comms_threads(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
 sender TEXT NOT NULL, words BLOB, hash TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(thread,seq), UNIQUE(thread,kind,id)
);
CREATE INDEX comms_messages_at ON comms_messages(at);
CREATE TABLE comms_deleted (id TEXT PRIMARY KEY, member TEXT NOT NULL, agent TEXT NOT NULL, conversation TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE comms_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }, { number: 2, sql: `
CREATE TABLE comms_conversation_steps (
 seq INTEGER PRIMARY KEY, conversation TEXT NOT NULL, at INTEGER NOT NULL,
 words BLOB, record BLOB
);
CREATE INDEX comms_conversation_steps_at ON comms_conversation_steps(at);
CREATE INDEX comms_conversation_steps_page ON comms_conversation_steps(conversation,seq);
` }];
