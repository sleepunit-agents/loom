import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mayAct, maySee, type Db, type Live, type LiveRecord, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { operation } from './commands.js';
import type { Ask } from './role.js';
interface ReadMark { id: string; ask: string; member: string; readAt: number }
const markId = (member: string, ask: string) => `read-${createHash('sha256').update(JSON.stringify([member, ask])).digest('hex')}`;
export function installMemberState(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  const ask = (id: string): Ask | undefined => {
    const row = db.prepare('SELECT record FROM attention_asks WHERE id=?').get(id) as { record: string } | undefined;
    return row && JSON.parse(row.record) as Ask;
  };
  const memberCanRead = (viewer: Viewer, id: string) => {
    const record = ask(id), access = sharing();
    return !!record && viewer.kind === 'member' && mayAct(viewer, { member: viewer.id, type: 'attention.readMark' }, access)
      && maySee(viewer, { type: 'attention.ask', ...record }, access);
  };
  operations.register(operation({ name: 'attention.markRead', write: true,
    input: z.object({ id: z.string().min(1).max(200) }).strict(), output: z.unknown(),
    may: (viewer, input) => memberCanRead(viewer, input.id),
    run(ctx, input) {
      const id = markId(ctx.viewer.id, input.id);
      const old = db.prepare('SELECT record FROM attention_read_marks WHERE id=?').get(id) as { record: string } | undefined;
      if (old) return JSON.parse(old.record) as ReadMark;
      const record: ReadMark = { id, ask: input.id, member: ctx.viewer.id, readAt: ctx.now };
      db.prepare('INSERT INTO attention_read_marks VALUES (?,?,?)').run(id, input.id, JSON.stringify(record));
      ctx.changed('attention.readMark', id); return record;
    },
  }));
  live.register({ name: 'attention.readMark',
    ids: () => (db.prepare('SELECT id FROM attention_read_marks ORDER BY id').all() as { id: string }[]).map(row => row.id),
    read(id, viewer) {
      const row = db.prepare('SELECT record FROM attention_read_marks WHERE id=?').get(id) as { record: string } | undefined;
      if (!row) return;
      const record = JSON.parse(row.record) as ReadMark;
      if (!maySee(viewer, { type: 'attention.readMark', member: record.member }, sharing()) || !memberCanRead(viewer, record.ask)) return;
      return record as unknown as LiveRecord;
    },
    inScope: (record, parent) => parent === undefined || record.ask === parent,
  });
}
